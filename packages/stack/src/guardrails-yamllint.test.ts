import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { toolVersion } from './guardrails-bin.ts';
import { yamlFiles } from './guardrails-files.ts';
import { type GuardrailRun, spawnRunner } from './guardrails-port.ts';
import {
	parseYamllint,
	PATHSPEC_VERSION,
	PYYAML_VERSION,
	YAMLLINT_VERSION,
	yamllintArgv,
	yamllintConfig,
} from './guardrails-yamllint.ts';
import { canonFile, protoBin, repoDir, testEnv } from './testkit.ts';

const run = (out: string, over: Partial<GuardrailRun> = {}): GuardrailRun => ({
	code: 0,
	out,
	err: '',
	...over,
});

describe('аргументы, конфиг и файлы', () => {
	test('argv собран из YAMLLINT_VERSION, PYYAML_VERSION и PATHSPEC_VERSION', () => {
		expect(yamllintArgv('.yamllint')).toStrictEqual([
			'tool',
			'run',
			'-q',
			'--from',
			`yamllint==${YAMLLINT_VERSION}`,
			'--with',
			`pyyaml==${PYYAML_VERSION}`,
			'--with',
			`pathspec==${PATHSPEC_VERSION}`,
			'yamllint',
			'-f',
			'parsable',
			'-c',
			'.yamllint',
			'.',
		]);
		expect(yamllintArgv('.yamllint.yml').at(-2)).toBe('.yamllint.yml');
	});

	test('версии — точные x.y.z', () => {
		expect(YAMLLINT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
		// PyPI-пакеты выходят и как x.y (6.1), и как x.y.z: форма точной версии, не диапазона.
		const EXACT_PYPI = /^\d+(\.\d+)+$/;
		expect(PYYAML_VERSION).toMatch(EXACT_PYPI);
		expect(PATHSPEC_VERSION).toMatch(EXACT_PYPI);
		for (const ok of ['6.1', '6.0.5']) expect(ok).toMatch(EXACT_PYPI);
		for (const bad of ['>=6', '^6.0.4', '6.*']) expect(bad).not.toMatch(EXACT_PYPI);
	});

	test('конфиг — первый из списка, что есть среди файлов', () => {
		expect(yamllintConfig(['.yamllint.yaml', '.yamllint'])).toBe('.yamllint');
		expect(yamllintConfig(['.yamllint.yml'])).toBe('.yamllint.yml');
		expect(yamllintConfig(['.yamllint.yml', '.yamllint.yaml'])).toBe('.yamllint.yaml');
		expect(yamllintConfig([])).toBeUndefined();
		expect(yamllintConfig(['sub/.yamllint'])).toBeUndefined();
		expect(yamllintConfig(['apps/api/.yamllint', 'a.yml'])).toBeUndefined();
	});

	test('yamlFiles: .yaml и .yml по basename, регистр важен, порядок входа', () => {
		expect(yamlFiles(['a.yml', 'b/c.yaml', 'd.YML', 'e.yml.txt', '.f.yml'])).toStrictEqual([
			'a.yml',
			'b/c.yaml',
			'.f.yml',
		]);
	});

	test('toolVersion uv: первая строка uv <версия> (…)', () => {
		expect(toolVersion('uv', 'uv 0.13.9 (x86_64-unknown-linux-gnu)\n')).toBe('0.13.9');
		expect(toolVersion('uv', 'uv 0.13.9\n')).toBe('0.13.9');
		expect(toolVersion('uv', '0.13.9\n')).toBeUndefined();
		expect(toolVersion('uv', 'noise\nuv 0.13.9\n')).toBeUndefined();
	});
});

describe('parseYamllint', () => {
	test('код 0 и пустой stdout — нет находок', () => {
		expect(parseYamllint(run(''))).toStrictEqual([]);
	});

	test('warning при коде 0 — находка', () => {
		expect(
			parseYamllint(
				run('./truthy.yaml:1:4: [warning] truthy value should be one of [false, true] (truthy)\n'),
			),
		).toStrictEqual([
			{
				tool: 'yamllint',
				rule: 'truthy',
				path: 'truthy.yaml',
				line: 1,
				message: 'truthy value should be one of [false, true]',
			},
		]);
	});

	test('error при коде 1 — находка, путь без ведущего ./', () => {
		expect(
			parseYamllint(
				run('./dup.yml:2:1: [error] duplication of key "a" in mapping (key-duplicates)\n', {
					code: 1,
				}),
			),
		).toStrictEqual([
			{
				tool: 'yamllint',
				rule: 'key-duplicates',
				path: 'dup.yml',
				line: 2,
				message: 'duplication of key "a" in mapping',
			},
		]);
	});

	test('путь с двоеточием и сообщение со скобками', () => {
		expect(
			parseYamllint(
				run(
					"./a:b.yml:3:1: [error] syntax error: expected the node content, but found '<stream end>' (syntax)\n",
					{ code: 1 },
				),
			),
		).toMatchObject([{ path: 'a:b.yml', rule: 'syntax', line: 3 }]);
		expect(parseYamllint(run('./x.yml:1:1: [warning] found (x) here (truthy)\n'))).toMatchObject([
			{ rule: 'truthy', message: 'found (x) here', path: 'x.yml' },
		]);
	});

	test('порядок находок — порядок строк', () => {
		const out = './b.yml:5:1: [warning] w (truthy)\n./a.yml:2:1: [error] e (syntax)\n';
		const parsed = parseYamllint(run(out, { code: 1 }));
		if (!Array.isArray(parsed)) throw new Error(JSON.stringify(parsed));
		expect(parsed.map((v) => `${v.path}:${v.line}`)).toStrictEqual(['b.yml:5', 'a.yml:2']);
	});

	test('traceback Python — недоступность с последней строкой stderr', () => {
		const last = "FileNotFoundError: [Errno 2] No such file or directory: '.yamllint-ignores'";
		const err = `Traceback (most recent call last):\n  File "x.py", line 1, in <module>\n${last}\n`;
		expect(parseYamllint(run('', { code: 1, err }))).toStrictEqual({ unavailable: last });
	});

	test('ошибка uv — недоступность со строкой error:', () => {
		const err = [
			'error: No solution found when resolving tool dependencies:',
			'  ╰─▶ Because yamllint was not found in the cache and you require yamllint==1.38.0',
			'  hint: Packages were unavailable because the network was disabled.',
			'',
		].join('\n');
		expect(parseYamllint(run('', { code: 1, err }))).toStrictEqual({
			unavailable: 'error: No solution found when resolving tool dependencies:',
		});
	});

	test('код 255 — недоступность со строкой stderr', () => {
		const err = "[Errno 2] No such file or directory: 'missing.yml'\n";
		expect(parseYamllint(run('', { code: 255, err }))).toStrictEqual({
			unavailable: "[Errno 2] No such file or directory: 'missing.yml'",
		});
	});

	test('код вне 0 и 1 без stderr — exited with <код>', () => {
		expect(parseYamllint(run('', { code: 2 }))).toStrictEqual({ unavailable: 'exited with 2' });
	});

	test('непустой stderr при коде 0 — недоступность', () => {
		expect(parseYamllint(run('', { err: 'warn: x\n' }))).toStrictEqual({ unavailable: 'warn: x' });
	});

	test('мусор в stdout — неожиданная форма', () => {
		expect(parseYamllint(run('garbage'))).toStrictEqual({
			unavailable: 'output has an unexpected shape: lines',
		});
	});

	test('код 1 только с warning и код 0 с error — несогласованность', () => {
		expect(parseYamllint(run('./a.yml:1:1: [warning] w (truthy)\n', { code: 1 }))).toStrictEqual({
			unavailable: 'exited with 1 and reported no error',
		});
		expect(parseYamllint(run('', { code: 1 }))).toStrictEqual({
			unavailable: 'exited with 1 and reported no error',
		});
		expect(parseYamllint(run('./a.yml:1:1: [error] e (syntax)\n'))).toStrictEqual({
			unavailable: 'exited with 0 and reported an error',
		});
	});
});

describe('настоящий uv и yamllint', () => {
	const TIMEOUT = 60_000;
	let uv = '';
	const dirs: string[] = [];
	beforeAll(() => {
		uv = protoBin('uv');
	});
	afterAll(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
	});

	const fixture = (over: Record<string, string> = {}): string => {
		const dir = repoDir({
			'.yamllint': canonFile('.yamllint'),
			'.yamllint-canon-ignores': canonFile('.yamllint-canon-ignores'),
			'.yamllint-ignores': `${canonFile('.yamllint-ignores')}ignored/\n`,
			'dup.yml': 'a: 1\na: 2\n',
			'truthy.yaml': 'a: yes\n',
			'ignored/x.yml': 'a: 1\na: 2\n',
			'notyaml.txt': 'a: 1\na: 2\n',
			...over,
		});
		dirs.push(dir);
		return dir;
	};

	test(
		'две находки: key-duplicates и truthy; игнор и не-YAML не попадают',
		() => {
			const dir = fixture();
			const parsed = parseYamllint(spawnRunner(dir, testEnv())(uv, yamllintArgv('.yamllint'), dir));
			if (!Array.isArray(parsed)) throw new Error(JSON.stringify(parsed));
			expect(parsed.map((v) => `${v.rule} ${v.path}:${v.line}`).sort()).toStrictEqual([
				'key-duplicates dup.yml:2',
				'truthy truthy.yaml:1',
			]);
		},
		TIMEOUT,
	);

	test(
		'нет .yamllint-ignores — недоступность FileNotFoundError, а не «чисто»',
		() => {
			const dir = fixture();
			rmSync(join(dir, '.yamllint-ignores'));
			const parsed = parseYamllint(spawnRunner(dir, testEnv())(uv, yamllintArgv('.yamllint'), dir));
			expect(parsed).toMatchObject({ unavailable: expect.stringMatching(/^FileNotFoundError/) });
		},
		TIMEOUT,
	);

	test(
		'холодный кэш без сети — недоступность error: No solution found',
		() => {
			const dir = fixture();
			const cache = mkdtempSync(join(tmpdir(), 'stack-uv-cache-'));
			dirs.push(cache);
			const r = spawnRunner(dir, testEnv())(uv, yamllintArgv('.yamllint'), dir, {
				UV_OFFLINE: '1',
				UV_CACHE_DIR: cache,
			});
			expect(parseYamllint(r)).toMatchObject({
				unavailable: expect.stringMatching(/^error: No solution found/),
			});
		},
		TIMEOUT,
	);

	test(
		'yamllint --version печатает версию из константы',
		() => {
			const dir = fixture();
			// argv — из yamllintArgv с хвостом `-f parsable -c <config> .`, заменённым на `--version`.
			const r = spawnRunner(dir, testEnv())(
				uv,
				[...yamllintArgv('.yamllint').slice(0, -5), '--version'],
				dir,
			);
			expect(r.out.trim()).toBe(`yamllint ${YAMLLINT_VERSION}`);
		},
		TIMEOUT,
	);
});
