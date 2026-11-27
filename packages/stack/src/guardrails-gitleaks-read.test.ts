import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { parsePins } from './canon.ts';
import { readGuardrails } from './guardrails.ts';
import { gitleaksDirArgv, gitleaksGitArgv } from './guardrails-gitleaks.ts';
import { type GuardrailRun, type GuardrailsPort, spawnRunner } from './guardrails-port.ts';
import { prBase } from './pr-base.ts';
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
	withPrivateTmpdir,
} from './testkit.ts';

const NO_PR = prBase(undefined, {});

// 64 hex собираются во время выполнения, поэтому eth-правило канона не видит их в исходнике; в имени
// нет слов key, secret, token, которые ищет generic-api-key из правил по умолчанию.
const HEX = '0123456789abcdef'.repeat(4);
const LINE = `ETH_PRIV=0x${HEX}\n`;
const DESCRIPTION = 'Ethereum private key (32 bytes hex, with or without 0x prefix)';
const RULE = 'eth-private-key-no-prefix';
// Имя файла игнора gitleaks собрано из частей: в репозитории стека такого файла нет.
const IGNORE_FILE = ['.gitleaks', 'ignore'].join('');

const ROOT_PINS = parsePins(readFileSync(join(ROOT, '.prototools'), 'utf8'));
const PIN = ROOT_PINS.gitleaks ?? '';
const PROTOTOOLS = `gitleaks = "${PIN}"\n`;
const NO_FILES = { skipped: 'no files' } as const;

const copies = (): string[] => readdirSync(tmpdir()).filter((n) => n.startsWith('stack-gitleaks-'));

type Row = GuardrailRun | ((cwd: string | undefined) => GuardrailRun);
type Call = [string, string[]];

// Порт-фальшивка: таблица «команда + аргументы → результат или функция от cwd», вызов вне таблицы
// бросает; вызовы записаны.
function fakePort(table: Record<string, Row>) {
	const calls: Call[] = [];
	const port: GuardrailsPort = {
		env: { GITLEAKS_BIN: '/x/gl' },
		run: (cmd, argv, cwd) => {
			calls.push([cmd, argv]);
			const hit = table[[cmd, ...argv].join(' ')];
			if (hit === undefined) throw new Error(`unexpected call: ${cmd} ${argv.join(' ')}`);
			return typeof hit === 'function' ? hit(cwd) : hit;
		},
	};
	return { port, calls };
}

const ok = (out: string): GuardrailRun => ({ code: 0, out, err: '' });
const GIT = 'git ls-files -z';
const VERSION = '/x/gl version';
const DIR = `/x/gl ${gitleaksDirArgv().join(' ')}`;
const tracked = (...paths: string[]): GuardrailRun => ok(paths.map((p) => `${p}\0`).join(''));
const finding = (over: Record<string, unknown> = {}): string =>
	JSON.stringify([
		{
			RuleID: RULE,
			Description: DESCRIPTION,
			StartLine: 2,
			File: 'README.txt',
			Commit: '',
			Secret: 'REDACTED',
			Match: 'REDACTED',
			...over,
		},
	]);

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

	test('копия отслеживаемых файлов в чужом каталоге, после возврата её нет; shellcheck не ищется', () => {
		// На диске лежит ещё и неотслеживаемый .env: git его не печатает, в копию он не попадает.
		const root = repo({ 'README.txt': '# acme\n', '.env': LINE });
		let seen: { cwd: string | undefined; listing: string[] } | undefined;
		const f = fakePort({
			[GIT]: tracked('README.txt'),
			[VERSION]: ok(`${PIN}\n`),
			[DIR]: (cwd) => {
				seen = { cwd, listing: cwd === undefined ? [] : readdirSync(cwd) };
				return ok('[]');
			},
		});
		const out = readGuardrails(root, PROTOTOOLS, f.port, NO_PR);
		expect(out).toStrictEqual({
			tools: {
				actionlint: NO_FILES,
				shellcheck: NO_FILES,
				gitleaks: { version: PIN, files: 1, violations: [] },
				hadolint: NO_FILES,
				'markdownlint-cli2': NO_FILES,
				yamllint: NO_FILES,
			},
			commits: { skipped: 'no --base outside GitHub Actions' },
		});
		expect(f.calls).toStrictEqual([
			['git', ['ls-files', '-z']],
			['/x/gl', ['version']],
			['/x/gl', gitleaksDirArgv()],
		]);
		expect(seen?.cwd).not.toBe(root);
		expect(seen?.cwd?.startsWith(join(tmpdir(), 'stack-gitleaks-'))).toBe(true);
		expect(seen?.listing).toStrictEqual(['README.txt']);
		expect(existsSync(seen?.cwd ?? root)).toBe(false);
	});

	test('код 3 с находкой — нарушение gitleaks, files по числу скопированных', () => {
		const root = repo({ 'README.txt': '# acme\n', 'a.txt': 'a\n' });
		const f = fakePort({
			[GIT]: tracked('README.txt', 'a.txt'),
			[VERSION]: ok(`${PIN}\n`),
			[DIR]: { code: 3, out: finding(), err: '' },
		});
		expect(readGuardrails(root, PROTOTOOLS, f.port, NO_PR)).toStrictEqual({
			tools: {
				actionlint: NO_FILES,
				shellcheck: NO_FILES,
				gitleaks: {
					version: PIN,
					files: 2,
					violations: [
						{ tool: 'gitleaks', rule: RULE, path: 'README.txt', line: 2, message: DESCRIPTION },
					],
				},
				hadolint: NO_FILES,
				'markdownlint-cli2': NO_FILES,
				yamllint: NO_FILES,
			},
			commits: { skipped: 'no --base outside GitHub Actions' },
		});
	});

	test('пустой Description — сообщение secret detected', () => {
		const root = repo({ 'README.txt': '# acme\n' });
		const f = fakePort({
			[GIT]: tracked('README.txt'),
			[VERSION]: ok(`${PIN}\n`),
			[DIR]: { code: 3, out: finding({ Description: '' }), err: '' },
		});
		const out = readGuardrails(root, PROTOTOOLS, f.port, NO_PR);
		expect('tools' in out && out.tools.gitleaks).toStrictEqual({
			version: PIN,
			files: 1,
			violations: [
				{ tool: 'gitleaks', rule: RULE, path: 'README.txt', line: 2, message: 'secret detected' },
			],
		});
	});

	test('нет пина gitleaks — недоступен, бинарник не зовётся, копии нет', () => {
		const root = repo({ 'README.txt': '# acme\n' });
		const withoutGitleaks = Object.entries(ROOT_PINS)
			.filter(([name]) => name !== 'gitleaks')
			.map(([name, version]) => `${name} = "${version}"\n`)
			.join('');
		withPrivateTmpdir(() => {
			const before = copies();
			const f = fakePort({ [GIT]: tracked('README.txt') });
			const out = readGuardrails(root, withoutGitleaks, f.port, NO_PR);
			expect('tools' in out && out.tools.gitleaks).toStrictEqual({
				unavailable: '.prototools has no gitleaks pin',
			});
			expect(f.calls).toStrictEqual([['git', ['ls-files', '-z']]]);
			expect(copies()).toStrictEqual(before);
		});
	});

	test('FTL в stderr — недоступен с этой причиной, каталог копии удалён', () => {
		const root = repo({ 'README.txt': '# acme\n' });
		let cwd: string | undefined;
		const f = fakePort({
			[GIT]: tracked('README.txt'),
			[VERSION]: ok(`${PIN}\n`),
			[DIR]: (c) => {
				cwd = c;
				return { code: 1, out: '', err: '12:00AM FTL unable to load gitleaks config\n' };
			},
		});
		const out = readGuardrails(root, PROTOTOOLS, f.port, NO_PR);
		expect('tools' in out && out.tools.gitleaks).toStrictEqual({
			unavailable: 'FTL unable to load gitleaks config',
		});
		expect(cwd).toBeDefined();
		expect(existsSync(cwd ?? root)).toBe(false);
	});

	test('причина gitleaks по файлам: путь копии — путь репозитория, голый каталог — точка', () => {
		const root = repo({ 'README.txt': '# acme\n' });
		const f = fakePort({
			[GIT]: tracked('README.txt'),
			[VERSION]: ok(`${PIN}\n`),
			[DIR]: (c) => ({ code: 1, out: '', err: `boom ${c}/x in ${c}\n` }),
		});
		const out = readGuardrails(root, PROTOTOOLS, f.port, NO_PR);
		expect('tools' in out && out.tools.gitleaks).toStrictEqual({ unavailable: 'boom x in .' });
	});

	test('причина gitleaks по коммитам: путь копии — путь репозитория, голый каталог — точка', () => {
		const root = repo({ 'README.txt': '# acme\n' });
		const MB = '0123456789abcdef0123456789abcdef01234567';
		const range = `${MB}..HEAD`;
		const f = fakePort({
			[GIT]: tracked('README.txt'),
			[VERSION]: ok(`${PIN}\n`),
			[DIR]: ok('[]'),
			'git merge-base origin/main HEAD': ok(`${MB}\n`),
			[`/x/gl ${gitleaksGitArgv(resolve(root), range, false).join(' ')}`]: (c) => ({
				code: 1,
				out: '',
				err: `boom ${c}/x in ${c}\n`,
			}),
		});
		const out = readGuardrails(root, PROTOTOOLS, f.port, { base: 'origin/main' });
		expect('tools' in out && out.commits).toStrictEqual({ unavailable: 'boom x in .' });
	});

	test('порт бросил посреди скана — каталог копии всё равно удалён', () => {
		const root = repo({ 'README.txt': '# acme\n' });
		let cwd: string | undefined;
		const f = fakePort({
			[GIT]: tracked('README.txt'),
			[VERSION]: ok(`${PIN}\n`),
			[DIR]: (c) => {
				cwd = c;
				throw new Error('boom');
			},
		});
		expect(() => readGuardrails(root, PROTOTOOLS, f.port, NO_PR)).toThrow('boom');
		expect(cwd).toBeDefined();
		expect(existsSync(cwd ?? root)).toBe(false);
	});

	test('TMPDIR недоступен — gitleaks недоступен с copy:, скан не запускается и корень не сканируется', () => {
		const root = repo({ 'README.txt': '# acme\n', '.env': LINE });
		const f = fakePort({ [GIT]: tracked('README.txt'), [VERSION]: ok(`${PIN}\n`) });
		const saved = process.env.TMPDIR;
		process.env.TMPDIR = '/nonexistent';
		try {
			const out = readGuardrails(root, PROTOTOOLS, f.port, NO_PR);
			const part = 'tools' in out ? out.tools.gitleaks : undefined;
			expect(part !== undefined && 'unavailable' in part && part.unavailable).toStartWith('copy: ');
		} finally {
			if (saved === undefined) Reflect.deleteProperty(process.env, 'TMPDIR');
			else process.env.TMPDIR = saved;
		}
		expect(f.calls).toStrictEqual([
			['git', ['ls-files', '-z']],
			['/x/gl', ['version']],
		]);
	});

	test('пустой список git — все три части skipped, зовётся один git, пины не читаются', () => {
		const root = repo({});
		const f = fakePort({ [GIT]: ok('') });
		// .prototools нет: недоступность была бы, если бы пины читались.
		expect(readGuardrails(root, undefined, f.port, NO_PR)).toStrictEqual({
			tools: {
				actionlint: NO_FILES,
				shellcheck: NO_FILES,
				gitleaks: NO_FILES,
				hadolint: NO_FILES,
				'markdownlint-cli2': NO_FILES,
				yamllint: NO_FILES,
			},
			commits: { skipped: 'no files' },
		});
		expect(f.calls).toStrictEqual([['git', ['ls-files', '-z']]]);
	});
});

describe('настоящий gitleaks через читатель', () => {
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
	const CLEAN_SOURCE = 'export const a = 1;\n';

	// Репозиторий с каноном gitleaks и закоммиченным чистым файлом исходников.
	function fixture(extra: Record<string, string> = {}): string {
		const { dir } = gitRepo({
			'.gitleaks.toml': canonFile('.gitleaks.toml'),
			'.gitleaks.canon.toml': canonFile('.gitleaks.canon.toml'),
			'src/a.ts': CLEAN_SOURCE,
			...extra,
		});
		dirs.push(dir);
		return dir;
	}

	function scan(dir: string) {
		const env = testEnv({ GITLEAKS_BIN: bin });
		const out = readGuardrails(dir, prototools, { run: spawnRunner(dir, env), env }, NO_PR);
		if ('unavailable' in out) throw new Error(out.unavailable);
		return { out, part: out.tools.gitleaks };
	}

	const paths = (part: ReturnType<typeof scan>['part']): string[] => {
		if (!('violations' in part)) throw new Error(JSON.stringify(part));
		return part.violations.map((v) => v.path);
	};

	function commit(dir: string, path: string, content: string): void {
		put(dir, path, content);
		git(dir, 'add', path);
		git(dir, 'commit', '-m', `add ${path}`);
	}

	test(
		'секрет вне отслеживаемых файлов не виден, в закоммиченном — одно нарушение без значения',
		() => {
			const dir = fixture({ '.gitignore': '*.local\n.worktrees/\n' });
			put(dir, '.env', LINE);
			put(dir, 'x.local', LINE);
			git(dir, 'worktree', 'add', '--detach', '.worktrees/wt');
			put(dir, '.worktrees/wt/untracked.ts', LINE);
			put(dir, 'nested/leak.ts', LINE);
			git(join(dir, 'nested'), 'init', '-b', 'main');
			git(join(dir, 'nested'), 'add', 'leak.ts');
			git(join(dir, 'nested'), 'commit', '-m', 'nested');

			const clean = scan(dir).part;
			expect(clean).toStrictEqual({ version: PIN, files: 4, violations: [] });

			commit(dir, 'src/b.ts', LINE);
			const leaked = scan(dir);
			expect(paths(leaked.part)).toStrictEqual(['src/b.ts']);
			expect(leaked.part).toMatchObject({
				violations: [{ tool: 'gitleaks', rule: RULE, line: 1 }],
			});
			expect(JSON.stringify(leaked.out)).not.toContain(HEX);
			expect(JSON.stringify(leaked.out)).not.toContain(HEX.slice(0, 16));
		},
		TIMEOUT,
	);

	test(
		'закоммиченный чистый файл дописан секретом на диске без коммита — находка',
		() => {
			const dir = fixture();
			writeFileSync(join(dir, 'src/a.ts'), `${CLEAN_SOURCE}${LINE}`);
			expect(paths(scan(dir).part)).toStrictEqual(['src/a.ts']);
		},
		TIMEOUT,
	);

	test(
		'GITLEAKS_CONFIG из окружения родителя не подменяет конфиг репозитория',
		() => {
			const dir = fixture();
			commit(dir, 'src/b.ts', LINE);
			const outside = repoDir({ 'empty.toml': 'title = "empty"\n' });
			dirs.push(outside);
			const saved = process.env.GITLEAKS_CONFIG;
			process.env.GITLEAKS_CONFIG = join(outside, 'empty.toml');
			try {
				expect(paths(scan(dir).part)).toStrictEqual(['src/b.ts']);
			} finally {
				if (saved === undefined) delete process.env.GITLEAKS_CONFIG;
				else process.env.GITLEAKS_CONFIG = saved;
			}
		},
		TIMEOUT,
	);

	test(
		'файл игнора и gitleaks:allow гасят находки только закоммиченными',
		() => {
			const dir = fixture();
			commit(dir, 'src/b.ts', LINE);
			commit(dir, 'src/c.ts', `ETH_PRIV=0x${HEX} # gitleaks:allow\n`);
			put(dir, IGNORE_FILE, `src/b.ts:${RULE}:1\n`);
			// Файл игнора не отслеживается — в копию не попадает, находка остаётся; второй файл погашен allow.
			expect(paths(scan(dir).part)).toStrictEqual(['src/b.ts']);
			git(dir, 'add', IGNORE_FILE);
			git(dir, 'commit', '-m', 'ignore');
			expect(scan(dir).part).toStrictEqual({ version: PIN, files: 6, violations: [] });
		},
		TIMEOUT,
	);
});
