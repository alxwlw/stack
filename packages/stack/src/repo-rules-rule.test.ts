import { expect, test } from 'bun:test';

import type { RepoRulesOutcome } from './repo-rules.ts';
import { checkRepoRules, repoRulesNotes } from './repo-rules-rule.ts';

const EMPTY = { violations: [], stale: [], notes: [] };
const HINT =
	'repo-rules diff: intended? add a commit trailer "Tests-Removed: <reason>" in the range';

test('checkRepoRules: нарушения и устаревшие записи check, затем нарушение diff', () => {
	const outcome: RepoRulesOutcome = {
		check: {
			violations: [{ rule: 'max-lines', path: 'src/a.ts', line: 801, message: '812 lines' }],
			stale: [{ rule: 'suppression-reason', path: 'src/b.ts', baseline: 2, actual: 1 }],
			notes: [],
		},
		diff: {
			violations: [
				{ rule: 'removed-assertions', path: 'a.test.ts', line: 0, message: '−2 / +0 assertions' },
			],
			stale: [],
			notes: [],
		},
	};
	expect(checkRepoRules(outcome)).toStrictEqual([
		{ code: 'repo-rules-violation', target: 'src/a.ts:801', message: 'max-lines: 812 lines' },
		{
			code: 'stale-repo-rules-baseline',
			target: 'src/b.ts',
			message: 'suppression-reason: recorded 2, now 1; lower it with: stack repo-rules baseline',
		},
		{
			code: 'repo-rules-violation',
			target: 'a.test.ts',
			message: 'removed-assertions: −2 / +0 assertions',
		},
	]);
});

test('checkRepoRules: обе части недоступны — две находки с разными целями', () => {
	expect(checkRepoRules({ check: { unavailable: 'x' }, diff: { unavailable: 'y' } })).toStrictEqual(
		[
			{ code: 'repo-rules-unavailable', target: 'repo-rules check', message: 'x' },
			{ code: 'repo-rules-unavailable', target: 'repo-rules diff', message: 'y' },
		],
	);
});

test('checkRepoRules: чистый check и пропущенный diff — находок нет', () => {
	expect(checkRepoRules({ check: EMPTY, diff: { skipped: 's' } })).toStrictEqual([]);
});

test('checkRepoRules: группа включена, исхода нет — Error', () => {
	expect(() => checkRepoRules(undefined)).toThrow(
		new Error('checkRepoRules: no repo-rules outcome'),
	);
});

test('repoRulesNotes: пропуск diff — одна строка', () => {
	expect(repoRulesNotes({ check: EMPTY, diff: { skipped: 'skipped (x)' } })).toStrictEqual([
		'repo-rules diff: skipped (x)',
	]);
});

test('repoRulesNotes: пометки diff и подсказка про трейлер только при нарушениях', () => {
	const violation = { rule: 'removed-assertions', path: 'a.test.ts', line: 0, message: 'm' };
	expect(
		repoRulesNotes({ check: EMPTY, diff: { violations: [violation], stale: [], notes: ['n1'] } }),
	).toStrictEqual(['repo-rules diff: n1', HINT]);
	expect(
		repoRulesNotes({ check: EMPTY, diff: { ...EMPTY, notes: ['Tests-Removed: moved'] } }),
	).toStrictEqual(['repo-rules diff: Tests-Removed: moved']);
});

test('repoRulesNotes: пометки check получают префикс', () => {
	expect(
		repoRulesNotes({ check: { ...EMPTY, notes: ['c1'] }, diff: { unavailable: 'y' } }),
	).toStrictEqual(['repo-rules check: c1']);
});

test('repoRulesNotes: без исхода и при недоступных частях — пусто', () => {
	expect(repoRulesNotes(undefined)).toStrictEqual([]);
	expect(repoRulesNotes({ check: { unavailable: 'x' }, diff: { unavailable: 'y' } })).toStrictEqual(
		[],
	);
});
