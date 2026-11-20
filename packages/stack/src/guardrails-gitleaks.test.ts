import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
	copyTracked,
	gitleaksDirArgv,
	gitleaksGitArgv,
	parseGitleaks,
} from './guardrails-gitleaks.ts';
import {
	canonFile,
	git,
	gitRepo,
	isolateGitConfig,
	protoBin,
	put,
	repoDir,
	runTool,
} from './testkit.ts';

// 64 hex собираются во время выполнения, поэтому eth-правило канона не видит их в исходнике; в имени
// нет слов key, secret, token, которые ищет generic-api-key из правил по умолчанию.
const HEX = '0123456789abcdef'.repeat(4);
const LINE = `ETH_PRIV=0x${HEX}\n`;
const DESCRIPTION = 'Ethereum private key (32 bytes hex, with or without 0x prefix)';

const FLAGS = [
	'--redact',
	'--no-banner',
	'--no-color',
	'--log-level',
	'info',
	'--exit-code',
	'3',
	'--report-format',
	'json',
	'--report-path',
	'-',
];

describe('аргументы', () => {
	test('dir: один каталог в cwd и зафиксированные флаги', () => {
		expect(gitleaksDirArgv()).toStrictEqual(['dir', ...FLAGS, '.']);
	});

	test('git: диапазон, конфиг по флагу и корень последним', () => {
		expect(gitleaksGitArgv('/r', 'abc..HEAD', true)).toStrictEqual([
			'git',
			...FLAGS,
			'--log-opts=abc..HEAD',
			'--config',
			'.gitleaks.toml',
			'/r',
		]);
		expect(gitleaksGitArgv('/r', 'abc..HEAD', false)).toStrictEqual([
			'git',
			...FLAGS,
			'--log-opts=abc..HEAD',
			'/r',
		]);
	});
});

// Полный отчёт 8.30.1: 18 полей; Secret и Match с --redact — REDACTED.
function fullItem(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		RuleID: 'eth-private-key-no-prefix',
		Description: DESCRIPTION,
		StartLine: 1,
		EndLine: 1,
		StartColumn: 1,
		EndColumn: 80,
		Match: 'REDACTED',
		Secret: 'REDACTED',
		File: 'src/a.ts',
		SymlinkFile: '',
		Commit: '',
		Entropy: 3.5,
		Author: '',
		Email: '',
		Date: '',
		Message: '',
		Tags: [],
		Fingerprint: 'src/a.ts:eth-private-key-no-prefix:1',
		...over,
	};
}

const info = '3:45PM INF scanned ~6 bytes (6 bytes) in 2.18ms\n3:45PM INF no leaks found\n';

describe('parseGitleaks', () => {
	test('код 0 и [] — чисто', () => {
		expect(parseGitleaks({ code: 0, out: '[]\n', err: info })).toStrictEqual([]);
	});

	test('код 0, [] и ERR от git — недоступность с первой ERR-строкой', () => {
		const err =
			"3:45PM ERR [git] fatal: ambiguous argument 'origin/nope..HEAD': unknown revision or path not in the working tree.\n" +
			'3:45PM ERR error="stderr is not empty"\n3:45PM INF 0 commits scanned.\n3:45PM INF no leaks found\n';
		expect(parseGitleaks({ code: 0, out: '[]', err })).toStrictEqual({
			unavailable:
				"ERR [git] fatal: ambiguous argument 'origin/nope..HEAD': unknown revision or path not in the working tree.",
		});
	});

	test('пустой диапазон и WRN — не сбой', () => {
		expect(
			parseGitleaks({ code: 0, out: '[]', err: '3:45PM INF 0 commits scanned.\n' }),
		).toStrictEqual([]);
		expect(
			parseGitleaks({ code: 0, out: '[]', err: '3:45PM WRN leaks found: 0\n3:45PM INF x\n' }),
		).toStrictEqual([]);
	});

	test('FTL с ANSI при коде 1 — недоступность без цвета', () => {
		const err =
			'\x1b[90m3:45PM\x1b[0m \x1b[31mFTL\x1b[0m unable to load gitleaks config, err: While parsing config: toml: expected character ]\n';
		expect(parseGitleaks({ code: 1, out: '', err })).toStrictEqual({
			unavailable:
				'FTL unable to load gitleaks config, err: While parsing config: toml: expected character ]',
		});
	});

	test('код 2: строка panic, а не первая строка stderr', () => {
		const err = [
			'WARNING: All log messages before absl::InitializeLog() is called are written to STDERR',
			"E0000 00:00:1 re2.cc:237] Error parsing '(': missing )",
			'panic: regexp: Compile(`(`): error parsing regexp: missing closing ): `(`',
			'goroutine 1 [running]:',
		].join('\n');
		expect(parseGitleaks({ code: 2, out: '', err })).toStrictEqual({
			unavailable: 'panic: regexp: Compile(`(`): error parsing regexp: missing closing ): `(`',
		});
	});

	test('код 126 без panic — первая строка stderr', () => {
		expect(
			parseGitleaks({ code: 126, out: '', err: 'Error: unknown flag: --bogus\nUsage: x\n' }),
		).toStrictEqual({ unavailable: 'Error: unknown flag: --bogus' });
	});

	test('код 3 с полным элементом — пять полей и ничего больше', () => {
		expect(parseGitleaks({ code: 3, out: JSON.stringify([fullItem()]), err: info })).toStrictEqual([
			{
				rule: 'eth-private-key-no-prefix',
				path: 'src/a.ts',
				line: 1,
				commit: '',
				description: DESCRIPTION,
			},
		]);
	});

	test('значение секрета из Secret, Match и Message в результат не попадает', () => {
		const raw = `ETH_PRIV=0x${HEX}`;
		const out = JSON.stringify([fullItem({ Secret: raw, Match: raw, Message: raw })]);
		const found = parseGitleaks({ code: 3, out, err: '' });
		expect(Array.isArray(found)).toBe(true);
		expect(JSON.stringify(found)).not.toContain(HEX);
	});

	test('код 3 и [] — расхождение; код 0 и находки — расхождение', () => {
		expect(parseGitleaks({ code: 3, out: '[]', err: '' })).toStrictEqual({
			unavailable: 'exited with 3 and reported nothing',
		});
		expect(parseGitleaks({ code: 0, out: JSON.stringify([fullItem()]), err: '' })).toStrictEqual({
			unavailable: 'exited with 0 and reported findings',
		});
	});

	test('не JSON и неверная форма', () => {
		expect(parseGitleaks({ code: 0, out: 'x', err: '' })).toStrictEqual({
			unavailable: 'output is not JSON',
		});
		const shape = { unavailable: 'output has an unexpected shape: findings' };
		expect(parseGitleaks({ code: 0, out: '{}', err: '' })).toStrictEqual(shape);
		const { StartLine: _drop, ...noLine } = fullItem();
		expect(parseGitleaks({ code: 3, out: JSON.stringify([noLine]), err: '' })).toStrictEqual(shape);
		expect(parseGitleaks({ code: 3, out: '[null]', err: '' })).toStrictEqual(shape);
	});

	test.each(['RuleID', 'File', 'Description', 'Commit', 'StartLine'])(
		'элемент без поля %s и с числом вместо него — неверная форма',
		(field) => {
			const shape = { unavailable: 'output has an unexpected shape: findings' };
			const { [field]: _drop, ...without } = fullItem();
			expect(parseGitleaks({ code: 3, out: JSON.stringify([without]), err: '' })).toStrictEqual(
				shape,
			);
			const wrong = field === 'StartLine' ? 'x' : 7;
			const out = JSON.stringify([fullItem({ [field]: wrong })]);
			expect(parseGitleaks({ code: 3, out, err: '' })).toStrictEqual(shape);
		},
	);
});

function listAll(dir: string, prefix = ''): string[] {
	const found: string[] = [];
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		if (e.isDirectory()) found.push(...listAll(join(dir, e.name), `${prefix}${e.name}/`));
		else found.push(`${prefix}${e.name}`);
	}
	return found;
}

const copies = (): string[] => readdirSync(tmpdir()).filter((n) => n.startsWith('stack-gitleaks-'));

describe('copyTracked', () => {
	const made: string[] = [];
	afterAll(() => {
		for (const d of made) rmSync(d, { recursive: true, force: true });
	});

	test('ровно перечисленные файлы с содержимым, в новом каталоге', () => {
		const names = ['a.ts', 'dir/b c.ts', 'файл.ts', '-x.ts', 'deep/er/z.ts'];
		const src = repoDir({ ...Object.fromEntries(names.map((n) => [n, `c:${n}`])), 'skip.ts': 's' });
		made.push(src);
		const r = copyTracked(src, names);
		if ('unavailable' in r) throw new Error(r.unavailable);
		made.push(r.dir);
		expect(r.dir.startsWith(join(tmpdir(), 'stack-gitleaks-'))).toBe(true);
		expect(listAll(r.dir).sort()).toStrictEqual([...names].sort());
		for (const n of names) expect(readFileSync(join(r.dir, n), 'utf8')).toBe(`c:${n}`);
	});

	test('TMPDIR недоступен — unavailable, а не исключение', () => {
		const src = repoDir({ 'a.ts': 'a' });
		made.push(src);
		const saved = process.env.TMPDIR;
		process.env.TMPDIR = '/nonexistent';
		try {
			const r = copyTracked(src, ['a.ts']);
			expect('unavailable' in r && r.unavailable.startsWith('copy: ')).toBe(true);
		} finally {
			if (saved === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = saved;
		}
	});

	test('нет файла — unavailable с путём и без нового каталога', () => {
		const src = repoDir({ 'a.ts': 'a' });
		made.push(src);
		const before = copies();
		const r = copyTracked(src, ['a.ts', 'gone.ts']);
		expect('unavailable' in r && r.unavailable.startsWith('copy gone.ts: ')).toBe(true);
		expect(copies()).toStrictEqual(before);
	});
});

describe('настоящий gitleaks', () => {
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

	const canon = (): Record<string, string> => ({
		'.gitleaks.toml': canonFile('.gitleaks.toml'),
		'.gitleaks.canon.toml': canonFile('.gitleaks.canon.toml'),
	});
	const tracked = ['src/a.ts', 'dir/b c.ts', 'файл.ts', '-x.ts'];

	function scanDir(config?: string) {
		const files: Record<string, string> = { ...canon(), 'untracked.ts': LINE };
		if (config !== undefined) files['.gitleaks.toml'] = config;
		for (const t of tracked) files[t] = LINE;
		const src = repoDir(files);
		dirs.push(src);
		const copy = copyTracked(src, ['.gitleaks.toml', '.gitleaks.canon.toml', ...tracked]);
		if ('unavailable' in copy) throw new Error(copy.unavailable);
		dirs.push(copy.dir);
		const run = runTool(bin, gitleaksDirArgv(), copy.dir);
		return {
			run,
			parsed: parseGitleaks({ code: run.status ?? -1, out: run.stdout, err: run.stderr }),
		};
	}

	test('dir по копии: только отслеживаемые, правило канона, секрета нет в выводе', () => {
		const { run, parsed } = scanDir();
		if ('unavailable' in parsed) throw new Error(`${parsed.unavailable}\n${run.ctx}`);
		expect(parsed.map((l) => l.path).sort()).toStrictEqual([
			'-x.ts',
			'dir/b c.ts',
			'src/a.ts',
			'файл.ts',
		]);
		expect(new Set(parsed.map((l) => l.rule))).toStrictEqual(
			new Set(['eth-private-key-no-prefix']),
		);
		for (const s of [HEX, HEX.slice(0, 16)]) {
			expect(run.stdout).not.toContain(s);
			expect(run.stderr).not.toContain(s);
		}
	}, 30_000);

	test('сломанный конфиг — недоступность FTL', () => {
		const { parsed } = scanDir('[extend\npath = ".gitleaks.canon.toml"\n');
		expect('unavailable' in parsed && parsed.unavailable).toStartWith(
			'FTL unable to load gitleaks config',
		);
	}, 30_000);

	test('git по диапазону: находка в удалённом файле, пустой и плохой диапазон', () => {
		const { dir } = gitRepo({ ...canon(), 'README.md': 'x\n' });
		dirs.push(dir);
		const base = git(dir, 'rev-parse', 'main').trim();
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
		const head = git(dir, 'rev-parse', 'HEAD').trim();
		const copy = copyTracked(dir, ['.gitleaks.toml', '.gitleaks.canon.toml', 'README.md']);
		if ('unavailable' in copy) throw new Error(copy.unavailable);
		dirs.push(copy.dir);
		const scan = (range: string) => {
			const run = runTool(bin, gitleaksGitArgv(dir, range, true), copy.dir);
			return parseGitleaks({ code: run.status ?? -1, out: run.stdout, err: run.stderr });
		};
		const found = scan(`${base}..HEAD`);
		if ('unavailable' in found) throw new Error(found.unavailable);
		expect(found.map((l) => [l.path, l.commit])).toStrictEqual([['leak.ts', a]]);
		expect(scan(`${head}..HEAD`)).toStrictEqual([]);
		const bad = scan('origin/nope..HEAD');
		expect('unavailable' in bad && bad.unavailable).toStartWith(
			'ERR [git] fatal: ambiguous argument',
		);
	}, 30_000);
});
