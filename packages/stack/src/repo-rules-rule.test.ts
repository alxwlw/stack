import { expect, test } from 'bun:test';

import type { Finding } from './findings.ts';
import type { RepoRulesOutcome } from './repo-rules.ts';
import { checkRepoRules, repoRulesGroup, repoRulesNotes } from './repo-rules-rule.ts';
import { fakeRepoRulesReader, groupContext, repoRulesRun, testCanon, testRepo } from './testkit.ts';

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

test('repoRulesNotes: причина пропуска diff — в скобках после skipped', () => {
	const clean = { violations: [], stale: [], notes: [] };
	expect(repoRulesNotes({ check: clean, diff: { skipped: 'not a pull request' } })).toStrictEqual([
		'repo-rules diff: skipped (not a pull request)',
	]);
	expect(
		repoRulesNotes({ check: clean, diff: { skipped: 'no --base outside GitHub Actions' } }),
	).toStrictEqual(['repo-rules diff: skipped (no --base outside GitHub Actions)']);
});

test('checkRepoRules: недоступная база PR — находка у diff с причиной базы', () => {
	const clean = { violations: [], stale: [], notes: [] };
	const reason = 'GITHUB_BASE_REF is empty in a pull_request job';
	expect(checkRepoRules({ check: clean, diff: { unavailable: reason } })).toStrictEqual([
		{ code: 'repo-rules-unavailable', target: 'repo-rules diff', message: reason },
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

test('repoRulesNotes: при недоступных частях — пусто', () => {
	expect(repoRulesNotes({ check: { unavailable: 'x' }, diff: { unavailable: 'y' } })).toStrictEqual(
		[],
	);
});

const RR_EMPTY = repoRulesRun(0, EMPTY);
const RR_LONG = repoRulesRun(1, {
	violations: [{ rule: 'max-lines', path: 'src/a.ts', line: 801, message: '812 lines' }],
	stale: [],
	notes: [],
});
const RR_REMOVED = repoRulesRun(1, {
	violations: [
		{ rule: 'removed-assertions', path: 'a.test.ts', line: 0, message: '−1 / +0 assertions' },
	],
	stale: [],
	notes: [],
});
const LONG: Finding = {
	code: 'repo-rules-violation',
	target: 'src/a.ts:801',
	message: 'max-lines: 812 lines',
};
const REMOVED: Finding = {
	code: 'repo-rules-violation',
	target: 'a.test.ts',
	message: 'removed-assertions: −1 / +0 assertions',
};

test('repoRulesGroup: база есть — check и diff через порт с окружением контекста', () => {
	const port = fakeRepoRulesReader(RR_EMPTY, RR_REMOVED);
	const env = { X: '1' };
	const ctx = groupContext(testRepo(testCanon()), { env, prBase: { base: 'origin/main' } });
	expect(repoRulesGroup(ctx, port.read)).toStrictEqual({ findings: [REMOVED], notes: [HINT] });
	expect(port.calls).toStrictEqual([
		{ argv: ['-C', '/r', 'check', '--json'], env },
		{ argv: ['-C', '/r', 'diff', '--json', '--base', 'origin/main'], env },
	]);
});

test('repoRulesGroup: база пропущена — один вызов, находки check и пометка о пропуске', () => {
	const port = fakeRepoRulesReader(RR_LONG);
	expect(repoRulesGroup(groupContext(testRepo(testCanon())), port.read)).toStrictEqual({
		findings: [LONG],
		notes: ['repo-rules diff: skipped (no --base outside GitHub Actions)'],
	});
	expect(port.calls).toHaveLength(1);
});

// Второе названное отличие вывода (решение 4 спека): repo-rules вне PR не стартует, check падает —
// находка у check, а пометка о пропуске diff называет причину базы.
test('repoRulesGroup: вне pull request check недоступен — находка и пометка с причиной пропуска', () => {
	const port = fakeRepoRulesReader({ code: 2, out: '', err: 'repo-rules: boom' });
	const ctx = groupContext(testRepo(testCanon()), { prBase: { skipped: 'not a pull request' } });
	expect(repoRulesGroup(ctx, port.read)).toStrictEqual({
		findings: [{ code: 'repo-rules-unavailable', target: 'repo-rules check', message: 'boom' }],
		notes: ['repo-rules diff: skipped (not a pull request)'],
	});
	expect(port.calls).toHaveLength(1);
});
