import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { toolVersion } from './guardrails-bin.ts';
import { hadolintArgv, parseHadolint, shortReason } from './guardrails-hadolint.ts';
import { type GuardrailRun, spawnRunner } from './guardrails-port.ts';
import { protoBin, repoDir } from './testkit.ts';

const run = (out: string, over: Partial<GuardrailRun> = {}): GuardrailRun => ({
	code: 0,
	out,
	err: '',
	...over,
});
const item = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
	code: 'DL3025',
	column: 1,
	file: 'Dockerfile',
	level: 'warning',
	line: 4,
	message: 'Use arguments JSON notation for CMD and ENTRYPOINT arguments',
	...over,
});

describe('аргументы', () => {
	test('json, --no-fail и -- перед путями, порядок путей сохранён', () => {
		expect(hadolintArgv(['Dockerfile', '-x.Dockerfile'])).toStrictEqual([
			'-f',
			'json',
			'--no-fail',
			'--',
			'Dockerfile',
			'-x.Dockerfile',
		]);
	});
});

describe('parseHadolint', () => {
	test('пустой массив — нет находок', () => {
		expect(parseHadolint(run('[]'))).toStrictEqual([]);
	});

	test('error и warning — находки, info и style отброшены', () => {
		const out = JSON.stringify([
			item({ code: 'DL1000', level: 'error', file: 'a/Dockerfile', line: 2, message: 'm-error' }),
			item({ code: 'DL3025', level: 'warning', file: 'b/Dockerfile', line: 5, message: 'm-warn' }),
			item({ code: 'DL3066', level: 'info', line: 3, message: 'm-info' }),
			item({ code: 'DL3059', level: 'style', line: 7, message: 'm-style' }),
		]);
		expect(parseHadolint(run(out))).toStrictEqual([
			{ tool: 'hadolint', rule: 'DL1000', path: 'a/Dockerfile', line: 2, message: 'm-error' },
			{ tool: 'hadolint', rule: 'DL3025', path: 'b/Dockerfile', line: 5, message: 'm-warn' },
		]);
	});

	test('непустой stderr при коде 0 — недоступность с первой непустой строкой', () => {
		const line =
			"Error parsing your config file in  '/c/.hadolint.yaml': YAML parse exception at x";
		expect(parseHadolint(run('[]', { err: `\n${line}\nвторая строка\n` }))).toStrictEqual({
			unavailable: line,
		});
	});

	describe('сломанный конфиг — первая строка до литерального \\n', () => {
		const head = "Error parsing your config file in  '/c/.hadolint.yaml':";
		const tail = 'AesonException "Error in $.ignored: expected Text"';
		const literal = `${head}\\n${tail}\\n`;
		const real = `${head}\n${tail}\n`;
		test.each([
			['код 1, литерал', run('', { code: 1, err: literal })],
			['код 1, перевод строки', run('', { code: 1, err: real })],
			['код 0, литерал', run('[]', { err: literal })],
			['код 0, перевод строки', run('[]', { err: real })],
		])('%s', (_name, r) => {
			expect(parseHadolint(r)).toStrictEqual({ unavailable: head });
		});
	});

	test('shortReason: до литерала или перевода строки, без пробелов по краям', () => {
		expect(shortReason('  a b \\n c')).toBe('a b');
		expect(shortReason('a\nb')).toBe('a');
		expect(shortReason('a\\nb\nc')).toBe('a');
		expect(shortReason('plain')).toBe('plain');
	});

	test('код 1 и пустой stdout — недоступность со строкой stderr', () => {
		const err =
			'hadolint: missing.Dockerfile: withBinaryFile: does not exist (No such file or directory)';
		expect(parseHadolint(run('', { code: 1, err: `${err}\n` }))).toStrictEqual({
			unavailable: err,
		});
		expect(parseHadolint(run('', { code: 1 }))).toStrictEqual({ unavailable: 'exited with 1' });
	});

	test('не JSON, в том числе JSON с приклеенным tty-выводом', () => {
		expect(parseHadolint(run('x'))).toStrictEqual({ unavailable: 'output is not JSON' });
		expect(parseHadolint(run('[]\nDockerfile:5 DL3025 warning: m\n'))).toStrictEqual({
			unavailable: 'output is not JSON',
		});
	});

	test.each([
		['не массив', '{}'],
		['элемент не объект', '[1]'],
		['элемент null', '[null]'],
		['без line', JSON.stringify([item({ line: undefined })])],
		['line строкой', JSON.stringify([item({ line: '4' })])],
		['без code', JSON.stringify([item({ code: undefined })])],
		['без file', JSON.stringify([item({ file: undefined })])],
		['без message', JSON.stringify([item({ message: undefined })])],
		['level fatal', JSON.stringify([item({ level: 'fatal' })])],
		[
			'info-находка после битого элемента',
			JSON.stringify([item({ level: 'info' }), item({ line: null })]),
		],
	])('форма: %s', (_name, out) => {
		expect(parseHadolint(run(out))).toStrictEqual({
			unavailable: 'output has an unexpected shape: findings',
		});
	});
});

describe('toolVersion hadolint', () => {
	test('первая строка Haskell Dockerfile Linter <версия>; голая версия не принимается', () => {
		expect(toolVersion('hadolint', 'Haskell Dockerfile Linter 2.15.1\n')).toBe('2.15.1');
		expect(toolVersion('hadolint', '2.15.1\n')).toBeUndefined();
		expect(toolVersion('hadolint', 'noise\nHaskell Dockerfile Linter 2.15.1\n')).toBeUndefined();
	});
});

describe('настоящий hadolint', () => {
	const TIMEOUT = 30_000;
	const DOCKERFILE = [
		'FROM alpine:3.20',
		'RUN adduser -D app',
		'USER app',
		'HEALTHCHECK CMD wget -q http://localhost/ || exit 1',
		'CMD node server.js',
		'',
	].join('\n');
	let bin = '';
	const dirs: string[] = [];
	beforeAll(() => {
		bin = protoBin('hadolint');
	});
	afterAll(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
	});

	// Запуск как в читателе: cwd — каталог, HOME и XDG_CONFIG_HOME — новый пустой каталог.
	function lint(files: Record<string, string>, names: string[] = ['Dockerfile']) {
		const dir = repoDir(files);
		const home = mkdtempSync(join(tmpdir(), 'stack-home-test-'));
		dirs.push(dir, home);
		const r = spawnRunner(dir)(bin, hadolintArgv(names), dir, {
			HOME: home,
			XDG_CONFIG_HOME: home,
		});
		return { r, parsed: parseHadolint(r) };
	}
	const hits = (parsed: ReturnType<typeof parseHadolint>) => {
		if (!Array.isArray(parsed)) throw new Error(JSON.stringify(parsed));
		return parsed.map((v) => `${v.rule} ${v.path}:${v.line}`);
	};
	const TWO = ['DL3025 Dockerfile:4', 'DL3025 Dockerfile:5'];

	test(
		'без конфига: DL3025 на строках 4 и 5, info DL3066 порог не проходит',
		() => {
			expect(hits(lint({ Dockerfile: DOCKERFILE }).parsed)).toStrictEqual(TWO);
		},
		TIMEOUT,
	);

	test(
		'failure-threshold конфига состав находок не меняет',
		() => {
			const { parsed } = lint({
				Dockerfile: DOCKERFILE,
				'.hadolint.yaml': 'failure-threshold: error\n',
			});
			expect(hits(parsed)).toStrictEqual(TWO);
		},
		TIMEOUT,
	);

	test(
		'override до info и ignored гасят находку',
		() => {
			expect(
				lint({ Dockerfile: DOCKERFILE, '.hadolint.yaml': 'override:\n  info: [DL3025]\n' }).parsed,
			).toStrictEqual([]);
			expect(
				lint({ Dockerfile: DOCKERFILE, '.hadolint.yaml': 'ignored: [DL3025]\n' }).parsed,
			).toStrictEqual([]);
		},
		TIMEOUT,
	);

	test(
		'битый YAML конфига — недоступность, а не прогон с конфигом по умолчанию',
		() => {
			const { r, parsed } = lint({
				Dockerfile: DOCKERFILE,
				'.hadolint.yaml': 'ignored: [DL3025\n',
			});
			expect(r.code).toBe(0);
			// hadolint 2.15.1 печатает сообщение одной строкой в кавычках Haskell (`"Error parsing …\n…"`).
			expect(parsed).toMatchObject({
				unavailable: expect.stringMatching(/^"?Error parsing your config file in /),
			});
		},
		TIMEOUT,
	);

	test(
		'HADOLINT_IGNORE и HADOLINT_FORMAT=tty в окружении родителя не действуют',
		() => {
			const saved = { ignore: process.env.HADOLINT_IGNORE, format: process.env.HADOLINT_FORMAT };
			process.env.HADOLINT_IGNORE = 'DL3025';
			process.env.HADOLINT_FORMAT = 'tty';
			try {
				expect(hits(lint({ Dockerfile: DOCKERFILE }).parsed)).toStrictEqual(TWO);
			} finally {
				if (saved.ignore === undefined) Reflect.deleteProperty(process.env, 'HADOLINT_IGNORE');
				else process.env.HADOLINT_IGNORE = saved.ignore;
				if (saved.format === undefined) Reflect.deleteProperty(process.env, 'HADOLINT_FORMAT');
				else process.env.HADOLINT_FORMAT = saved.format;
			}
		},
		TIMEOUT,
	);

	test(
		'имена с дефисом в начале и с пробелом разбираются как пути',
		() => {
			const names = ['-x.Dockerfile', 'with space.Dockerfile'];
			const { parsed } = lint(
				{ '-x.Dockerfile': DOCKERFILE, 'with space.Dockerfile': DOCKERFILE },
				names,
			);
			expect(hits(parsed)).toStrictEqual([
				'DL3025 -x.Dockerfile:4',
				'DL3025 -x.Dockerfile:5',
				'DL3025 with space.Dockerfile:4',
				'DL3025 with space.Dockerfile:5',
			]);
		},
		TIMEOUT,
	);
});
