import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { parsePins } from './canon.ts';
import { readGuardrails } from './guardrails.ts';
import { mergeBase, mergeBaseArgv } from './guardrails-commits.ts';
import { gitleaksDirArgv, gitleaksGitArgv } from './guardrails-gitleaks.ts';
import { type GuardrailRun, type GuardrailsPort, spawnRunner } from './guardrails-port.ts';
import { checkGuardrails, guardrailsNotes } from './guardrails-rule.ts';
import type { PrBase } from './pr-base.ts';
import {
	canonFile,
	git,
	gitRepo,
	isolateGitConfig,
	protoBin,
	put,
	repoDir,
	ROOT,
	testEnv,
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
const MAIN: PrBase = { base: 'origin/main' };
const NO_BASE: PrBase = { skipped: 'no --base outside GitHub Actions' };

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
	const tools = {
		actionlint: NO_FILES,
		shellcheck: NO_FILES,
		gitleaks: tool,
		hadolint: NO_FILES,
		'markdownlint-cli2': NO_FILES,
		yamllint: NO_FILES,
	};
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
			'guardrails hadolint: skipped (no files)',
			'guardrails markdownlint-cli2: skipped (no files)',
			'guardrails yamllint: skipped (no files)',
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
	function fakePort(table: Record<string, Row>) {
		const calls: [string, string[], string | undefined][] = [];
		const port: GuardrailsPort = {
			env: { GITLEAKS_BIN: '/x/gl' },
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
		['конфиг в наборе', ['README.txt', '.gitleaks.toml'], true],
		['конфига нет', ['README.txt'], false],
	])('PR: gitleaks git в каталоге копии, как dir — %s', (_name, paths, withConfig) => {
		const root = repo(Object.fromEntries(paths.map((p) => [p, 'x\n'])));
		const range = `${SHA}..HEAD`;
		const GIT_RUN = `/x/gl ${gitleaksGitArgv(root, range, withConfig).join(' ')}`;
		const f = fakePort({
			[GIT]: tracked(...paths),
			[VERSION]: ok(`${PIN}\n`),
			[DIR]: ok('[]'),
			[MB]: ok(`${SHA}\n`),
			[GIT_RUN]: { code: 3, out: leak, err: '' },
		});
		const out = readGuardrails(root, PROTOTOOLS, f.port, MAIN);
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
		const root = repo({ 'README.txt': 'x\n' });
		const seen: string[] = [];
		const GIT_RUN = `/x/gl ${gitleaksGitArgv(root, `${SHA}..HEAD`, false).join(' ')}`;
		const f = fakePort({
			[GIT]: tracked('README.txt'),
			[VERSION]: ok(`${PIN}\n`),
			[DIR]: (cwd) => {
				seen.push(cwd ?? '');
				return ok('[]');
			},
			'git merge-base origin/dev HEAD': ok(`${SHA}\n`),
			[GIT_RUN]: (cwd) => {
				seen.push(cwd ?? '');
				// Копия ещё жива, пока идёт второй запуск.
				expect(existsSync(join(cwd ?? root, 'README.txt'))).toBe(true);
				return ok('[]');
			},
		});
		const out = readGuardrails(root, PROTOTOOLS, f.port, { base: 'origin/dev' });
		expect('tools' in out && out.commits).toStrictEqual({
			range: `${SHA.slice(0, 12)}..HEAD`,
			violations: [],
		});
		expect(seen).toHaveLength(2);
		expect(seen[1]).toBe(seen[0]);
		expect(existsSync(seen[0] ?? root)).toBe(false);
	});

	test('часть gitleaks недоступна — commits skipped, merge-base не зовётся', () => {
		const root = repo({ 'README.txt': 'x\n' });
		const f = fakePort({
			[GIT]: tracked('README.txt'),
			[VERSION]: ok(`${PIN}\n`),
			[DIR]: { code: 1, out: '', err: '12:00AM FTL unable to load gitleaks config\n' },
		});
		const out = readGuardrails(root, PROTOTOOLS, f.port, MAIN);
		expect(out).toStrictEqual({
			tools: {
				actionlint: NO_FILES,
				shellcheck: NO_FILES,
				gitleaks: { unavailable: 'FTL unable to load gitleaks config' },
				hadolint: NO_FILES,
				'markdownlint-cli2': NO_FILES,
				yamllint: NO_FILES,
			},
			commits: { skipped: 'gitleaks unavailable' },
		});
		expect(f.calls.some(([cmd, argv]) => cmd === 'git' && argv[0] === 'merge-base')).toBe(false);
	});

	test('нет бинарника gitleaks — commits skipped, merge-base не зовётся', () => {
		const root = repo({ 'README.txt': 'x\n' });
		const f = fakePort({ [GIT]: tracked('README.txt') });
		const out = readGuardrails(root, '', f.port, MAIN);
		expect('tools' in out && out.commits).toStrictEqual({ skipped: 'gitleaks unavailable' });
		expect(f.calls.map(([cmd]) => cmd)).toStrictEqual(['git']);
	});

	test('сбой копии (TMPDIR) — commits skipped, merge-base не зовётся', () => {
		const root = repo({ 'README.txt': 'x\n' });
		const f = fakePort({ [GIT]: tracked('README.txt'), [VERSION]: ok(`${PIN}\n`) });
		const saved = process.env.TMPDIR;
		process.env.TMPDIR = '/nonexistent';
		try {
			const out = readGuardrails(root, PROTOTOOLS, f.port, MAIN);
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
		const root = repo({ 'README.txt': 'x\n' });
		const f = fakePort({
			[GIT]: tracked('README.txt'),
			[VERSION]: ok(`${PIN}\n`),
			[DIR]: ok('[]'),
			[MB]: { code: 128, out: '', err: 'fatal: Not a valid object name origin/main\n' },
		});
		const out = readGuardrails(root, PROTOTOOLS, f.port, MAIN);
		expect('tools' in out && out.commits).toStrictEqual({
			unavailable: 'git merge-base origin/main HEAD: fatal: Not a valid object name origin/main',
		});
		expect(f.calls).toHaveLength(4);
	});

	test('gitleaks git: ERR в stderr — commits недоступны, часть файлов цела', () => {
		const root = repo({ 'README.txt': 'x\n' });
		const GIT_RUN = `/x/gl ${gitleaksGitArgv(root, `${SHA}..HEAD`, false).join(' ')}`;
		const f = fakePort({
			[GIT]: tracked('README.txt'),
			[VERSION]: ok(`${PIN}\n`),
			[DIR]: ok('[]'),
			[MB]: ok(`${SHA}\n`),
			[GIT_RUN]: { code: 0, out: '[]', err: '12:00AM ERR [git] fatal: boom\n' },
		});
		const out = readGuardrails(root, PROTOTOOLS, f.port, MAIN);
		expect('tools' in out && out.commits).toStrictEqual({ unavailable: 'ERR [git] fatal: boom' });
		expect('tools' in out && out.tools.gitleaks).toStrictEqual({
			version: PIN,
			files: 1,
			violations: [],
		});
	});

	test('нет файлов — commits skipped no files, пины не читаются', () => {
		const root = repo({});
		const f = fakePort({ [GIT]: ok('') });
		expect(readGuardrails(root, undefined, f.port, MAIN)).toStrictEqual({
			tools: {
				actionlint: NO_FILES,
				shellcheck: NO_FILES,
				gitleaks: NO_FILES,
				hadolint: NO_FILES,
				'markdownlint-cli2': NO_FILES,
				yamllint: NO_FILES,
			},
			commits: NO_FILES,
		});
		expect(f.calls).toHaveLength(1);
	});

	test('вне PR и без --base — skipped, второго запуска нет', () => {
		const root = repo({ 'README.txt': 'x\n' });
		const table = { [GIT]: tracked('README.txt'), [VERSION]: ok(`${PIN}\n`), [DIR]: ok('[]') };
		const outside = fakePort(table);
		const a = readGuardrails(root, PROTOTOOLS, outside.port, NO_BASE);
		expect('tools' in a && a.commits).toStrictEqual({
			skipped: 'no --base outside GitHub Actions',
		});
		expect(outside.calls).toHaveLength(3);
		const push = fakePort(table);
		const b = readGuardrails(root, PROTOTOOLS, push.port, { skipped: 'not a pull request' });
		expect('tools' in b && b.commits).toStrictEqual({ skipped: 'not a pull request' });
		expect(push.calls).toHaveLength(3);
	});

	test('база PR недоступна — commits недоступен с той же причиной, merge-base не зовётся', () => {
		const root = repo({ 'README.txt': 'x\n' });
		const reason = 'GITHUB_BASE_REF is empty in a pull_request job';
		const { port, calls } = fakePort({
			[GIT]: tracked('README.txt'),
			[VERSION]: ok(`${PIN}\n`),
			[DIR]: ok('[]'),
		});
		const outcome = readGuardrails(root, PROTOTOOLS, port, { unavailable: reason });
		expect('tools' in outcome && outcome.commits).toStrictEqual({ unavailable: reason });
		expect(calls.map(([cmd, argv]) => [cmd, argv[0]])).not.toContainEqual(['git', 'merge-base']);
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

	// main с каноном gitleaks; ветка feature: A добавляет файл с секретом, B удаляет, C меняет README.md.
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

	function scan(dir: string, pr: PrBase, over: Record<string, string> = {}) {
		const env = testEnv({ GITLEAKS_BIN: bin, ...over });
		const out = readGuardrails(dir, prototools, { run: spawnRunner(dir, env), env }, pr);
		if ('unavailable' in out) throw new Error(out.unavailable);
		return out;
	}

	test(
		'--base: секрет добавлен в A и удалён в B — одно нарушение с коммитом A, файлы чисты, значения нет',
		() => {
			const { dir, a } = feature();
			const out = scan(dir, { base: 'main' });
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
		'база { base: origin/main } — то же нарушение; { base: origin/gone } — недоступно',
		() => {
			const { dir, a } = feature();
			const found = scan(dir, MAIN);
			expect(
				'violations' in found.commits && found.commits.violations.map((v) => v.message),
			).toStrictEqual([`${DESCRIPTION} (commit ${a.slice(0, 12)})`]);
			const gone = scan(dir, { base: 'origin/gone' });
			expect('unavailable' in gone.commits && gone.commits.unavailable).toStartWith(
				'git merge-base origin/gone HEAD: ',
			);
		},
		TIMEOUT,
	);

	test(
		'база { skipped } — пропуск с той же причиной, NO_BASE — пропуск «no --base outside GitHub Actions»',
		() => {
			const { dir } = feature();
			expect(scan(dir, { skipped: 'not a pull request' }).commits).toStrictEqual({
				skipped: 'not a pull request',
			});
			expect(scan(dir, NO_BASE).commits).toStrictEqual({
				skipped: 'no --base outside GitHub Actions',
			});
		},
		TIMEOUT,
	);

	test(
		'GIT_TRACE=1: трассировка git в stderr — commits недоступны с ERR, не ноль нарушений',
		() => {
			const { dir } = feature();
			// Переменная должна дойти до дочернего процесса: окружение из параметра чистит spawnRunner.
			const out = scan(dir, { base: 'main' }, { GIT_TRACE: '1' });
			expect('unavailable' in out.commits && out.commits.unavailable).toStartWith('ERR ');
		},
		TIMEOUT,
	);

	test.each([
		['color.ui = always', '[color]\n\tui = always\n'],
		['color.diff = always', '[color]\n\tdiff = always\n'],
		['format.pretty = oneline', '[format]\n\tpretty = oneline\n'],
		['format.pretty = raw', '[format]\n\tpretty = raw\n'],
		['log.date = relative', '[log]\n\tdate = relative\n'],
		['log.abbrevCommit = true', '[log]\n\tabbrevCommit = true\n'],
	])(
		'конфиг git пользователя с %s не прячет находку и не теряет Commit: вывод git ломает разбор gitleaks',
		(_name, config) => {
			const { dir, a } = feature();
			const cfgDir = repoDir({ gitconfig: config });
			dirs.push(cfgDir);
			const out = scan(dir, { base: 'main' }, { GIT_CONFIG_GLOBAL: join(cfgDir, 'gitconfig') });
			expect(
				'violations' in out.commits && out.commits.violations.map((v) => v.message),
			).toStrictEqual([`${DESCRIPTION} (commit ${a.slice(0, 12)})`]);
		},
		TIMEOUT,
	);

	test(
		'--base HEAD: пустой диапазон — range без нарушений',
		() => {
			const { dir } = feature();
			const head = git(dir, 'rev-parse', 'HEAD').trim();
			expect(scan(dir, { base: 'HEAD' }).commits).toStrictEqual({
				range: `${head.slice(0, 12)}..HEAD`,
				violations: [],
			});
		},
		TIMEOUT,
	);
});
