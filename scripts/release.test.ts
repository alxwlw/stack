import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import {
	checkTag,
	npmRegistry,
	publishAll,
	type Registry,
	type ReleasePackage,
	releasePackages,
	setVersion,
	stripTagPrefix,
	waitVisible,
} from './release.ts';

const REPO_ROOT = join(import.meta.dir, '..');

// Копируем только то, что setVersion читает и пишет — не весь packages/ (там живут
// pnpm-симлинки на node_modules).
function fixtureRoot(): string {
	const root = mkdtempSync(join(tmpdir(), 'stack-ver-'));
	for (const { dir: pkg } of releasePackages(REPO_ROOT)) {
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

test('releasePackages: каталоги с package.json по алфавиту, private — published: false', () => {
	const root = packagesTree(['zeta', 'alpha', 'mid']);
	writeFileSync(
		join(root, 'packages', 'alpha', 'package.json'),
		JSON.stringify({ name: '@x/alpha', version: '1.0.0' }),
	);
	writeFileSync(
		join(root, 'packages', 'mid', 'package.json'),
		JSON.stringify({ name: '@x/mid', version: '2.0.0', private: true }),
	);
	writeFileSync(
		join(root, 'packages', 'zeta', 'package.json'),
		JSON.stringify({ name: '@x/zeta', version: '3.0.0', private: false }),
	);
	expect(releasePackages(root)).toEqual([
		{ dir: 'alpha', name: '@x/alpha', version: '1.0.0', published: true },
		{ dir: 'mid', name: '@x/mid', version: '2.0.0', published: false },
		{ dir: 'zeta', name: '@x/zeta', version: '3.0.0', published: true },
	]);
});

test('releasePackages: пропускает каталог без package.json и файл в packages/', () => {
	const root = packagesTree(['alpha']);
	mkdirSync(join(root, 'packages', 'no-manifest'));
	writeFileSync(join(root, 'packages', 'stray-file'), '');
	expect(releasePackages(root).map((p) => p.dir)).toEqual(['alpha']);
});

const pkg = (dir: string, over: Partial<ReleasePackage> = {}): ReleasePackage => ({
	dir,
	name: `@x/${dir}`,
	version: '1.0.0',
	published: true,
	...over,
});

/** Фейковый реестр: `has` читает множество «имя+версия», `visibleAfter` — сколько опросов пакет «не виден». */
function fakeRegistry(
	opts: { present?: string[]; hasFails?: string; visibleAfter?: Record<string, number> } = {},
) {
	const present = new Set(opts.present ?? []);
	const calls: string[] = [];
	const polls = new Map<string, number>();
	const registry: Registry = {
		has(name, version) {
			calls.push(`has ${name}@${version}`);
			if (name === opts.hasFails) return Promise.reject(new Error(`${name}: реестр ответил 500`));
			const n = (polls.get(name) ?? 0) + 1;
			polls.set(name, n);
			const after = opts.visibleAfter?.[name];
			return Promise.resolve(
				present.has(`${name}@${version}`) || (after !== undefined && n >= after),
			);
		},
		publish(dir) {
			calls.push(`publish ${dir}`);
			return Promise.resolve();
		},
	};
	return { registry, calls };
}

describe('publishAll', () => {
	test('публикует только невыложенные и только published, по порядку', async () => {
		const { registry, calls } = fakeRegistry({ present: ['@x/b@1.0.0'] });
		const res = await publishAll(
			[pkg('a'), pkg('b'), pkg('priv', { published: false }), pkg('c')],
			registry,
		);
		expect(res).toEqual({ published: ['@x/a', '@x/c'], skipped: ['@x/b'] });
		expect(calls).toEqual([
			'has @x/a@1.0.0',
			'publish a',
			'has @x/b@1.0.0',
			'has @x/c@1.0.0',
			'publish c',
		]);
	});

	test('has бросает — publish не зовётся, ошибка с именем пакета', async () => {
		const { registry, calls } = fakeRegistry({ hasFails: '@x/a' });
		await expect(publishAll([pkg('a'), pkg('b')], registry)).rejects.toThrow('@x/a');
		expect(calls).toEqual(['has @x/a@1.0.0']);
	});
});

describe('waitVisible', () => {
	const noSleep = (): Promise<void> => Promise.resolve();

	test('всё видно с первой попытки — один опрос на пакет', async () => {
		const { registry, calls } = fakeRegistry({ present: ['@x/a@1.0.0', '@x/b@1.0.0'] });
		await waitVisible([pkg('a'), pkg('b')], '1.0.0', registry, {
			attempts: 5,
			intervalMs: 1,
			sleep: noSleep,
		});
		expect(calls).toEqual(['has @x/a@1.0.0', 'has @x/b@1.0.0']);
	});

	test('пакет появился на третьей попытке — видимые не опрашиваются повторно', async () => {
		const { registry, calls } = fakeRegistry({
			present: ['@x/a@1.0.0'],
			visibleAfter: { '@x/b': 3 },
		});
		const sleeps: number[] = [];
		await waitVisible([pkg('a'), pkg('b'), pkg('priv', { published: false })], '1.0.0', registry, {
			attempts: 5,
			intervalMs: 7,
			sleep: (ms) => {
				sleeps.push(ms);
				return Promise.resolve();
			},
		});
		expect(calls).toEqual(['has @x/a@1.0.0', 'has @x/b@1.0.0', 'has @x/b@1.0.0', 'has @x/b@1.0.0']);
		expect(sleeps).toEqual([7, 7]);
	});

	test('попытки кончились — ошибка перечисляет невидимые', async () => {
		const { registry, calls } = fakeRegistry({ present: ['@x/a@1.0.0'] });
		const sleeps: number[] = [];
		await expect(
			waitVisible([pkg('a'), pkg('b'), pkg('c')], '1.0.0', registry, {
				attempts: 3,
				intervalMs: 5,
				sleep: (ms) => {
					sleeps.push(ms);
					return Promise.resolve();
				},
			}),
		).rejects.toThrow('за 3 попыток в реестре не появилась версия 1.0.0: @x/b @x/c');
		expect(calls.filter((c) => c === 'has @x/b@1.0.0')).toHaveLength(3);
		// После последней попытки не спим.
		expect(sleeps).toEqual([5, 5]);
	});
});

describe('npmRegistry.has', () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});
	const stub = (res: Response | Error): { urls: string[]; accepts: string[] } => {
		const seen = { urls: [] as string[], accepts: [] as string[] };
		globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
			seen.urls.push(String(input));
			seen.accepts.push(new Headers(init?.headers).get('Accept') ?? '');
			return res instanceof Error ? Promise.reject(res) : Promise.resolve(res);
		}) as typeof fetch;
		return seen;
	};
	const reg = npmRegistry('/nowhere/npm-cli.js', REPO_ROOT);

	test('200 с версией — true, 200 без версии — false, 404 — false, 500 — throw', async () => {
		const doc = JSON.stringify({ versions: { '1.2.3': {} } });
		const seen = stub(new Response(doc, { status: 200 }));
		expect(await reg.has('@alxwlw/stack', '1.2.3')).toBe(true);
		expect(seen.urls).toEqual(['https://registry.npmjs.org/@alxwlw%2fstack']);
		expect(seen.accepts).toEqual([
			'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*',
		]);
		stub(new Response(doc, { status: 200 }));
		expect(await reg.has('@alxwlw/stack', '9.9.9')).toBe(false);
		stub(new Response('{}', { status: 404 }));
		expect(await reg.has('@alxwlw/stack', '1.2.3')).toBe(false);
		stub(new Response('boom', { status: 500 }));
		await expect(reg.has('@alxwlw/stack', '1.2.3')).rejects.toThrow('@alxwlw/stack');
	});

	test('сбой сети — throw с именем пакета', async () => {
		stub(new Error('ECONNRESET'));
		await expect(reg.has('@alxwlw/stack', '1.2.3')).rejects.toThrow('@alxwlw/stack');
	});
});

describe('setVersion', () => {
	test('проставляет одну версию пакетам и каталогу канона', () => {
		const root = fixtureRoot();
		setVersion(root, '1.2.3');
		for (const { dir: pkg } of releasePackages(root)) {
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

	const noNpmEnv = (): Record<string, string | undefined> => {
		const env = { ...process.env };
		delete env.NPM;
		return env;
	};

	test('publish без NPM — код 2', () => {
		const r = Bun.spawnSync(['bun', 'scripts/release.ts', 'publish'], {
			cwd: REPO_ROOT,
			env: noNpmEnv(),
		});
		expect(r.exitCode).toBe(2);
		expect(r.stderr.toString()).toContain('NPM');
	});

	test('publish при расходящихся версиях пакетов — код 1, реестр не трогается', () => {
		const root = packagesTree(['a', 'b']);
		writeFileSync(join(root, 'packages/a/package.json'), '{"name":"@x/a","version":"1.0.0"}');
		writeFileSync(join(root, 'packages/b/package.json'), '{"name":"@x/b","version":"1.0.1"}');
		const r = Bun.spawnSync(['bun', join(REPO_ROOT, 'scripts/release.ts'), 'publish'], {
			cwd: root,
			env: { ...noNpmEnv(), NPM: '/nowhere/npm-cli.js' },
		});
		expect(r.exitCode).toBe(1);
		expect(r.stderr.toString()).toContain('версии пакетов расходятся: a=1.0.0, b=1.0.1');
	});

	test('check-tag с текущей версией — код 0', () => {
		const r = run('check-tag', `v${pkgVersion(REPO_ROOT, 'stack')}`);
		expect(r.exitCode).toBe(0);
	});
});

describe('связность релиза', () => {
	const publish = readFileSync(join(REPO_ROOT, '.github/workflows/publish.yml'), 'utf8');

	test('все пакеты репозитория на одной версии', () => {
		const versions = releasePackages(REPO_ROOT).map((p) => p.version);
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
