// Модуль релиза: форма версии, lockstep-версия пакетов и проверка тега. Импортирует только `node:*`:
// job dispatch воркфлоу rollout идёт с `install: false` (docs/release.md, «Why the rollout job skips install»),
// а rollout.ts тянет отсюда stripTagPrefix.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SEMVER_RE = /^\d+\.\d+\.\d+(-[\w.]+)?$/;

/**
 * `github.event.workflow_run.head_branch` для пуша тега — это ИМЯ ТЕГА (`v1.2.3`), не голая
 * версия. `sync.yml` строит из неё `stack/v${VERSION}` — необрезанный префикс даёт `stack/vv1.2.3`
 * (см. docs/release.md, «VERSION arrives with the tag prefix»). Валидирует результат и падает громко на
 * мусоре, а не молча шлёт его по всем потребителям.
 */
export function stripTagPrefix(tag: string): string {
	const version = tag.startsWith('v') ? tag.slice(1) : tag;
	if (!SEMVER_RE.test(version)) {
		throw new Error(`not a version tag: "${tag}"`);
	}
	return version;
}

export interface ReleasePackage {
	/** Имя каталога в `packages/`. */
	dir: string;
	name: string;
	version: string;
	/** `private !== true`: частные пакеты в реестр не уходят. */
	published: boolean;
}

/** Пакеты `packages/*` с `package.json`, по алфавиту: пакет, добавленный в `packages/`, входит в релиз сам. */
export function releasePackages(root: string): ReleasePackage[] {
	// Файл в packages/ отсеивает сам existsSync: `<файл>/package.json` не существует.
	return readdirSync(join(root, 'packages'))
		.filter((dir) => existsSync(join(root, 'packages', dir, 'package.json')))
		.sort()
		.map((dir) => {
			const data = JSON.parse(
				readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8'),
			) as {
				name?: unknown;
				version?: unknown;
				private?: unknown;
			};
			return {
				dir,
				name: String(data.name),
				version: String(data.version),
				published: data.private !== true,
			};
		});
}

/** Порт реестра: боевой — npm, в тестах — фейк. */
export interface Registry {
	has(name: string, version: string): Promise<boolean>;
	publish(dir: string): Promise<void>;
}

// Abbreviated-документ: те же заголовки, что у шага ожидания в sync.yml.
const ACCEPT = 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*';

export function npmRegistry(npm: string, root: string): Registry {
	return {
		async has(name, version) {
			let res: Response;
			try {
				res = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2f')}`, {
					headers: { Accept: ACCEPT },
				});
			} catch (e) {
				throw new Error(
					`${name}: реестр недоступен: ${e instanceof Error ? e.message : String(e)}`,
				);
			}
			if (res.status === 404) return false;
			if (!res.ok) throw new Error(`${name}: реестр ответил ${res.status}`);
			const doc = (await res.json()) as { versions?: Record<string, unknown> };
			return doc.versions?.[version] !== undefined;
		},
		publish(dir) {
			const r = spawnSync('node', [npm, 'publish', '--provenance', '--access', 'public'], {
				cwd: join(root, 'packages', dir),
				stdio: 'inherit',
			});
			if (r.status !== 0)
				throw new Error(`npm publish ${dir} завершился кодом ${String(r.status)}`);
		},
	};
}

/** Публикует `published`-пакеты по порядку; уже лежащую в реестре версию пропускает (повторный запуск тега). */
export async function publishAll(
	pkgs: ReleasePackage[],
	registry: Registry,
): Promise<{ published: string[]; skipped: string[] }> {
	const published: string[] = [];
	const skipped: string[] = [];
	for (const pkg of pkgs.filter((p) => p.published)) {
		if (await registry.has(pkg.name, pkg.version)) {
			console.log(`${pkg.name}@${pkg.version} is already in the registry — skipping`);
			skipped.push(pkg.name);
			continue;
		}
		await registry.publish(pkg.dir);
		published.push(pkg.name);
	}
	return { published, skipped };
}

/** Ждёт, пока все `published`-пакеты появятся в реестре с версией; видимые повторно не опрашивает. */
export async function waitVisible(
	pkgs: ReleasePackage[],
	version: string,
	registry: Registry,
	opts: { attempts: number; intervalMs: number; sleep?: (ms: number) => Promise<void> },
): Promise<void> {
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	let pending = pkgs.filter((p) => p.published);
	for (let i = 1; i <= opts.attempts; i++) {
		const left: ReleasePackage[] = [];
		for (const pkg of pending) {
			if (await registry.has(pkg.name, version))
				console.log(`${pkg.name}@${version} есть в реестре`);
			else left.push(pkg);
		}
		pending = left;
		if (pending.length === 0) return;
		if (i < opts.attempts) await sleep(opts.intervalMs);
	}
	throw new Error(
		`за ${opts.attempts} попыток в реестре не появилась версия ${version}: ${pending.map((p) => p.name).join(' ')}`,
	);
}

/**
 * Проставляет одну lockstep-версию всем пакетам и её же — записям `@alxwlw/*`
 * в `canon/catalogs.json`. Фикстуры не трогает: в них только семя, каталоги приносит sync в тестах.
 */
export function setVersion(root: string, version: string): void {
	if (!SEMVER_RE.test(version)) {
		throw new Error(`version is not semver: "${version}"`);
	}
	for (const { dir: pkg } of releasePackages(root)) {
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
	const versions = releasePackages(root).map((p) => [p.dir, p.version] as const);
	if (versions.some(([, v]) => v !== expected)) {
		throw new Error(
			`тег ${tag}; версии пакетов: ${versions.map(([d, v]) => `${d}=${v}`).join(', ')}`,
		);
	}
}

/** Общая lockstep-версия опубликуемых пакетов; расхождение или пустой набор — ошибка. */
function lockstepVersion(pkgs: ReleasePackage[]): string {
	const pub = pkgs.filter((p) => p.published);
	const versions = new Set(pub.map((p) => p.version));
	const [version] = versions;
	if (version === undefined || versions.size !== 1) {
		throw new Error(
			`версии пакетов расходятся: ${pub.map((p) => `${p.dir}=${p.version}`).join(', ')}`,
		);
	}
	return version;
}

if (import.meta.main) {
	const [command, arg = ''] = Bun.argv.slice(2);
	const usage = 'usage: bun scripts/release.ts version <X.Y.Z> | check-tag <tag> | publish';
	if (command === 'publish') {
		const npm = process.env.NPM;
		if (npm === undefined || npm === '') {
			console.error(`NPM (абсолютный путь к npm CLI) не задан\n${usage}`);
			process.exit(2);
		}
		try {
			const pkgs = releasePackages(process.cwd());
			const version = lockstepVersion(pkgs);
			const registry = npmRegistry(npm, process.cwd());
			await publishAll(pkgs, registry);
			await waitVisible(pkgs, version, registry, { attempts: 60, intervalMs: 10_000 });
		} catch (e) {
			console.error(e instanceof Error ? e.message : String(e));
			process.exit(1);
		}
		process.exit(0);
	}
	if ((command !== 'version' && command !== 'check-tag') || arg === '') {
		console.error(usage);
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
