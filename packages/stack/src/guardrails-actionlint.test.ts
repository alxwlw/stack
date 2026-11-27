import { afterAll, beforeAll, expect, test } from 'bun:test';

import { actionlintArgv, parseActionlint } from './guardrails-actionlint.ts';
import { type GuardrailRun, spawnRunner } from './guardrails-port.ts';
import { gitRepo, isolateGitConfig, protoBin, put, testEnv } from './testkit.ts';

let restore = (): void => {};
beforeAll(() => {
	restore = isolateGitConfig();
});
afterAll(() => restore());

const run = (code: number, out: string, err = ''): GuardrailRun => ({ code, out, err });
const item = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
	message: 'bad expression',
	filepath: '.github/workflows/a.yml',
	line: 7,
	column: 3,
	kind: 'expression',
	snippet: '',
	end_column: 9,
	...over,
});
const out = (items: unknown[]): string => JSON.stringify(items);
const SHAPE = { unavailable: 'output has an unexpected shape: errors' };
const sc = (text: string) => `shellcheck reported issue in this script: ${text}`;

test('actionlintArgv: флаги до файлов, shellcheck пиненный', () => {
	expect(actionlintArgv('/x/sc', ['.github/workflows/b c.yml'])).toEqual([
		'-format',
		'{{json .}}',
		'-shellcheck=/x/sc',
		'-pyflakes=',
		'.github/workflows/b c.yml',
	]);
});

test('actionlintArgv: без shellcheck — явно выключен', () => {
	expect(actionlintArgv(undefined, ['a.yml'])).toContain('-shellcheck=');
	expect(actionlintArgv(undefined, ['a.yml'])).not.toContain('-shellcheck=undefined');
});

test('parseActionlint: код 0 и пустой stdout — пусто', () => {
	expect(parseActionlint(run(0, ''))).toEqual([]);
});

test('parseActionlint: код 0 и пустой массив — пусто', () => {
	expect(parseActionlint(run(0, '[]\n'))).toEqual([]);
});

test('parseActionlint: код 1 и пустой массив — недоступность', () => {
	expect(parseActionlint(run(1, '[]'))).toEqual({
		unavailable: 'exited with 1 and reported nothing',
	});
});

test('parseActionlint: код 1 и пустой stdout — не JSON', () => {
	expect(parseActionlint(run(1, ''))).toEqual({ unavailable: 'output is not JSON' });
});

test('parseActionlint: не JSON', () => {
	expect(parseActionlint(run(1, 'oops'))).toEqual({ unavailable: 'output is not JSON' });
});

test('parseActionlint: код 3 — первая строка stderr', () => {
	const err = 'could not read "x.yml": open x.yml: no such file or directory';
	expect(parseActionlint(run(3, '', `${err}\n`))).toEqual({ unavailable: err });
});

test('parseActionlint: код 2 без stderr', () => {
	expect(parseActionlint(run(2, ''))).toEqual({ unavailable: 'exited with 2' });
});

test('parseActionlint: прочие kind — правило kind, сообщение как есть', () => {
	expect(parseActionlint(run(1, out([item()])))).toEqual([
		{
			tool: 'actionlint',
			rule: 'expression',
			path: '.github/workflows/a.yml',
			line: 7,
			message: 'bad expression',
		},
	]);
});

test('parseActionlint: shellcheck уровня info — не находка', () => {
	const m = sc('SC2086:info:1:6: Double quote to prevent globbing and word splitting');
	expect(parseActionlint(run(1, out([item({ kind: 'shellcheck', message: m })])))).toEqual([]);
});

test('parseActionlint: shellcheck уровня style — не находка', () => {
	const m = sc('SC2006:style:1:6: Use $(...) notation instead of legacy backticks.');
	expect(parseActionlint(run(1, out([item({ kind: 'shellcheck', message: m })])))).toEqual([]);
});

test('parseActionlint: shellcheck уровня warning — SC-код и текст без префикса', () => {
	const m = sc("SC2164:warning:1:1: Use 'cd … || exit' in case cd fails.\nmore");
	expect(parseActionlint(run(1, out([item({ kind: 'shellcheck', message: m })])))).toEqual([
		{
			tool: 'actionlint',
			rule: 'SC2164',
			path: '.github/workflows/a.yml',
			line: 7,
			message: "Use 'cd … || exit' in case cd fails.\nmore",
		},
	]);
});

test('parseActionlint: shellcheck уровня error — находка', () => {
	const m = sc('SC2045:error:1:10: Iterating over ls output is fragile.');
	const v = parseActionlint(run(1, out([item({ kind: 'shellcheck', message: m })])));
	expect(Array.isArray(v) ? v.map((x) => x.rule) : v).toEqual(['SC2045']);
});

test('parseActionlint: shellcheck без префикса — правило shellcheck, сообщение целиком', () => {
	expect(
		parseActionlint(run(1, out([item({ kind: 'shellcheck', message: 'something odd' })]))),
	).toEqual([
		{
			tool: 'actionlint',
			rule: 'shellcheck',
			path: '.github/workflows/a.yml',
			line: 7,
			message: 'something odd',
		},
	]);
});

test('parseActionlint: форма — каждое обязательное поле и не-объекты', () => {
	for (const bad of [{ message: 5 }, { filepath: null }, { line: '7' }, { kind: 3 }]) {
		expect(parseActionlint(run(1, out([item(bad)])))).toEqual(SHAPE);
	}
	for (const missing of ['message', 'filepath', 'line', 'kind']) {
		const { [missing]: _drop, ...rest } = item();
		expect(parseActionlint(run(1, out([rest])))).toEqual(SHAPE);
	}
});

test('parseActionlint: форма — null и число в массиве', () => {
	expect(parseActionlint(run(1, '[null]'))).toEqual(SHAPE);
	expect(parseActionlint(run(1, '[7]'))).toEqual(SHAPE);
});

test('parseActionlint: форма — не массив', () => {
	expect(parseActionlint(run(1, '{}'))).toEqual(SHAPE);
	expect(parseActionlint(run(1, 'null'))).toEqual(SHAPE);
	expect(parseActionlint(run(0, '{"a":1}'))).toEqual(SHAPE);
});

test('parseActionlint: порядок как у инструмента', () => {
	const v = parseActionlint(
		run(1, out([item({ line: 9, kind: 'syntax-check' }), item({ line: 2, kind: 'expression' })])),
	);
	expect(Array.isArray(v) ? v.map((x) => `${x.line}:${x.rule}`) : v).toEqual([
		'9:syntax-check',
		'2:expression',
	]);
});

// Настоящие actionlint и shellcheck, пиненные в корне стека.
const WORKFLOW = [
	'on: push',
	'jobs:',
	'  j:',
	'    runs-on: ubuntu-latest',
	'    steps:',
	'      - run: echo "${{ github.event.foo( }}"',
	'      - run: echo $FOO',
	'      - run: for f in $(ls ./*.txt); do echo "$f"; done',
	'      - run: |',
	'          arr=(a b)',
	'          echo $arr',
	'',
].join('\n');
const A = '.github/workflows/a.yml';

function lint(files: Record<string, string>, list: string[], shellcheck = true) {
	const { dir } = gitRepo(files);
	const argv = actionlintArgv(shellcheck ? protoBin('shellcheck') : undefined, list);
	return parseActionlint(spawnRunner(dir, testEnv())(protoBin('actionlint'), argv));
}
const pick = (v: ReturnType<typeof lint>) =>
	Array.isArray(v) ? v.map(({ rule, path, line }) => ({ rule, path, line })) : v;

test('actionlint: настоящий бинарник, expression, error и warning, info молчит', () => {
	expect(pick(lint({ [A]: WORKFLOW }, [A]))).toEqual([
		{ rule: 'expression', path: A, line: 6 },
		{ rule: 'SC2045', path: A, line: 8 },
		{ rule: 'SC2128', path: A, line: 9 },
	]);
}, 30_000);

test('actionlint: без пиненного shellcheck — только expression', () => {
	const v = lint({ [A]: WORKFLOW }, [A], false);
	expect(Array.isArray(v) ? v.map((x) => x.rule) : v).toEqual(['expression']);
}, 30_000);

test('actionlint: битый YAML — syntax-check', () => {
	const bad = '.github/workflows/bad.yml';
	const v = lint({ [bad]: 'jobs:\n  j:\n   x: [' }, [bad]);
	expect(Array.isArray(v) ? v.map((x) => x.rule) : v).toEqual(['syntax-check']);
	expect(Array.isArray(v) ? v[0]?.message.startsWith('could not parse as YAML') : v).toBe(true);
}, 30_000);

test('actionlint: игнор путей в конфиге репозитория действует для своего файла', () => {
	const spaced = '.github/workflows/b c.yml';
	const config = [
		'paths:',
		`  ${A}:`,
		'    ignore:',
		"      - 'shellcheck reported issue in this script: SC2045:.+'",
		'',
	].join('\n');
	const v = lint({ [A]: WORKFLOW, [spaced]: WORKFLOW, '.github/actionlint.yaml': config }, [
		A,
		spaced,
	]);
	const rows = pick(v);
	expect(Array.isArray(rows) ? rows.filter((r) => r.path === A).map((r) => r.rule) : rows).toEqual([
		'expression',
		'SC2128',
	]);
	expect(
		Array.isArray(rows) ? rows.filter((r) => r.path === spaced).map((r) => r.rule) : rows,
	).toEqual(['expression', 'SC2045', 'SC2128']);
}, 30_000);

test('actionlint: имя с пробелом — один аргумент, свои нарушения', () => {
	const spaced = '.github/workflows/b c.yml';
	const { dir } = gitRepo({ 'seed.txt': 'seed\n' });
	put(dir, spaced, WORKFLOW);
	const argv = actionlintArgv(protoBin('shellcheck'), [spaced]);
	const v = parseActionlint(spawnRunner(dir, testEnv())(protoBin('actionlint'), argv));
	expect(Array.isArray(v) ? v.map((x) => x.path) : v).toEqual([spaced, spaced, spaced]);
}, 30_000);
