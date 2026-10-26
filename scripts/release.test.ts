import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { checkTag, packageDirs, setVersion, stripTagPrefix } from './release.ts';

const REPO_ROOT = join(import.meta.dir, '..');

// Копируем только то, что setVersion читает и пишет — не весь packages/ (там живут
// pnpm-симлинки на node_modules).
function fixtureRoot(): string {
	const root = mkdtempSync(join(tmpdir(), 'stack-ver-'));
	for (const pkg of packageDirs(REPO_ROOT)) {
		mkdirSync(join(root, 'packages', pkg), { recursive: true });
		cpSync(
			join(REPO_ROOT, 'packages', pkg, 'package.json'),
			join(root, 'packages', pkg, 'package.json'),
		);
	}
	mkdirSync(join(root, 'packages', 'stack', 'canon'), { recursive: true });
	cpSync(
		join(REPO_ROOT, 'packages', 'stack', 'canon', 'catalogs.json'),
		join(root, 'packages', 'stack', 'canon', 'catalogs.json'),
	);
	return root;
}

const pkgVersion = (root: string, pkg: string): string =>
	(
		JSON.parse(readFileSync(join(root, 'packages', pkg, 'package.json'), 'utf8')) as {
			version: string;
		}
	).version;

test('stripTagPrefix: срезает префикс v тега перед сравнением с semver', () => {
	expect(stripTagPrefix('v1.2.3')).toBe('1.2.3');
	expect(stripTagPrefix('1.2.3')).toBe('1.2.3');
});

test('stripTagPrefix: плавающий major-тег и мусор — ошибка, а не молчаливая рассылка', () => {
	expect(() => stripTagPrefix('v1')).toThrow();
	expect(() => stripTagPrefix('main')).toThrow();
});

// Ожидание строится из того, что тест сам положил во временное дерево: новый пакет в
// настоящем packages/ не должен красить эти тесты.
function packagesTree(manifests: string[]): string {
	const root = mkdtempSync(join(tmpdir(), 'stack-dirs-'));
	for (const name of manifests) {
		mkdirSync(join(root, 'packages', name), { recursive: true });
		writeFileSync(join(root, 'packages', name, 'package.json'), '{}');
	}
	return root;
}

test('packageDirs: все каталоги packages/ с package.json, по алфавиту', () => {
	const root = packagesTree(['zeta', 'alpha', 'mid']);
	expect(packageDirs(root)).toEqual(['alpha', 'mid', 'zeta']);
});

test('packageDirs: пропускает каталог без package.json и файл в packages/', () => {
	const root = packagesTree(['alpha']);
	mkdirSync(join(root, 'packages', 'no-manifest'));
	writeFileSync(join(root, 'packages', 'stray-file'), '');
	expect(packageDirs(root)).toEqual(['alpha']);
});

describe('setVersion', () => {
	test('проставляет одну версию пакетам и каталогу канона', () => {
		const root = fixtureRoot();
		setVersion(root, '1.2.3');
		for (const pkg of packageDirs(root)) {
			expect(pkgVersion(root, pkg)).toBe('1.2.3');
		}
		const catalogs = JSON.parse(
			readFileSync(join(root, 'packages/stack/canon/catalogs.json'), 'utf8'),
		) as Record<string, Record<string, string>>;
		expect(catalogs.dev?.['@alxwlw/stack']).toBe('1.2.3');
		expect(catalogs.dev?.['@alxwlw/oxlint-config']).toBe('1.2.3');
		expect(catalogs.dev?.['@alxwlw/tsconfig']).toBe('1.2.3');
	});

	test('не трогает записи каталога, чужие @alxwlw/*', () => {
		const root = fixtureRoot();
		setVersion(root, '1.2.3');
		const catalogs = JSON.parse(
			readFileSync(join(root, 'packages/stack/canon/catalogs.json'), 'utf8'),
		) as Record<string, Record<string, string>>;
		// libs-каталог не несёт @alxwlw/* записей вообще — контроль, что цикл по группам не путает их.
		expect(catalogs.libs?.['@alxwlw/stack']).toBeUndefined();
		expect(catalogs.dev?.oxlint).not.toBe('1.2.3');
	});

	test('отвергает версию не по semver, не трогая файлы', () => {
		const root = fixtureRoot();
		const before = readFileSync(join(root, 'packages/stack/package.json'), 'utf8');
		expect(() => setVersion(root, 'v1.2')).toThrow();
		expect(readFileSync(join(root, 'packages/stack/package.json'), 'utf8')).toBe(before);
	});
});

describe('checkTag', () => {
	test('версии совпали с тегом — не бросает', () => {
		const root = fixtureRoot();
		setVersion(root, '1.8.0');
		expect(() => checkTag(root, 'v1.8.0')).not.toThrow();
	});

	test('отставший пакет — ошибка с его именем и версиями всех пакетов', () => {
		const root = fixtureRoot();
		setVersion(root, '1.8.0');
		const path = join(root, 'packages/tsconfig/package.json');
		const data = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
		data.version = '1.7.0';
		writeFileSync(path, JSON.stringify(data));
		expect(() => checkTag(root, 'v1.8.0')).toThrow(
			'тег v1.8.0; версии пакетов: oxlint-config=1.8.0, repo-rules=1.8.0, stack=1.8.0, tsconfig=1.7.0',
		);
	});

	test('prerelease совпал с тегом — не бросает', () => {
		const root = fixtureRoot();
		setVersion(root, '1.8.0-rc.1');
		expect(() => checkTag(root, 'v1.8.0-rc.1')).not.toThrow();
	});

	test('плавающий тег v1 — ошибка', () => {
		const root = fixtureRoot();
		expect(() => checkTag(root, 'v1')).toThrow('not a version tag: "v1"');
	});
});

describe('CLI', () => {
	const run = (...args: string[]) =>
		Bun.spawnSync(['bun', 'scripts/release.ts', ...args], { cwd: REPO_ROOT });

	test('подкоманда без аргумента и неизвестная подкоманда — код 2', () => {
		expect(run('version').exitCode).toBe(2);
		expect(run('check-tag').exitCode).toBe(2);
		expect(run('bump', '1.2.3').exitCode).toBe(2);
	});

	test('version не по semver — код 1 и сообщение', () => {
		const r = run('version', 'v1.2');
		expect(r.exitCode).toBe(1);
		expect(r.stderr.toString()).toContain('version is not semver: "v1.2"');
	});

	test('version пишет в дерево из cwd, а не в репозиторий', () => {
		const root = fixtureRoot();
		const r = Bun.spawnSync(['bun', join(REPO_ROOT, 'scripts/release.ts'), 'version', '3.4.5'], {
			cwd: root,
		});
		expect(r.exitCode).toBe(0);
		expect(pkgVersion(root, 'tsconfig')).toBe('3.4.5');
		expect(pkgVersion(REPO_ROOT, 'tsconfig')).not.toBe('3.4.5');
	});

	test('без аргументов — usage и код 2', () => {
		const r = run();
		expect(r.exitCode).toBe(2);
		expect(r.stderr.toString()).toContain('usage:');
	});

	test('check-tag с чужим тегом — код 1 и сообщение о версиях', () => {
		const r = run('check-tag', 'v0.0.0-nope');
		expect(r.exitCode).toBe(1);
		expect(r.stderr.toString()).toContain('тег v0.0.0-nope; версии пакетов: ');
	});

	test('check-tag с текущей версией — код 0', () => {
		const r = run('check-tag', `v${pkgVersion(REPO_ROOT, 'stack')}`);
		expect(r.exitCode).toBe(0);
	});
});

describe('связность релиза', () => {
	const publish = readFileSync(join(REPO_ROOT, '.github/workflows/publish.yml'), 'utf8');

	test('publish.yml публикует каждый пакет из packageDirs', () => {
		const loop = /for p in ([\w -]+); do/.exec(publish)?.[1]?.trim().split(/\s+/).sort();
		expect(loop).toEqual(packageDirs(REPO_ROOT));
	});

	test('все пакеты репозитория на одной версии', () => {
		const versions = packageDirs(REPO_ROOT).map((p) => pkgVersion(REPO_ROOT, p));
		expect(new Set(versions).size).toBe(1);
	});

	test('job selftest в publish.yml проверяет тег через release.ts', () => {
		const selftest = /\n {2}selftest:\n([\s\S]*?)\n {2}publish:/.exec(publish)?.[1] ?? '';
		expect(selftest).toContain('run: bun scripts/release.ts check-tag "$GITHUB_REF_NAME"');
	});
});

// Job dispatch воркфлоу rollout идёт с install: false (docs/release.md, «Why the rollout job skips install»).
test('rollout.ts тянет только node:* и release.ts, release.ts — только node:*', () => {
	const imports = (f: string): string[] =>
		new Bun.Transpiler({ loader: 'ts' })
			.scanImports(readFileSync(join(import.meta.dir, f), 'utf8'))
			.map((i) => i.path);
	expect(
		imports('rollout.ts').filter((p) => !p.startsWith('node:') && p !== './release.ts'),
	).toEqual([]);
	expect(imports('release.ts').filter((p) => !p.startsWith('node:'))).toEqual([]);
});
