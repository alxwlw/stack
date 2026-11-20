import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { parsePins } from './canon.ts';
import { readGuardrails } from './guardrails.ts';
import { mergeBase, mergeBaseArgv, type PrBase, prBase } from './guardrails-commits.ts';
import { gitleaksDirArgv, gitleaksGitArgv } from './guardrails-gitleaks.ts';
import { type GuardrailRun, type GuardrailsPort, spawnRunner } from './guardrails-port.ts';
import { checkGuardrails, guardrailsNotes } from './guardrails-rule.ts';
import {
	canonFile,
	git,
	gitRepo,
	isolateGitConfig,
	protoBin,
	put,
	repoDir,
	ROOT,
} from './testkit.ts';

// 64 hex собираются во время выполнения, поэтому eth-правило канона не видит их в исходнике; в имени
// нет слов key, secret, token, которые ищет generic-api-key из правил по умолчанию.
const HEX = '0123456789abcdef'.repeat(4);
const LINE = `ETH_PRIV=0x${HEX}\n`;
const RULE = 'eth-private-key-no-prefix';
const DESCRIPTION = 'Ethereum private key (32 bytes hex, with or without 0x prefix)';
const SHA = 'ab'.repeat(20);
const SHA64 = 'cd'.repeat(32);

const ROOT_PINS = parsePins(readFileSync(join(ROOT, '.prototools'), 'utf8'));
const PIN = ROOT_PINS.gitleaks ?? '';
const PROTOTOOLS = `gitleaks = "${PIN}"\n`;
const NO_FILES = { skipped: 'no files' } as const;
const PR_ENV = {
	GITHUB_ACTIONS: 'true',
	GITHUB_EVENT_NAME: 'pull_request',
	GITHUB_BASE_REF: 'main',
};

describe('prBase', () => {
	const rows: [string, string | undefined, NodeJS.ProcessEnv, PrBase][] = [
		['явный --base', 'origin/dev', {}, { base: 'origin/dev' }],
		[
			'явный --base при push в Actions',
			'main',
			{ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push' },
			{ base: 'main' },
		],
		[
			'push в Actions',
			undefined,
			{ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push' },
			{ skipped: 'not a pull request' },
		],
		[
			'Actions без события',
			undefined,
			{ GITHUB_ACTIONS: 'true' },
			{ skipped: 'not a pull request' },
		],
		['pull_request', undefined, PR_ENV, { base: 'origin/main' }],
		['пустой --base в PR-окружении', '', PR_ENV, { base: 'origin/main' }],
		[
			'pull_request_target',
			undefined,
			{ ...PR_ENV, GITHUB_EVENT_NAME: 'pull_request_target', GITHUB_BASE_REF: 'dev' },
			{ base: 'origin/dev' },
		],
		[
			'PR без GITHUB_BASE_REF',
			undefined,
			{ ...PR_ENV, GITHUB_BASE_REF: '' },
			{ unavailable: 'GITHUB_BASE_REF is empty in a pull_request job' },
		],
		[
			'PR без переменной базы',
			undefined,
			{ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request' },
			{ unavailable: 'GITHUB_BASE_REF is empty in a pull_request job' },
		],
		['вне Actions без --base', undefined, {}, { skipped: 'no --base outside GitHub Actions' }],
		[
			'GITHUB_ACTIONS не true',
			undefined,
			{ GITHUB_ACTIONS: '1', GITHUB_EVENT_NAME: 'pull_request' },
			{ skipped: 'no --base outside GitHub Actions' },
		],
	];
	test.each(rows)('%s', (_name, base, env, expected) => {
		expect(prBase(base, env)).toStrictEqual(expected);
	});
});

describe('mergeBase', () => {
	const run = (over: Partial<GuardrailRun>): GuardrailRun => ({
		code: 0,
		out: '',
		err: '',
		...over,
	});
	test('аргументы', () => {
		expect(mergeBaseArgv('origin/main')).toStrictEqual(['merge-base', 'origin/main', 'HEAD']);
	});
	test('sha1 и sha256 из stdout', () => {
		expect(mergeBase(run({ out: `${SHA}\n` }), 'origin/main')).toBe(SHA);
		expect(mergeBase(run({ out: `${SHA64}\n` }), 'origin/main')).toBe(SHA64);
	});
	test('код 1 без stderr — exited with 1', () => {
		expect(mergeBase(run({ code: 1 }), 'origin/main')).toStrictEqual({
			unavailable: 'git merge-base origin/main HEAD: exited with 1',
		});
	});
	test('код 128 — первая строка stderr', () => {
		expect(
			mergeBase(
				run({ code: 128, err: 'fatal: Not a valid object name origin/gone\n' }),
				'origin/gone',
			),
		).toStrictEqual({
			unavailable: 'git merge-base origin/gone HEAD: fatal: Not a valid object name origin/gone',
		});
	});
	test('не sha в stdout', () => {
		for (const out of ['x\n', '', `${SHA}0\n`, `${SHA.toUpperCase()}\n`]) {
			expect(mergeBase(run({ out }), 'origin/main')).toStrictEqual({
				unavailable: 'git merge-base origin/main HEAD printed no commit',
			});
		}
	});
});

describe('находки и пометки по commits', () => {
	const tool = { version: PIN, files: 1, violations: [] };
	const tools = { actionlint: NO_FILES, shellcheck: NO_FILES, gitleaks: tool };
	const gl = (path: string, line: number, message: string) => ({
		tool: 'gitleaks' as const,
		rule: RULE,
		path,
		line,
		message,
	});

	test('нарушения после находок инструментов, порядок путь, строка', () => {
		const outcome = {
			tools: { ...tools, gitleaks: { ...tool, violations: [gl('z.ts', 1, 'in tree')] } },
			commits: {
				range: 'abcdefabcdef..HEAD',
				violations: [
					gl('b.ts', 2, `${DESCRIPTION} (commit 111111111111)`),
					gl('a.ts', 9, 'x'),
					gl('b.ts', 1, 'y'),
				],
			},
		};
		expect(checkGuardrails(outcome)).toStrictEqual([
			{ code: 'guardrails-violation', target: 'z.ts:1', message: `gitleaks ${RULE}: in tree` },
			{ code: 'guardrails-violation', target: 'a.ts:9', message: `gitleaks ${RULE}: x` },
			{ code: 'guardrails-violation', target: 'b.ts:1', message: `gitleaks ${RULE}: y` },
			{
				code: 'guardrails-violation',
				target: 'b.ts:2',
				message: `gitleaks ${RULE}: ${DESCRIPTION} (commit 111111111111)`,
			},
		]);
		expect(guardrailsNotes(outcome).at(-1)).toBe(
			'guardrails gitleaks commits abcdefabcdef..HEAD: 3 finding(s)',
		);
	});

	test('commits недоступны — одна находка guardrails-unavailable и пометка', () => {
		const outcome = { tools, commits: { unavailable: 'ERR boom' } };
		expect(checkGuardrails(outcome)).toStrictEqual([
			{ code: 'guardrails-unavailable', target: 'gitleaks commits', message: 'ERR boom' },
		]);
		expect(guardrailsNotes(outcome).at(-1)).toBe('guardrails gitleaks commits: unavailable');
	});

	test('commits пропущены — без находок, пометка с причиной', () => {
		const outcome = { tools, commits: { skipped: 'not a pull request' } };
		expect(checkGuardrails(outcome)).toStrictEqual([]);
		expect(guardrailsNotes(outcome)).toStrictEqual([
			'guardrails actionlint: skipped (no files)',
			'guardrails shellcheck: skipped (no files)',
			`guardrails gitleaks ${PIN}: 1 file(s), 0 finding(s)`,
			'guardrails gitleaks commits: skipped (not a pull request)',
		]);
	});

	test('нулевое число находок в диапазоне — пометка с range', () => {
		const outcome = { tools, commits: { range: 'abcdefabcdef..HEAD', violations: [] } };
		expect(checkGuardrails(outcome)).toStrictEqual([]);
		expect(guardrailsNotes(outcome).at(-1)).toBe(
			'guardrails gitleaks commits abcdefabcdef..HEAD: 0 finding(s)',
		);
	});
});

type Row = GuardrailRun | ((cwd: string | undefined) => GuardrailRun);

describe('читатель с портом-таблицей', () => {
	const dirs: string[] = [];
	afterAll(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
	});
	const repo = (files: Record<string, string>): string => {
		const dir = repoDir(files);
		dirs.push(dir);
		return dir;
	};

	// Порт-фальшивка: вызовы вне таблицы бросают; записаны команда, аргументы и cwd.
	function fakePort(table: Record<string, Row>, env: NodeJS.ProcessEnv = {}, base?: string) {
		const calls: [string, string[], string | undefined][] = [];
		const port: GuardrailsPort = {
			env: { GITLEAKS_BIN: '/x/gl', ...env },
			base,
			run: (cmd, argv, cwd) => {
				calls.push([cmd, argv, cwd]);
				const hit = table[[cmd, ...argv].join(' ')];
				if (hit === undefined) throw new Error(`unexpected call: ${cmd} ${argv.join(' ')}`);
				return typeof hit === 'function' ? hit(cwd) : hit;
			},
		};
		return { port, calls };
	}
	const ok = (out: string): GuardrailRun => ({ code: 0, out, err: '' });
	const tracked = (...paths: string[]): GuardrailRun => ok(paths.map((p) => `${p}\0`).join(''));
	const GIT = 'git ls-files -z';
	const VERSION = '/x/gl version';
	const DIR = `/x/gl ${gitleaksDirArgv().join(' ')}`;
	const MB = 'git merge-base origin/main HEAD';
	const leak = JSON.stringify([
		{
			RuleID: RULE,
			Description: DESCRIPTION,
			StartLine: 3,
			File: 'leak.ts',
			Commit: 'f'.repeat(40),
			Secret: 'REDACTED',
			Match: 'REDACTED',
		},
	]);

	test.each([
		['конфиг в наборе', ['README.md', '.gitleaks.toml'], true],
		['конфига нет', ['README.md'], false],
	])('PR: gitleaks git в каталоге копии, как dir — %s', (_name, paths, withConfig) => {
		const root = repo(Object.fromEntries(paths.map((p) => [p, 'x\n'])));
		const range = `${SHA}..HEAD`;
		const GIT_RUN = `/x/gl ${gitleaksGitArgv(root, range, withConfig).join(' ')}`;
		const f = fakePort(
			{
				[GIT]: tracked(...paths),
				[VERSION]: ok(`${PIN}\n`),
				[DIR]: ok('[]'),
				[MB]: ok(`${SHA}\n`),
				[GIT_RUN]: { code: 3, out: leak, err: '' },
			},
			PR_ENV,
		);
		const out = readGuardrails(root, PROTOTOOLS, f.port);
		expect('tools' in out && out.commits).toStrictEqual({
			range: `${SHA.slice(0, 12)}..HEAD`,
			violations: [
				{
					tool: 'gitleaks',
					rule: RULE,
					path: 'leak.ts',
					line: 3,
					message: `${DESCRIPTION} (commit ${'f'.repeat(12)})`,
				},
			],
		});
		expect(f.calls.map(([cmd, argv]) => [cmd, argv[0]])).toStrictEqual([
			['git', 'ls-files'],
			['/x/gl', 'version'],
			['/x/gl', 'dir'],
			['git', 'merge-base'],
			['/x/gl', 'git'],
		]);
		// merge-base идёт в корне репозитория, оба запуска gitleaks — в одной и той же копии.
		const [, , dirCall, mbCall, gitCall] = f.calls;
		expect(mbCall?.[2]).toBe(root);
		expect(dirCall?.[2]).toStartWith(join(tmpdir(), 'stack-gitleaks-'));
		expect(gitCall?.[2]).toBe(dirCall?.[2]);
		expect(gitCall?.[2]).not.toBe(root);
		expect(f.calls[4]?.[1].includes('--config')).toBe(withConfig);
		expect(existsSync(gitCall?.[2] ?? root)).toBe(false);
	});

	test('--base при push: merge-base от него, копия одна и удаляется после обоих запусков', () => {
		const root = repo({ 'README.md': 'x\n' });
		const seen: string[] = [];
		const GIT_RUN = `/x/gl ${gitleaksGitArgv(root, `${SHA}..HEAD`, false).join(' ')}`;
		const f = fakePort(
			{
				[GIT]: tracked('README.md'),
				[VERSION]: ok(`${PIN}\n`),
				[DIR]: (cwd) => {
					seen.push(cwd ?? '');
					return ok('[]');
				},
				'git merge-base origin/dev HEAD': ok(`${SHA}\n`),
				[GIT_RUN]: (cwd) => {
					seen.push(cwd ?? '');
					// Копия ещё жива, пока идёт второй запуск.
					expect(existsSync(join(cwd ?? root, 'README.md'))).toBe(true);
					return ok('[]');
				},
			},
			{ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push' },
			'origin/dev',
		);
		const out = readGuardrails(root, PROTOTOOLS, f.port);
		expect('tools' in out && out.commits).toStrictEqual({
			range: `${SHA.slice(0, 12)}..HEAD`,
			violations: [],
		});
		expect(seen).toHaveLength(2);
		expect(seen[1]).toBe(seen[0]);
		expect(existsSync(seen[0] ?? root)).toBe(false);
	});

	test('часть gitleaks недоступна — commits skipped, merge-base не зовётся', () => {
		const root = repo({ 'README.md': 'x\n' });
		const f = fakePort(
			{
				[GIT]: tracked('README.md'),
				[VERSION]: ok(`${PIN}\n`),
				[DIR]: { code: 1, out: '', err: '12:00AM FTL unable to load gitleaks config\n' },
			},
			PR_ENV,
		);
		const out = readGuardrails(root, PROTOTOOLS, f.port);
		expect(out).toStrictEqual({
			tools: {
				actionlint: NO_FILES,
				shellcheck: NO_FILES,
				gitleaks: { unavailable: 'FTL unable to load gitleaks config' },
			},
			commits: { skipped: 'gitleaks unavailable' },
		});
		expect(f.calls.some(([cmd, argv]) => cmd === 'git' && argv[0] === 'merge-base')).toBe(false);
	});

	test('нет бинарника gitleaks — commits skipped, merge-base не зовётся', () => {
		const root = repo({ 'README.md': 'x\n' });
		const f = fakePort({ [GIT]: tracked('README.md') }, PR_ENV);
		const out = readGuardrails(root, '', f.port);
		expect('tools' in out && out.commits).toStrictEqual({ skipped: 'gitleaks unavailable' });
		expect(f.calls.map(([cmd]) => cmd)).toStrictEqual(['git']);
	});

	test('сбой копии (TMPDIR) — commits skipped, merge-base не зовётся', () => {
		const root = repo({ 'README.md': 'x\n' });
		const f = fakePort({ [GIT]: tracked('README.md'), [VERSION]: ok(`${PIN}\n`) }, PR_ENV);
		const saved = process.env.TMPDIR;
		process.env.TMPDIR = '/nonexistent';
		try {
			const out = readGuardrails(root, PROTOTOOLS, f.port);
			expect('tools' in out && out.commits).toStrictEqual({ skipped: 'gitleaks unavailable' });
		} finally {
			if (saved === undefined) Reflect.deleteProperty(process.env, 'TMPDIR');
			else process.env.TMPDIR = saved;
		}
		expect(f.calls.map(([cmd, argv]) => [cmd, argv[0]])).toStrictEqual([
			['git', 'ls-files'],
			['/x/gl', 'version'],
		]);
	});

	test('merge-base упал — commits недоступны с причиной, gitleaks git не зовётся', () => {
		const root = repo({ 'README.md': 'x\n' });
		const f = fakePort(
			{
				[GIT]: tracked('README.md'),
				[VERSION]: ok(`${PIN}\n`),
				[DIR]: ok('[]'),
				[MB]: { code: 128, out: '', err: 'fatal: Not a valid object name origin/main\n' },
			},
			PR_ENV,
		);
		const out = readGuardrails(root, PROTOTOOLS, f.port);
		expect('tools' in out && out.commits).toStrictEqual({
			unavailable: 'git merge-base origin/main HEAD: fatal: Not a valid object name origin/main',
		});
		expect(f.calls).toHaveLength(4);
	});

	test('gitleaks git: ERR в stderr — commits недоступны, часть файлов цела', () => {
		const root = repo({ 'README.md': 'x\n' });
		const GIT_RUN = `/x/gl ${gitleaksGitArgv(root, `${SHA}..HEAD`, false).join(' ')}`;
		const f = fakePort(
			{
				[GIT]: tracked('README.md'),
				[VERSION]: ok(`${PIN}\n`),
				[DIR]: ok('[]'),
				[MB]: ok(`${SHA}\n`),
				[GIT_RUN]: { code: 0, out: '[]', err: '12:00AM ERR [git] fatal: boom\n' },
			},
			PR_ENV,
		);
		const out = readGuardrails(root, PROTOTOOLS, f.port);
		expect('tools' in out && out.commits).toStrictEqual({ unavailable: 'ERR [git] fatal: boom' });
		expect('tools' in out && out.tools.gitleaks).toStrictEqual({
			version: PIN,
			files: 1,
			violations: [],
		});
	});

	test('нет файлов — commits skipped no files, пины не читаются', () => {
		const root = repo({});
		const f = fakePort({ [GIT]: ok('') }, PR_ENV);
		expect(readGuardrails(root, undefined, f.port)).toStrictEqual({
			tools: { actionlint: NO_FILES, shellcheck: NO_FILES, gitleaks: NO_FILES },
			commits: NO_FILES,
		});
		expect(f.calls).toHaveLength(1);
	});

	test('вне PR и без --base — skipped, второго запуска нет', () => {
		const root = repo({ 'README.md': 'x\n' });
		const table = { [GIT]: tracked('README.md'), [VERSION]: ok(`${PIN}\n`), [DIR]: ok('[]') };
		const outside = fakePort(table);
		const a = readGuardrails(root, PROTOTOOLS, outside.port);
		expect('tools' in a && a.commits).toStrictEqual({
			skipped: 'no --base outside GitHub Actions',
		});
		expect(outside.calls).toHaveLength(3);
		const push = fakePort(table, { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push' });
		const b = readGuardrails(root, PROTOTOOLS, push.port);
		expect('tools' in b && b.commits).toStrictEqual({ skipped: 'not a pull request' });
		expect(push.calls).toHaveLength(3);
	});

	test('PR без GITHUB_BASE_REF — commits недоступны', () => {
		const root = repo({ 'README.md': 'x\n' });
		const f = fakePort(
			{ [GIT]: tracked('README.md'), [VERSION]: ok(`${PIN}\n`), [DIR]: ok('[]') },
			{ ...PR_ENV, GITHUB_BASE_REF: '' },
		);
		const out = readGuardrails(root, PROTOTOOLS, f.port);
		expect('tools' in out && out.commits).toStrictEqual({
			unavailable: 'GITHUB_BASE_REF is empty in a pull_request job',
		});
	});
});

describe('настоящий gitleaks: коммиты PR', () => {
	const TIMEOUT = 30_000;
	let bin = '';
	let restore = (): void => {};
	const dirs: string[] = [];
	beforeAll(() => {
		bin = protoBin('gitleaks');
		restore = isolateGitConfig();
	});
	afterAll(() => {
		restore();
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
	});

	const prototools = readFileSync(join(ROOT, '.prototools'), 'utf8');

	// main с каноном gitleaks; ветка feature: A добавляет leak.ts с секретом, B удаляет, C меняет README.md.
	function feature(): { dir: string; a: string } {
		const { dir } = gitRepo({
			'.gitleaks.toml': canonFile('.gitleaks.toml'),
			'.gitleaks.canon.toml': canonFile('.gitleaks.canon.toml'),
			'README.md': 'x\n',
		});
		dirs.push(dir);
		git(dir, 'checkout', '-b', 'feature');
		put(dir, 'leak.ts', LINE);
		git(dir, 'add', 'leak.ts');
		git(dir, 'commit', '-m', 'A');
		const a = git(dir, 'rev-parse', 'HEAD').trim();
		git(dir, 'rm', 'leak.ts');
		git(dir, 'commit', '-m', 'B');
		put(dir, 'README.md', 'y\n');
		git(dir, 'add', 'README.md');
		git(dir, 'commit', '-m', 'C');
		return { dir, a };
	}

	function scan(dir: string, env: NodeJS.ProcessEnv, base?: string) {
		const out = readGuardrails(dir, prototools, {
			run: spawnRunner(dir),
			env: {
				...process.env,
				GITHUB_ACTIONS: undefined,
				GITHUB_EVENT_NAME: undefined,
				GITHUB_BASE_REF: undefined,
				...env,
				GITLEAKS_BIN: bin,
			},
			base,
		});
		if ('unavailable' in out) throw new Error(out.unavailable);
		return out;
	}

	test(
		'--base: секрет добавлен в A и удалён в B — одно нарушение с коммитом A, файлы чисты, значения нет',
		() => {
			const { dir, a } = feature();
			const out = scan(dir, {}, 'main');
			expect(out.commits).toStrictEqual({
				range: `${git(dir, 'rev-parse', 'main').trim().slice(0, 12)}..HEAD`,
				violations: [
					{
						tool: 'gitleaks',
						rule: RULE,
						path: 'leak.ts',
						line: 1,
						message: `${DESCRIPTION} (commit ${a.slice(0, 12)})`,
					},
				],
			});
			expect(out.tools.gitleaks).toStrictEqual({ version: PIN, files: 3, violations: [] });
			expect(JSON.stringify(out)).not.toContain(HEX);
			expect(JSON.stringify(out)).not.toContain(HEX.slice(0, 16));
		},
		TIMEOUT,
	);

	test(
		'PR-окружение: origin/main есть — то же нарушение; GITHUB_BASE_REF=gone — недоступно',
		() => {
			const { dir, a } = feature();
			const found = scan(dir, PR_ENV);
			expect(
				'violations' in found.commits && found.commits.violations.map((v) => v.message),
			).toStrictEqual([`${DESCRIPTION} (commit ${a.slice(0, 12)})`]);
			const gone = scan(dir, { ...PR_ENV, GITHUB_BASE_REF: 'gone' });
			expect('unavailable' in gone.commits && gone.commits.unavailable).toStartWith(
				'git merge-base origin/gone HEAD: ',
			);
		},
		TIMEOUT,
	);

	test(
		'push в Actions и вне Actions — skipped с причиной',
		() => {
			const { dir } = feature();
			expect(
				scan(dir, { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push' }).commits,
			).toStrictEqual({
				skipped: 'not a pull request',
			});
			expect(scan(dir, {}).commits).toStrictEqual({
				skipped: 'no --base outside GitHub Actions',
			});
		},
		TIMEOUT,
	);

	test(
		'GIT_TRACE=1: трассировка git в stderr — commits недоступны с ERR, не ноль нарушений',
		() => {
			const { dir } = feature();
			const saved = process.env.GIT_TRACE;
			process.env.GIT_TRACE = '1';
			try {
				// Переменная должна дойти до дочернего процесса: окружение снимает spawnRunner при создании.
				const out = scan(dir, {}, 'main');
				expect('unavailable' in out.commits && out.commits.unavailable).toStartWith('ERR ');
			} finally {
				if (saved === undefined) Reflect.deleteProperty(process.env, 'GIT_TRACE');
				else process.env.GIT_TRACE = saved;
			}
		},
		TIMEOUT,
	);

	test(
		'--base HEAD: пустой диапазон — range без нарушений',
		() => {
			const { dir } = feature();
			const head = git(dir, 'rev-parse', 'HEAD').trim();
			expect(scan(dir, {}, 'HEAD').commits).toStrictEqual({
				range: `${head.slice(0, 12)}..HEAD`,
				violations: [],
			});
		},
		TIMEOUT,
	);
});
