import { expect, test } from 'bun:test';

import { type GuardrailRun, spawnRunner } from './guardrails-port.ts';
import { parseShellcheck, QUIET_LEVELS, shellcheckArgv } from './guardrails-shellcheck.ts';
import { protoBin, repoDir, testEnv } from './testkit.ts';

const comment = (file: string, line: number, level: string, code: number) => ({
	file,
	line,
	endLine: line,
	column: 1,
	endColumn: 2,
	level,
	code,
	message: `message ${code}`,
	fix: null,
});
const json = (comments: unknown[]): string => JSON.stringify({ comments });
const run = (code: number, out: string, err = ''): GuardrailRun => ({ code, out, err });

test('shellcheckArgv: json1 и файлы как есть', () => {
	expect(shellcheckArgv(['a.sh', 'with space'])).toEqual([
		'-f',
		'json1',
		'--',
		'a.sh',
		'with space',
	]);
});

test('QUIET_LEVELS: info и style', () => {
	expect([...QUIET_LEVELS].sort()).toEqual(['info', 'style']);
});

test('parseShellcheck: error и warning — находки, info и style — нет', () => {
	const out = json([
		comment('a.sh', 2, 'error', 2045),
		comment('a.sh', 3, 'warning', 2128),
		comment('a.sh', 4, 'info', 2086),
		comment('a.sh', 5, 'style', 2006),
	]);
	expect(parseShellcheck(run(1, out))).toEqual([
		{ tool: 'shellcheck', rule: 'SC2045', path: 'a.sh', line: 2, message: 'message 2045' },
		{ tool: 'shellcheck', rule: 'SC2128', path: 'a.sh', line: 3, message: 'message 2128' },
	]);
});

test('parseShellcheck: код 1 и только info — пусто', () => {
	expect(parseShellcheck(run(1, json([comment('a.sh', 1, 'info', 2086)])))).toEqual([]);
});

test('parseShellcheck: код 0, пустой массив и stderr — пусто', () => {
	expect(parseShellcheck(run(0, json([]), 'noise'))).toEqual([]);
});

test('parseShellcheck: код 1 без комментариев — недоступность', () => {
	expect(parseShellcheck(run(1, json([])))).toEqual({
		unavailable: 'exited with 1 and reported nothing',
	});
});

test('parseShellcheck: код 2 — первая строка stderr', () => {
	const err = 'gone.sh: gone.sh: openBinaryFile: does not exist (No such file or directory)';
	expect(parseShellcheck(run(2, json([]), `${err}\n`))).toEqual({ unavailable: err });
});

test('parseShellcheck: не JSON', () => {
	expect(parseShellcheck(run(1, 'oops'))).toEqual({ unavailable: 'output is not JSON' });
});

test('parseShellcheck: форма вывода', () => {
	const shape = { unavailable: 'output has an unexpected shape: comments' };
	expect(parseShellcheck(run(1, '{"comments":[{"file":"a.sh"}]}'))).toEqual(shape);
	expect(
		parseShellcheck(run(1, json([{ ...comment('a.sh', 1, 'error', 2045), code: '2045' }]))),
	).toEqual(shape);
	const base = comment('a.sh', 1, 'error', 2045);
	for (const bad of [{ file: 1 }, { line: '2' }, { level: 5 }, { message: null }]) {
		expect(parseShellcheck(run(1, json([{ ...base, ...bad }])))).toEqual(shape);
	}
	expect(parseShellcheck(run(1, '{"comments":[null]}'))).toEqual(shape);
	expect(parseShellcheck(run(1, '{}'))).toEqual(shape);
	expect(parseShellcheck(run(1, 'null'))).toEqual(shape);
	expect(parseShellcheck(run(1, '{"comments":[7]}'))).toEqual(shape);
});

test('parseShellcheck: незнакомый уровень — находка', () => {
	expect(parseShellcheck(run(1, json([comment('a.sh', 7, 'note', 1000)])))).toEqual([
		{ tool: 'shellcheck', rule: 'SC1000', path: 'a.sh', line: 7, message: 'message 1000' },
	]);
});

// Настоящий shellcheck, пиненный в корне стека.
function check(files: Record<string, string>, list: string[]) {
	const dir = repoDir(files);
	const r = spawnRunner(dir, testEnv())(protoBin('shellcheck'), shellcheckArgv(list));
	return parseShellcheck(r);
}
const pick = (v: ReturnType<typeof check>) =>
	Array.isArray(v) ? v.map(({ rule, path, line }) => ({ rule, path, line })) : undefined;

const X_SH = [
	'#!/bin/bash',
	'for f in $(ls ./*.txt); do echo "$f"; done',
	'arr=(a b); echo $arr',
	'echo $1',
	'echo "`date`"',
	'',
].join('\n');

test('shellcheck: настоящий бинарник, error и warning, info и style молчат', () => {
	expect(pick(check({ 'x.sh': X_SH }, ['x.sh']))).toEqual([
		{ rule: 'SC2045', path: 'x.sh', line: 2 },
		{ rule: 'SC2128', path: 'x.sh', line: 3 },
	]);
}, 30_000);

test('shellcheck: .shellcheckrc и директива действуют', () => {
	const x = X_SH.replace('for f', '# shellcheck disable=SC2045\nfor f');
	expect(check({ 'x.sh': x, '.shellcheckrc': 'disable=SC2128\n' }, ['x.sh'])).toEqual([]);
}, 30_000);

test('shellcheck: файл без расширения и имя с пробелом', () => {
	const v = check(
		{
			'bin/run': '#!/bin/sh -e\na=(x); echo "$a"\n',
			'with space': '#!/bin/bash\narr=(a b); echo $arr\n',
		},
		['bin/run', 'with space'],
	);
	const rows = pick(v) ?? [];
	// bin/run — диалект sh из шебанга: SC3030 (массивы в sh); SC2128 на тех же строках — тоже находка.
	expect(rows.filter((r) => r.path === 'bin/run').map((r) => r.rule)).toContain('SC3030');
	expect(rows.filter((r) => r.path === 'with space')).toEqual([
		{ rule: 'SC2128', path: 'with space', line: 2 },
	]);
}, 30_000);

test('shellcheck: файл с именем флага в корне проверяется', () => {
	const v = check({ '-x': '#!/bin/bash\ncd dir\n' }, ['-x']);
	expect(pick(v)).toEqual([{ rule: 'SC2164', path: '-x', line: 2 }]);
}, 30_000);

test('shellcheck: source без -x — info, не находка', () => {
	expect(
		check({ 'a.sh': '#!/bin/bash\nsource ./other.sh\n', 'other.sh': 'true\n' }, ['a.sh']),
	).toEqual([]);
}, 30_000);
