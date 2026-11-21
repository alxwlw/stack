import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { afterAll, describe, expect, test } from 'bun:test';

import { markdownFiles } from './guardrails-files.ts';
import {
	MARKDOWNLINT_BUNFIG,
	MARKDOWNLINT_RUNNER,
	markdownlintCommand,
	type MarkdownlintReport,
	type MarkdownlintResult,
	parseMarkdownlint,
} from './guardrails-markdownlint.ts';
import { type GuardrailRun, spawnRunner } from './guardrails-port.ts';
import { canonFile, repoDir } from './testkit.ts';

const DEPENDENCY = (
	JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8')) as {
		dependencies: Record<string, string>;
	}
).dependencies['markdownlint-cli2'];

const result = (over: Partial<MarkdownlintResult> = {}): MarkdownlintResult => ({
	fileName: 'README.md',
	lineNumber: 3,
	ruleNames: ['MD040', 'fenced-code-language'],
	ruleDescription: 'Fenced code blocks should have a language specified',
	errorDetail: null,
	severity: 'error',
	...over,
});

const report = (over: Partial<MarkdownlintReport> = {}): MarkdownlintReport => ({
	version: '9.8.7',
	code: 1,
	formatted: true,
	results: [result({ errorDetail: 'Context: "```"' })],
	...over,
});

const run = (body: unknown, over: Partial<GuardrailRun> = {}): GuardrailRun => ({
	code: 0,
	out: typeof body === 'string' ? body : `${JSON.stringify(body)}\n`,
	err: '',
	...over,
});

describe('команда, файлы', () => {
	test('markdownlintCommand: bun-процесс с раннером stack, файл раннера существует', () => {
		expect(markdownlintCommand()).toStrictEqual({
			cmd: process.execPath,
			argv: ['--no-install', `--config=${MARKDOWNLINT_BUNFIG}`, MARKDOWNLINT_RUNNER],
		});
		expect(existsSync(MARKDOWNLINT_BUNFIG)).toBe(true);
		expect(isAbsolute(MARKDOWNLINT_BUNFIG)).toBe(true);
		expect(MARKDOWNLINT_RUNNER.endsWith('/markdownlint-run.ts')).toBe(true);
		expect(existsSync(MARKDOWNLINT_RUNNER)).toBe(true);
	});

	test('markdownFiles: .md и .mdx по basename, регистр важен, порядок входа', () => {
		expect(markdownFiles(['a.md', 'b/c.mdx', 'd.MD', 'e.md.bak', 'f.markdown'])).toStrictEqual([
			'a.md',
			'b/c.mdx',
		]);
	});
});

describe('parseMarkdownlint', () => {
	test('результат error: правило — первое имя, сообщение с деталью в скобках', () => {
		expect(parseMarkdownlint(run(report()))).toStrictEqual({
			version: '9.8.7',
			violations: [
				{
					tool: 'markdownlint-cli2',
					rule: 'MD040',
					path: 'README.md',
					line: 3,
					message: 'Fenced code blocks should have a language specified [Context: "```"]',
				},
			],
		});
	});

	test('errorDetail null — сообщение без скобок', () => {
		const parsed = parseMarkdownlint(run(report({ results: [result({ lineNumber: 7 })] })));
		expect(parsed).toMatchObject({
			violations: [{ line: 7, message: 'Fenced code blocks should have a language specified' }],
		});
	});

	test('результат warning при коде 0 — находка', () => {
		const parsed = parseMarkdownlint(
			run(report({ code: 0, results: [result({ severity: 'warning', fileName: 'w.md' })] })),
		);
		expect(parsed).toMatchObject({ violations: [{ rule: 'MD040', path: 'w.md', line: 3 }] });
	});

	test('нет результатов и код 0 — пустой список, порядок результатов сохранён', () => {
		expect(parseMarkdownlint(run(report({ code: 0, results: [] })))).toStrictEqual({
			version: '9.8.7',
			violations: [],
		});
		const two = report({
			results: [result({ fileName: 'b.md', lineNumber: 5 }), result({ fileName: 'a.md' })],
		});
		const parsed = parseMarkdownlint(run(two));
		if ('unavailable' in parsed) throw new Error(parsed.unavailable);
		expect(parsed.violations.map((v) => `${v.path}:${v.line}`)).toStrictEqual(['b.md:5', 'a.md:3']);
	});

	test('код процесса не 0 — недоступность со строкой stderr', () => {
		const err =
			"Unable to use configuration file '/c/.markdownlint-cli2.jsonc'; Unable to parse JSONC content\n";
		expect(parseMarkdownlint(run('', { code: 2, err }))).toStrictEqual({
			unavailable:
				"Unable to use configuration file '/c/.markdownlint-cli2.jsonc'; Unable to parse JSONC content",
		});
		expect(parseMarkdownlint(run('', { code: 3 }))).toStrictEqual({ unavailable: 'exited with 3' });
	});

	test('stdout не JSON', () => {
		expect(parseMarkdownlint(run('garbage'))).toStrictEqual({ unavailable: 'output is not JSON' });
	});

	test('не та форма отчёта или результата', () => {
		const shape = { unavailable: 'output has an unexpected shape: report' };
		expect(parseMarkdownlint(run([]))).toStrictEqual(shape);
		expect(parseMarkdownlint(run({ ...report(), version: 1 }))).toStrictEqual(shape);
		expect(parseMarkdownlint(run({ ...report(), formatted: 'yes' }))).toStrictEqual(shape);
		expect(parseMarkdownlint(run({ ...report(), results: {} }))).toStrictEqual(shape);
		expect(
			parseMarkdownlint(run(report({ results: [{ ...result(), ruleNames: [] }] }))),
		).toStrictEqual(shape);
		expect(
			parseMarkdownlint(run(report({ results: [{ ...result(), lineNumber: '3' } as never] }))),
		).toStrictEqual(shape);
		expect(
			parseMarkdownlint(run(report({ results: [{ ...result(), errorDetail: 5 } as never] }))),
		).toStrictEqual(shape);
	});

	test('code 2 — нет globs', () => {
		expect(parseMarkdownlint(run(report({ code: 2, results: [] })))).toStrictEqual({
			unavailable: 'no globs: the markdownlint-cli2 config is missing or lists none',
		});
	});

	test('code вне 0, 1 и 2', () => {
		expect(parseMarkdownlint(run(report({ code: 3, results: [] })))).toStrictEqual({
			unavailable: 'markdownlint-cli2 returned 3',
		});
	});

	test('formatted false — отчёта о результатах нет', () => {
		expect(
			parseMarkdownlint(run(report({ formatted: false, code: 0, results: [] }))),
		).toStrictEqual({ unavailable: 'markdownlint-cli2 did not report results' });
	});

	test('несогласованность: код 1 без error и код 0 с error', () => {
		expect(parseMarkdownlint(run(report({ code: 1, results: [] })))).toStrictEqual({
			unavailable: 'markdownlint-cli2 exited with 1 and reported nothing',
		});
		expect(
			parseMarkdownlint(run(report({ code: 1, results: [result({ severity: 'warning' })] }))),
		).toStrictEqual({ unavailable: 'markdownlint-cli2 exited with 1 and reported nothing' });
		expect(parseMarkdownlint(run(report({ code: 0 })))).toStrictEqual({
			unavailable: 'markdownlint-cli2 exited with 0 and reported an error',
		});
	});
});

describe('настоящий раннер', () => {
	const TIMEOUT = 30_000;
	const dirs: string[] = [];
	afterAll(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
	});

	const BAD = '# T\n\n```\nx\n```\n';
	const fixture = (files: Record<string, string>): string => {
		const dir = repoDir(files);
		dirs.push(dir);
		return dir;
	};
	const runIn = (dir: string) => {
		const { cmd, argv } = markdownlintCommand();
		return spawnRunner(dir)(cmd, argv, dir);
	};
	const parsed = (dir: string) => {
		const p = parseMarkdownlint(runIn(dir));
		if ('unavailable' in p) throw new Error(p.unavailable);
		return p;
	};

	const CANON_FILES = {
		'.markdownlint-cli2.jsonc': canonFile('.markdownlint-cli2.jsonc'),
		'doc.md': BAD,
	};
	const FINDING = [{ rule: 'MD040', path: 'doc.md', line: 3 }];

	test.each([
		['preload отсутствующего файла', 'preload = ["./missing.ts"]\n', {}],
		[
			'preload файла, который бросает',
			'preload = ["./boom.ts"]\n',
			{ 'boom.ts': "throw new Error('boom');\n" },
		],
	])(
		'bunfig копии с preload не ломает раннер: %s',
		(_name, bunfig, extra) => {
			const dir = fixture({ ...CANON_FILES, 'bunfig.toml': bunfig, ...extra });
			const { violations } = parsed(dir);
			expect(violations).toMatchObject(FINDING);
			expect(violations).toHaveLength(1);
		},
		TIMEOUT,
	);

	test(
		'bunfig пользователя не мешает (охрана: bun его и так не читает)',
		() => {
			const home = mkdtempSync(join(tmpdir(), 'stack-mdhome-'));
			dirs.push(home);
			writeFileSync(join(home, '.bunfig.toml'), 'preload = ["./missing.ts"]\n');
			const dir = fixture(CANON_FILES);
			const { cmd, argv } = markdownlintCommand();
			const r = spawnRunner(dir)(cmd, argv, dir, { HOME: home, XDG_CONFIG_HOME: home });
			const p = parseMarkdownlint(r);
			if ('unavailable' in p) throw new Error(p.unavailable);
			expect(p.violations).toMatchObject(FINDING);
			expect(p.violations).toHaveLength(1);
		},
		TIMEOUT,
	);

	test(
		'канонный конфиг: игнор-файл и канонные ignores действуют, файлы с пробелом и # — находки',
		() => {
			const dir = fixture({
				'.markdownlint-cli2.jsonc': canonFile('.markdownlint-cli2.jsonc'),
				'.markdownlintignore': 'ignored-by-mli/\n',
				'README.md': BAD,
				'with space.md': BAD,
				'#hash.md': BAD,
				'docs/plans/p.md': BAD,
				'ignored-by-mli/x.md': BAD,
				'clean.md': '# T\n',
			});
			const { violations } = parsed(dir);
			expect(violations.map((v) => `${v.path}:${v.line} ${v.rule}`).sort()).toStrictEqual([
				'#hash.md:3 MD040',
				'README.md:3 MD040',
				'with space.md:3 MD040',
			]);
		},
		TIMEOUT,
	);

	test(
		'правило со степенью warning — находка при коде 0',
		() => {
			const dir = fixture({
				'.markdownlint-cli2.jsonc':
					'{ "globs": ["**/*.md"], "config": { "default": false, "MD040": "warning" } }',
				'a.md': BAD,
			});
			const r = runIn(dir);
			expect(JSON.parse(r.out)).toMatchObject({ code: 0, formatted: true });
			const { violations } = parsed(dir);
			expect(violations).toMatchObject([{ rule: 'MD040', path: 'a.md', line: 3 }]);
			expect(violations).toHaveLength(1);
		},
		TIMEOUT,
	);

	test(
		'"fix": true в конфиге репозитория файл не переписывает (правило с автоисправлением)',
		() => {
			const FIXABLE = '#T\n';
			const dir = fixture({
				'.markdownlint-cli2.jsonc':
					'{ "globs": ["**/*.md"], "fix": true, "config": { "default": false, "MD018": true } }',
				'a.md': FIXABLE,
				'b.md': FIXABLE,
			});
			const { violations } = parsed(dir);
			expect(violations).toMatchObject([
				{ rule: 'MD018', path: 'a.md', line: 1 },
				{ rule: 'MD018', path: 'b.md', line: 1 },
			]);
			expect(readFileSync(join(dir, 'a.md'), 'utf8')).toBe(FIXABLE);
			expect(readFileSync(join(dir, 'b.md'), 'utf8')).toBe(FIXABLE);
		},
		TIMEOUT,
	);

	test(
		'битый конфиг — недоступность Unable to use configuration file',
		() => {
			const dir = fixture({ '.markdownlint-cli2.jsonc': '{ "globs": [', 'a.md': BAD });
			expect(parseMarkdownlint(runIn(dir))).toMatchObject({
				unavailable: expect.stringMatching(/^Unable to use configuration file/),
			});
		},
		TIMEOUT,
	);

	test(
		'конфига нет — no globs, а не «чисто»',
		() => {
			const dir = fixture({ 'a.md': BAD });
			expect(parseMarkdownlint(runIn(dir))).toStrictEqual({
				unavailable: 'no globs: the markdownlint-cli2 config is missing or lists none',
			});
		},
		TIMEOUT,
	);

	test(
		'customRules с пакетом, которого нет, — недоступность, а не «чисто»',
		() => {
			const dir = fixture({
				'.markdownlint-cli2.jsonc':
					'{ "globs": ["**/*.md"], "customRules": ["markdownlint-rule-nope"] }',
				'a.md': BAD,
			});
			expect(parseMarkdownlint(runIn(dir))).toMatchObject({
				unavailable: expect.stringContaining("Unable to import module 'markdownlint-rule-nope'"),
			});
		},
		TIMEOUT,
	);

	test(
		'версия отчёта равна dependencies markdownlint-cli2 пакета stack',
		() => {
			const dir = fixture({
				'.markdownlint-cli2.jsonc': '{ "globs": ["**/*.md"] }',
				'a.md': '# T\n',
			});
			expect(DEPENDENCY).toMatch(/^\d+\.\d+\.\d+$/);
			expect(parsed(dir).version).toBe(DEPENDENCY ?? '');
		},
		TIMEOUT,
	);
});
