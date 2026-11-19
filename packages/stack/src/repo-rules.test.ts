import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { main } from '@alxwlw/repo-rules';
import { afterAll, beforeAll, expect, test } from 'bun:test';

import {
	DIFF_SKIPPED_NO_BASE,
	readRepoRules,
	repoRulesCalls,
	repoRulesPart,
	type RepoRulesRun,
} from './repo-rules.ts';
import { git, gitRepo, isolateGitConfig, repoDir } from './testkit.ts';

const V = { rule: 'max-lines', path: 'src/a.ts', line: 801, message: '812 lines' };
const S = { rule: 'suppression-reason', path: 'src/b.ts', baseline: 2, actual: 1 };
const SHAPE_V = 'output has an unexpected shape: violations';
const SHAPE_S = 'output has an unexpected shape: stale';
const SHAPE_N = 'output has an unexpected shape: notes';
const json = (o: unknown) => JSON.stringify(o, null, 2);
const ok = (code: number, o: unknown): RepoRulesRun => ({ code, out: json(o), err: '' });

test('repoRulesCalls: --base уходит в diff и не уходит в check', () => {
	expect(repoRulesCalls('/r', 'origin/main', {})).toStrictEqual({
		check: ['-C', '/r', 'check', '--json'],
		diff: ['-C', '/r', 'diff', '--json', '--base', 'origin/main'],
	});
});

test('repoRulesCalls: без --base в GitHub Actions diff зовётся без базы', () => {
	expect(repoRulesCalls('/r', undefined, { GITHUB_ACTIONS: 'true' }).diff).toStrictEqual([
		'-C',
		'/r',
		'diff',
		'--json',
	]);
});

test.each([
	['не задано', {}],
	['пустая строка', { GITHUB_ACTIONS: '' }],
	['не true', { GITHUB_ACTIONS: '1' }],
	['только GITHUB_BASE_REF', { GITHUB_BASE_REF: 'main' }],
])('repoRulesCalls: без --base вне GitHub Actions (%s) diff не зовётся', (_name, env) => {
	expect(repoRulesCalls('/r', undefined, env).diff).toBeUndefined();
	expect(repoRulesCalls('/r', '', env).diff).toBeUndefined();
});

test('repoRulesPart: код 1 с нарушением и устаревшей записью — отчёт, лишние поля отброшены', () => {
	const run = ok(1, { violations: [{ ...V, extra: 1 }], stale: [S], notes: ['n'], more: true });
	expect(repoRulesPart(run)).toStrictEqual({ violations: [V], stale: [S], notes: ['n'] });
});

test('repoRulesPart: код 1 только с устаревшей записью — отчёт, не unavailable', () => {
	expect(repoRulesPart(ok(1, { violations: [], stale: [S], notes: [] }))).toStrictEqual({
		violations: [],
		stale: [S],
		notes: [],
	});
});

test('repoRulesPart: код 0 с пустыми списками — пустой отчёт', () => {
	expect(repoRulesPart(ok(0, { violations: [], stale: [], notes: [] }))).toStrictEqual({
		violations: [],
		stale: [],
		notes: [],
	});
});

test.each<[string, RepoRulesRun, string]>([
	[
		'код 1 без нарушений',
		ok(1, { violations: [], stale: [], notes: [] }),
		'exited with 1 and reported nothing',
	],
	['не JSON', { code: 0, out: 'Usage: repo-rules', err: '' }, 'output is not JSON'],
	['пустой вывод', { code: 0, out: '', err: '' }, 'output is not JSON'],
	['массив вместо объекта', ok(0, []), 'output has an unexpected shape: not an object'],
	['нет violations', ok(0, { stale: [], notes: [] }), 'output has an unexpected shape: violations'],
	[
		'строка в line',
		ok(1, { violations: [{ ...V, line: '801' }], stale: [], notes: [] }),
		'output has an unexpected shape: violations',
	],
	[
		'stale без actual',
		ok(1, { violations: [], stale: [{ rule: 'r', path: 'p', baseline: 1 }], notes: [] }),
		'output has an unexpected shape: stale',
	],
	[
		'notes не строки',
		ok(0, { violations: [], stale: [], notes: [1] }),
		'output has an unexpected shape: notes',
	],
	[
		'код 2 со строкой ошибки',
		{ code: 2, out: '', err: 'repo-rules: git merge-base failed: fatal: bad ref\nhint: x' },
		'git merge-base failed: fatal: bad ref',
	],
	[
		'код 2, первая строка пуста',
		{ code: 2, out: '', err: '\nrepo-rules: internal error: boom' },
		'internal error: boom',
	],
	['violations — объект', ok(0, { violations: {}, stale: [], notes: [] }), SHAPE_V],
	['stale — объект', ok(0, { violations: [], stale: {}, notes: [] }), SHAPE_S],
	['notes — объект', ok(0, { violations: [], stale: [], notes: {} }), SHAPE_N],
	['элемент violations — строка', ok(0, { violations: ['x'], stale: [], notes: [] }), SHAPE_V],
	['элемент violations — null', ok(0, { violations: [null], stale: [], notes: [] }), SHAPE_V],
	['элемент violations — массив', ok(0, { violations: [[]], stale: [], notes: [] }), SHAPE_V],
	[
		'rule нарушения — число',
		ok(0, { violations: [{ ...V, rule: 1 }], stale: [], notes: [] }),
		SHAPE_V,
	],
	[
		'path нарушения — число',
		ok(0, { violations: [{ ...V, path: 1 }], stale: [], notes: [] }),
		SHAPE_V,
	],
	[
		'message нарушения — число',
		ok(0, { violations: [{ ...V, message: 1 }], stale: [], notes: [] }),
		SHAPE_V,
	],
	['элемент stale — null', ok(0, { violations: [], stale: [null], notes: [] }), SHAPE_S],
	[
		'rule записи — число',
		ok(0, { violations: [], stale: [{ ...S, rule: 1 }], notes: [] }),
		SHAPE_S,
	],
	[
		'path записи — число',
		ok(0, { violations: [], stale: [{ ...S, path: 1 }], notes: [] }),
		SHAPE_S,
	],
	[
		'baseline записи — строка',
		ok(0, { violations: [], stale: [{ ...S, baseline: '2' }], notes: [] }),
		SHAPE_S,
	],
	[
		'actual записи — строка',
		ok(0, { violations: [], stale: [{ ...S, actual: '1' }], notes: [] }),
		SHAPE_S,
	],
	['код 2 без текста', { code: 2, out: '', err: '' }, 'exited with 2'],
	[
		'код 3 с JSON в out',
		{ code: 3, out: json({ violations: [], stale: [], notes: [] }), err: '' },
		'exited with 3',
	],
])('repoRulesPart: %s — unavailable', (_name, run, message) => {
	expect(repoRulesPart(run)).toStrictEqual({ unavailable: message });
});

// Порт, который записывает каждый вызов и отвечает по очереди.
function fakeReader(...runs: RepoRulesRun[]) {
	const calls: { argv: string[]; env: NodeJS.ProcessEnv }[] = [];
	return {
		calls,
		read: (argv: string[], env: NodeJS.ProcessEnv) => {
			calls.push({ argv, env });
			const run = runs[calls.length - 1];
			if (!run) throw new Error('лишний вызов порта');
			return run;
		},
	};
}

const EMPTY = { violations: [], stale: [], notes: [] };

test('readRepoRules: check, затем diff — оба с окружением порта; сбой diff не трогает отчёт check', () => {
	const env = { GITHUB_ACTIONS: 'true' };
	const r = fakeReader(ok(1, { ...EMPTY, violations: [V] }), {
		code: 2,
		out: '',
		err: 'repo-rules: boom',
	});
	expect(readRepoRules('/r', { read: r.read, env, base: undefined })).toStrictEqual({
		check: { ...EMPTY, violations: [V] },
		diff: { unavailable: 'boom' },
	});
	expect(r.calls.map((c) => c.argv)).toStrictEqual([
		['-C', '/r', 'check', '--json'],
		['-C', '/r', 'diff', '--json'],
	]);
	expect(r.calls.every((c) => c.env === env)).toBe(true);
});

test('readRepoRules: сбой check не отменяет diff', () => {
	const r = fakeReader({ code: 2, out: '', err: 'repo-rules: boom' }, ok(0, EMPTY));
	expect(readRepoRules('/r', { read: r.read, env: {}, base: 'origin/main' })).toStrictEqual({
		check: { unavailable: 'boom' },
		diff: EMPTY,
	});
});

test('readRepoRules: вне GitHub Actions без --base diff пропущен, порт зовётся один раз', () => {
	const r = fakeReader(ok(0, EMPTY));
	expect(readRepoRules('/r', { read: r.read, env: {}, base: undefined })).toStrictEqual({
		check: EMPTY,
		diff: { skipped: DIFF_SKIPPED_NO_BASE },
	});
	expect(r.calls).toHaveLength(1);
});

// Настоящий вызов repo-rules в форме порта.
const real = (argv: string[], env: NodeJS.ProcessEnv = {}): RepoRulesRun => {
	const out: string[] = [];
	const err: string[] = [];
	const code = main(
		argv,
		env,
		(s) => out.push(s),
		(s) => err.push(s),
	);
	return { code, out: out.join('\n'), err: err.join('\n') };
};

let restore: () => void;
beforeAll(() => {
	restore = isolateGitConfig();
});
afterAll(() => restore());

test('настоящий repo-rules: check --json читается как отчёт', () => {
	const { dir } = gitRepo({ 'a.test.ts': "test.only('x', () => {});\n" });
	expect(repoRulesPart(real(['-C', dir, 'check', '--json']))).toMatchObject({
		violations: [{ rule: 'focused-skipped-tests', path: 'a.test.ts', line: 1 }],
		stale: [],
	});
});

test('настоящий repo-rules: diff --json с базой читается как отчёт', () => {
	const { dir } = gitRepo({ 'a.test.ts': 'expect(1).toBe(1);\nexpect(1).toBe(1);\n' });
	writeFileSync(join(dir, 'a.test.ts'), 'expect(1).toBe(1);\n');
	git(dir, 'commit', '-am', 'drop');
	expect(repoRulesPart(real(['-C', dir, 'diff', '--json', '--base', 'origin/main']))).toMatchObject(
		{
			violations: [{ rule: 'removed-assertions', path: 'a.test.ts', line: 0 }],
		},
	);
});

test('настоящий repo-rules: каталог вне git — unavailable без префикса', () => {
	const part = repoRulesPart(real(['-C', repoDir({}), 'check', '--json']));
	expect(part).toHaveProperty('unavailable');
	expect((part as { unavailable: string }).unavailable.startsWith('git rev-parse failed')).toBe(
		true,
	);
});
