import { afterAll, describe, expect, test } from 'bun:test';

import { loadConfig } from './config.mjs';
import { countPairs, judge, removedAssertions } from './diff.mjs';
import { matcher } from './glob.mjs';
import { cleanup, repo } from './testkit.ts';

afterAll(cleanup);

const T3 =
	'test("a", () => {\n  expect(1).toBe(1);\n  expect(2).toBe(2);\n  expect(3).toBe(3);\n});\n';
const T1 = 'test("a", () => {\n  expect(1).toBe(1);\n});\n';
const noEnv = {};

/** A repo on `main` with `files`, then branch `feat` with `change` applied and committed. */
function branch(files: Record<string, string>, change: (r: ReturnType<typeof repo>) => void) {
	const r = repo(files);
	r.git('checkout', '-q', '-b', 'feat');
	change(r);
	return r;
}

describe('removedAssertions', () => {
	test('fewer assertions in a modified test file', () => {
		const r = branch({ 'src/a.test.ts': T3 }, (r) => {
			r.write({ 'src/a.test.ts': T1 });
			r.commit('weaken');
		});
		const res = removedAssertions(r.root, loadConfig(r.root), 'main', noEnv);
		expect(res.violations).toEqual([{ path: 'src/a.test.ts', removed: 2, added: 0 }]);
	});
	test('more or equal assertions, and non-test files, pass', () => {
		const r = branch({ 'src/a.test.ts': T1, 'src/a.ts': 'expect(1);\nexpect(2);\n' }, (r) => {
			r.write({ 'src/a.test.ts': T3, 'src/a.ts': '' });
			r.commit('more');
		});
		expect(removedAssertions(r.root, loadConfig(r.root), 'main', noEnv).violations).toEqual([]);
	});
	test('a plain rename moves nothing', () => {
		const r = branch({ 'src/a.test.ts': T3 }, (r) => {
			r.git('mv', 'src/a.test.ts', 'src/b.test.ts');
			r.commit('rename');
		});
		expect(removedAssertions(r.root, loadConfig(r.root), 'main', noEnv).violations).toEqual([]);
	});
	test('a deleted test file is judged against the new test files of the range', () => {
		const moved = branch({ 'src/old.test.ts': T3 }, (r) => {
			r.git('rm', '-q', 'src/old.test.ts');
			r.write({ 'src/new.test.ts': `// rewritten\n${T3.replace(/\(\d\)/g, '(9)')}extra();\n` });
			r.commit('rewrite under a new name');
		});
		expect(removedAssertions(moved.root, loadConfig(moved.root), 'main', noEnv).violations).toEqual(
			[],
		);
		const dropped = branch({ 'src/old.test.ts': T3 }, (r) => {
			r.git('rm', '-q', 'src/old.test.ts');
			r.commit('drop');
		});
		expect(
			removedAssertions(dropped.root, loadConfig(dropped.root), 'main', noEnv).violations,
		).toEqual([{ path: 'src/old.test.ts (deleted)', removed: 3, added: 0 }]);
	});
	test('a Tests-Removed trailer anywhere in the range clears it and is reported', () => {
		const r = branch({ 'src/a.test.ts': T3 }, (r) => {
			r.write({ 'src/a.test.ts': T1 });
			r.commit('weaken', 'Tests-Removed: duplicates of the first check');
			r.commit('later');
		});
		const res = removedAssertions(r.root, loadConfig(r.root), 'main', noEnv);
		expect(res.violations).toEqual([]);
		expect(res.reasons).toEqual(['duplicates of the first check']);
	});
	test('a trailer reason under three characters does not count', () => {
		const r = branch({ 'src/a.test.ts': T3 }, (r) => {
			r.write({ 'src/a.test.ts': T1 });
			r.commit('weaken', 'Tests-Removed: no');
		});
		expect(removedAssertions(r.root, loadConfig(r.root), 'main', noEnv).violations).toHaveLength(1);
	});
	test('the range starts at the merge-base: base-side changes are not counted', () => {
		// main gains assertions after the branch point; compared tip to tip, the branch would
		// look as if it removed them.
		const r = branch({ 'src/a.test.ts': T1 }, (r) => {
			r.write({ 'src/b.ts': 'x\n' });
			r.commit('feature');
			r.git('checkout', '-q', 'main');
			r.write({ 'src/a.test.ts': T3 });
			r.commit('main adds checks');
			r.git('checkout', '-q', 'feat');
		});
		expect(removedAssertions(r.root, loadConfig(r.root), 'main', noEnv).violations).toEqual([]);
	});
	test('without --base: skipped on a GitHub push, an error elsewhere', () => {
		const r = repo();
		const cfg = loadConfig(r.root);
		expect(
			removedAssertions(r.root, cfg, undefined, {
				GITHUB_ACTIONS: 'true',
				GITHUB_EVENT_NAME: 'push',
			}).skipped,
		).toBe(true);
		expect(() =>
			removedAssertions(r.root, cfg, undefined, {
				GITHUB_ACTIONS: 'true',
				GITHUB_EVENT_NAME: 'pull_request',
			}),
		).toThrow('diff needs --base <ref>');
		expect(() => removedAssertions(r.root, cfg, undefined, {})).toThrow('diff needs --base <ref>');
	});
	test('without --base in a pull_request job: origin/$GITHUB_BASE_REF', () => {
		const r = branch({ 'src/a.test.ts': T3 }, (r) => {
			r.write({ 'src/a.test.ts': T1 });
			r.commit('weaken');
		});
		r.git('update-ref', 'refs/remotes/origin/main', 'main');
		const res = removedAssertions(r.root, loadConfig(r.root), undefined, {
			GITHUB_ACTIONS: 'true',
			GITHUB_EVENT_NAME: 'pull_request',
			GITHUB_BASE_REF: 'main',
		});
		expect(res.violations).toEqual([{ path: 'src/a.test.ts', removed: 2, added: 0 }]);
	});
	test('an unknown base is a RepoRulesError, not a crash', () => {
		expect(() =>
			removedAssertions(repo().root, loadConfig(repo().root), 'no-such-ref', noEnv),
		).toThrow('git merge-base failed');
	});
});

describe('countPairs / judge', () => {
	const isTest = matcher(['**/*.{test,spec}.*', '**/*.t.sol', '**/test_*.py']);
	test('Solidity and Python patterns', () => {
		const diff = [
			'diff --git a/t/A.t.sol b/t/A.t.sol',
			'--- a/t/A.t.sol',
			'+++ b/t/A.t.sol',
			'@@ -1,2 +1 @@',
			'-    assertEq(a, b);',
			'-    assertTrue(ok);',
			'+    assertEq(a, b);',
			'diff --git a/test_x.py b/test_x.py',
			'--- a/test_x.py',
			'+++ b/test_x.py',
			'@@ -1,2 +0,0 @@',
			'-    assert x == 1',
			'-    self.assertEqual(x, 1)',
		].join('\n');
		expect(judge(countPairs(diff, isTest))).toEqual([
			{ path: 't/A.t.sol', removed: 2, added: 1 },
			{ path: 'test_x.py', removed: 2, added: 0 },
		]);
	});
	test('non-ASCII paths are reported as written', () => {
		const diff = [
			'diff --git a/тест.test.ts b/тест.test.ts',
			'--- a/тест.test.ts',
			'+++ b/тест.test.ts',
			'@@ -1 +0,0 @@',
			'-expect(1);',
		].join('\n');
		expect(judge(countPairs(diff, isTest))).toEqual([
			{ path: 'тест.test.ts', removed: 1, added: 0 },
		]);
	});
});
