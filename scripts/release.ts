// Модуль релиза: форма версии, lockstep-версия пакетов и проверка тега. Импортирует только `node:*`:
// job rollout идёт с `install: false` (docs/release.md, «Why the rollout job skips install»),
// а rollout.ts тянет отсюда stripTagPrefix.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SEMVER_RE = /^\d+\.\d+\.\d+(-[\w.]+)?$/;

/**
 * `github.event.workflow_run.head_branch` для пуша тега — это ИМЯ ТЕГА (`v1.2.3`), не голая
 * версия. `sync.yml` строит из неё `stack/v${VERSION}` — необрезанный префикс даёт `stack/vv1.2.3`
 * (см. docs/release.md, «VERSION приходит с префиксом»). Валидирует результат и падает громко на
 * мусоре, а не молча шлёт его по всем потребителям.
 */
export function stripTagPrefix(tag: string): string {
	const version = tag.startsWith('v') ? tag.slice(1) : tag;
	if (!SEMVER_RE.test(version)) {
		throw new Error(`not a version tag: "${tag}"`);
	}
	return version;
}

/** Каталоги `packages/*` с `package.json`, отсортированные: пакет, добавленный в `packages/`, входит в релиз сам. */
export function packageDirs(root: string): string[] {
	return readdirSync(join(root, 'packages'), { withFileTypes: true })
		.filter((e) => e.isDirectory() && existsSync(join(root, 'packages', e.name, 'package.json')))
		.map((e) => e.name)
		.sort();
}

function readVersion(root: string, dir: string): string {
	const data = JSON.parse(readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8')) as {
		version?: unknown;
	};
	return String(data.version);
}

/**
 * Проставляет одну lockstep-версию всем пакетам и её же — записям `@alxwlw/*`
 * в `canon/catalogs.json`. Фикстуры не трогает: в них только семя, каталоги приносит sync в тестах.
 */
export function setVersion(root: string, version: string): void {
	if (!SEMVER_RE.test(version)) {
		throw new Error(`version is not semver: "${version}"`);
	}
	for (const pkg of packageDirs(root)) {
		const path = join(root, 'packages', pkg, 'package.json');
		const data = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
		data.version = version;
		writeFileSync(path, `${JSON.stringify(data, null, '\t')}\n`);
	}
	const catalogsPath = join(root, 'packages', 'stack', 'canon', 'catalogs.json');
	const catalogs = JSON.parse(readFileSync(catalogsPath, 'utf8')) as Record<
		string,
		Record<string, string>
	>;
	for (const entries of Object.values(catalogs)) {
		for (const name of Object.keys(entries)) {
			if (name.startsWith('@alxwlw/')) entries[name] = version;
		}
	}
	writeFileSync(catalogsPath, `${JSON.stringify(catalogs, null, '\t')}\n`);
}

/** Падает, если версия хоть одного пакета не равна версии тега. */
export function checkTag(root: string, tag: string): void {
	const expected = stripTagPrefix(tag);
	const versions = packageDirs(root).map((dir) => [dir, readVersion(root, dir)] as const);
	if (versions.some(([, v]) => v !== expected)) {
		throw new Error(
			`тег ${tag}; версии пакетов: ${versions.map(([d, v]) => `${d}=${v}`).join(', ')}`,
		);
	}
}

if (import.meta.main) {
	const [command, arg = ''] = Bun.argv.slice(2);
	if ((command !== 'version' && command !== 'check-tag') || arg === '') {
		console.error('usage: bun scripts/release.ts version <X.Y.Z> | check-tag <tag>');
		process.exit(2);
	}
	try {
		if (command === 'version') setVersion(process.cwd(), arg);
		else checkTag(process.cwd(), arg);
	} catch (e) {
		console.error(e instanceof Error ? e.message : String(e));
		process.exit(1);
	}
}
