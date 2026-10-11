import { afterAll, describe, expect, test } from 'bun:test';

import { loadConfig } from './config.mjs';
import { countPairs, judge, removedAssertions } from './diff.mjs';
import { RepoRulesError } from './git.mjs';
import { matcher } from './glob.mjs';
import { cleanup, repo } from './testkit.ts';

afterAll(cleanup);

const T3 =
	'test("a", () => {\n  expect(1).toBe(1);\n  expect(2).toBe(2);\n  expect(3).toBe(3);\n});\n';
const T1 = 'test("a", () => {\n  expect(1).toBe(1);\n});\n';
const WEAKENED = [{ path: 'src/a.test.ts', removed: 2, added: 0 }];
const noEnv = {};
const PR = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request', GITHUB_BASE_REF: 'main' };

/** A repo on `main` with `files`, then branch `feat` with `change` applied and committed. */
function branch(files: Record<string, string>, change: (r: ReturnType<typeof repo>) => void) {
	const r = repo(files);
	r.git('checkout', '-q', '-b', 'feat');
	change(r);
	return r;
}

/** Branch `feat` cuts the fixture test file from three checks to one; `config` is set first. */
function weakened(config?: [string, string]) {
	const r = branch({ 'src/a.test.ts': T3 }, (r) => {
		r.write({ 'src/a.test.ts': T1 });
		r.commit('weaken');
	});
	if (config) r.git('config', ...config);
	return removedAssertions(r.root, loadConfig(r.root), 'main', noEnv).violations;
}

/** The value `f` throws, or undefined. */
function thrown(f: () => unknown): unknown {
	try {
		f();
	} catch (e) {
		return e;
	}
	return undefined;
}

/** One file's `git diff --unified=0` text: the `minus` lines removed, the `plus` lines added. */
function fileDiff(path: string, minus: string[], plus: string[] = []): string {
	return [
		`diff --git a/${path} b/${path}`,
		`--- a/${path}`,
		`+++ b/${path}`,
		'@@ -1 +1 @@',
		...minus.map((l) => `-${l}`),
		...plus.map((l) => `+${l}`),
	].join('\n');
}

describe('removedAssertions', () => {
	test('a test file name with a space, a quote, a tab or a backslash is read as written', () => {
		// git adds a TAB after a `---`/`+++` name with a space and C-quotes the others.
		const names = [
			'my test.test.ts',
			'q"x.test.ts',
			'tab\tx.test.ts',
			'back\\slash.test.ts',
			'ctl\x01x.test.ts',
			'esc\x1bx.test.ts',
			'del\x7fx.test.ts',
			'nl\nx.test.ts',
			'cr\rx.test.ts',
			'bel\x07x.test.ts',
			'bs\x08x.test.ts',
			'vt\x0bx.test.ts',
			'ff\x0cx.test.ts',
		];
		const r = branch(Object.fromEntries(names.map((n) => [`src/${n}`, T3])), (r) => {
			r.write(Object.fromEntries(names.map((n) => [`src/${n}`, T1])));
			r.commit('weaken all');
		});
		const res = removedAssertions(r.root, loadConfig(r.root), 'main', noEnv);
		expect(res.violations.map((v) => v.path).sort()).toEqual(names.map((n) => `src/${n}`).sort());
		expect(res.violations.every((v) => v.removed === 2 && v.added === 0)).toBe(true);
	});
	test('a diff.noprefix setting does not shift the paths', () => {
		expect(weakened(['diff.noprefix', 'true'])).toEqual(WEAKENED);
	});
	test('colour config does not hide removals', () => {
		expect(weakened(['color.ui', 'always'])).toEqual(WEAKENED);
	});
	test('a textconv driver in the config does not rewrite the counted text', () => {
		const r = branch({ '.gitattributes': '*.test.ts diff=fake\n', 'src/a.test.ts': T3 }, (r) => {
			r.write({ 'src/a.test.ts': T1 });
			r.commit('weaken');
		});
		r.git('config', 'diff.fake.textconv', 'true');
		expect(removedAssertions(r.root, loadConfig(r.root), 'main', noEnv).violations).toEqual(
			WEAKENED,
		);
	});
	test('an external diff tool in the config is not used', () => {
		expect(weakened(['diff.external', 'echo'])).toEqual(WEAKENED);
	});
	test('rename detection does not depend on diff.renames', () => {
		const r = branch({ 'src/a.test.ts': T3 }, (r) => {
			r.git('mv', 'src/a.test.ts', 'src/b.test.ts');
			r.write({ 'src/b.test.ts': T3.replace('  expect(2).toBe(2);\n', '') });
			r.commit('rename and drop a check');
		});
		r.git('config', 'diff.renames', 'false');
		expect(removedAssertions(r.root, loadConfig(r.root), 'main', noEnv).violations).toEqual([
			{ path: 'src/a.test.ts → src/b.test.ts', removed: 1, added: 0 },
		]);
	});
	test('fewer assertions in a modified test file', () => {
		const r = branch({ 'src/a.test.ts': T3 }, (r) => {
			r.write({ 'src/a.test.ts': T1 });
			r.commit('weaken');
		});
		const res = removedAssertions(r.root, loadConfig(r.root), 'main', noEnv);
		expect(res.violations).toEqual([{ path: 'src/a.test.ts', removed: 2, added: 0 }]);
	});
	test('a check swapped for another is not a removal; a run without trailers reports none', () => {
		const r = branch({ 'src/a.test.ts': T1 }, (r) => {
			r.write({ 'src/a.test.ts': 'test("a", () => {\n  expect(2).toBe(2);\n});\n' });
			r.commit('swap');
		});
		expect(removedAssertions(r.root, loadConfig(r.root), 'main', noEnv)).toEqual({
			violations: [],
			reasons: [],
			skipped: false,
		});
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
	test('a renamed test file that loses a check is reported as old → new', () => {
		const r = branch({ 'src/a.test.ts': T3 }, (r) => {
			r.git('mv', 'src/a.test.ts', 'src/b.test.ts');
			r.write({ 'src/b.test.ts': T3.replace('  expect(2).toBe(2);\n', '') });
			r.commit('rename and drop a check');
		});
		expect(removedAssertions(r.root, loadConfig(r.root), 'main', noEnv).violations).toEqual([
			{ path: 'src/a.test.ts → src/b.test.ts', removed: 1, added: 0 },
		]);
	});
	test('a rename counts when its old or its new name is a test file', () => {
		const helper = 'export function check() {\n  expect(1);\n  expect(2);\n}\n';
		const r = branch({ 'src/a.test.ts': T3, 'src/helper.ts': helper }, (r) => {
			r.git('mv', 'src/a.test.ts', 'src/a.ts');
			r.write({ 'src/a.ts': T3.replace('  expect(2).toBe(2);\n', '') });
			r.git('mv', 'src/helper.ts', 'src/helper.test.ts');
			r.write({ 'src/helper.test.ts': helper.replace('  expect(2);\n', '') });
			r.commit('move both');
		});
		const { violations } = removedAssertions(r.root, loadConfig(r.root), 'main', noEnv);
		expect(violations.map((v) => `${v.path} ${v.removed}/${v.added}`).sort()).toEqual([
			'src/a.test.ts → src/a.ts 1/0',
			'src/helper.ts → src/helper.test.ts 1/0',
		]);
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
	test('deleted test files are each reported with their own removed and the pooled added', () => {
		const A = 'test("a", () => {\n  expect(1).toBe(1);\n  expect(2).toBe(2);\n});\n';
		const B = 'test("b", () => {\n  expect(3).toBe(3);\n  expect(4).toBe(4);\n});\n';
		const C =
			'test("c", () => {\n  expect(7).toBe(7);\n  expect(8).toBe(8);\n  expect(9).toBe(9);\n});\n';
		const r = branch({ 'src/a.test.ts': A, 'src/b.test.ts': B }, (r) => {
			r.git('rm', '-q', 'src/a.test.ts', 'src/b.test.ts');
			r.write({ 'src/c.test.ts': C });
			r.commit('replace both');
		});
		expect(removedAssertions(r.root, loadConfig(r.root), 'main', noEnv).violations).toEqual([
			{ path: 'src/a.test.ts (deleted)', removed: 2, added: 3 },
			{ path: 'src/b.test.ts (deleted)', removed: 2, added: 3 },
		]);
	});
	test('a modified test file gaining checks does not pay for a deleted one', () => {
		const r = branch({ 'src/a.test.ts': T3, 'src/m.test.ts': T1 }, (r) => {
			r.git('rm', '-q', 'src/a.test.ts');
			r.write({ 'src/m.test.ts': T3 });
			r.commit('drop a, grow m');
		});
		expect(removedAssertions(r.root, loadConfig(r.root), 'main', noEnv).violations).toEqual([
			{ path: 'src/a.test.ts (deleted)', removed: 3, added: 0 },
		]);
	});
	test('a deleted test file is reported and a deleted non-test file is not', () => {
		const r = branch({ 'src/a.test.ts': T3, 'src/util.ts': 'export const x = 1;\n' }, (r) => {
			r.git('rm', '-q', 'src/a.test.ts', 'src/util.ts');
			r.commit('drop both');
		});
		expect(removedAssertions(r.root, loadConfig(r.root), 'main', noEnv).violations).toEqual([
			{ path: 'src/a.test.ts (deleted)', removed: 3, added: 0 },
		]);
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
	test('every Tests-Removed trailer in the range counts, on whichever commit it sits', () => {
		const r = branch({ 'src/a.test.ts': T3 }, (r) => {
			r.write({ 'src/a.test.ts': T1 });
			r.commit(
				'weaken',
				'Tests-Removed: first duplicate check\nTests-Removed: second duplicate check',
			);
			r.write({ 'src/c.ts': 'x\n' });
			r.commit('later', 'Tests-Removed: third duplicate check');
		});
		expect(removedAssertions(r.root, loadConfig(r.root), 'main', noEnv).reasons).toEqual([
			'third duplicate check',
			'first duplicate check',
			'second duplicate check',
		]);
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
	test("the branch's own removals count when main gained checks after the branch point", () => {
		const r = branch({ 'src/a.test.ts': T3 }, (r) => {
			r.write({ 'src/a.test.ts': T1 });
			r.commit('weaken');
		});
		r.git('checkout', '-q', 'main');
		r.write({ 'src/b.test.ts': T3 });
		r.commit('main adds a file');
		r.git('checkout', '-q', 'feat');
		expect(removedAssertions(r.root, loadConfig(r.root), 'main', noEnv).violations).toEqual(
			WEAKENED,
		);
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
	test('a push without --base is skipped with exactly the empty result', () => {
		const r = repo();
		expect(
			removedAssertions(r.root, loadConfig(r.root), undefined, {
				GITHUB_ACTIONS: 'true',
				GITHUB_EVENT_NAME: 'push',
			}),
		).toEqual({ violations: [], reasons: [], skipped: true });
	});
	test('the missing-base error is a RepoRulesError with exactly that message', () => {
		const r = repo();
		const cfg = loadConfig(r.root);
		const errors = [
			thrown(() => removedAssertions(r.root, cfg, undefined, { GITHUB_BASE_REF: 'main' })),
			thrown(() =>
				removedAssertions(r.root, cfg, undefined, {
					GITHUB_ACTIONS: 'true',
					GITHUB_EVENT_NAME: 'pull_request',
				}),
			),
		];
		for (const e of errors) {
			expect(e).toBeInstanceOf(RepoRulesError);
			expect((e as Error).message).toBe('diff needs --base <ref>');
		}
	});
	test('without --base in a pull_request job: origin/$GITHUB_BASE_REF', () => {
		const r = branch({ 'src/a.test.ts': T3 }, (r) => {
			r.write({ 'src/a.test.ts': T1 });
			r.commit('weaken');
		});
		r.git('update-ref', 'refs/remotes/origin/main', 'main');
		const res = removedAssertions(r.root, loadConfig(r.root), undefined, PR);
		expect(res.violations).toEqual([{ path: 'src/a.test.ts', removed: 2, added: 0 }]);
	});
	test('pull_request_target jobs take the base from GITHUB_BASE_REF too', () => {
		const r = branch({ 'src/a.test.ts': T3 }, (r) => {
			r.write({ 'src/a.test.ts': T1 });
			r.commit('weaken');
		});
		r.git('update-ref', 'refs/remotes/origin/main', 'main');
		const env = { ...PR, GITHUB_EVENT_NAME: 'pull_request_target' };
		expect(removedAssertions(r.root, loadConfig(r.root), undefined, env).violations).toEqual(
			WEAKENED,
		);
	});
	test('the PR base is origin/<GITHUB_BASE_REF>', () => {
		const r = branch({ 'src/a.test.ts': T3 }, (r) => {
			r.write({ 'src/a.test.ts': T1 });
			r.commit('weaken');
		});
		r.git('update-ref', 'refs/remotes/origin/trunk', 'main');
		const env = { ...PR, GITHUB_BASE_REF: 'trunk' };
		expect(removedAssertions(r.root, loadConfig(r.root), undefined, env).violations).toEqual(
			WEAKENED,
		);
	});
	test('an unknown base is a RepoRulesError, not a crash', () => {
		const r = repo();
		expect(() => removedAssertions(r.root, loadConfig(r.root), 'no-such-ref', noEnv)).toThrow(
			'git merge-base failed',
		);
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
	test('each JS call form counts; words that only contain or start with a name do not', () => {
		const calls = fileDiff('src/x.test.ts', [
			'expect(1);',
			'assert(2);',
			'assert.strictEqual(3);',
			'expect(4); expect(5);',
		]);
		expect(judge(countPairs(calls, isTest))).toEqual([
			{ path: 'src/x.test.ts', removed: 5, added: 0 },
		]);
		const words = fileDiff('src/x.test.ts', [
			'const expected = 1;',
			'reassert(2);',
			'unexpect(3);',
			'const assertion = 4;',
			'const f = assert.ok;',
			'const g = expect;',
		]);
		expect(judge(countPairs(words, isTest))).toEqual([]);
	});
	test('every JS-family extension is a test language', () => {
		const exts = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts'];
		const diff = exts.map((e) => fileDiff(`src/x.test.${e}`, ['expect(1);'])).join('\n');
		expect(judge(countPairs(diff, isTest)).map((v) => v.path)).toEqual(
			exts.map((e) => `src/x.test.${e}`),
		);
	});
	test('a name that only ends in sol or py, a JSON test file and an unknown test file are not counted', () => {
		const diff = [
			fileDiff('src/x.test.ansol', ['assertEq(1, 1);']),
			fileDiff('src/x.test.nopy', ['    assert x == 1']),
			fileDiff('src/x.test.md', ['expect(1);']),
			fileDiff('src/x.test.json', ['expect(1);']),
		].join('\n');
		expect(judge(countPairs(diff, isTest))).toEqual([]);
	});
	test('a Solidity name counts only as an assertX( call', () => {
		const diff = fileDiff('t/A.t.sol', [
			'    assertion(a);',
			'    myassertEq(a, b);',
			'    fn = assertEq;',
		]);
		expect(judge(countPairs(diff, isTest))).toEqual([]);
	});
	test('Python counts statement assert and self.assertX( only, added checks too', () => {
		const words = fileDiff('test_y.py', [
			'assertions = []',
			'x = 1  # assert nothing',
			'assertEqual(x, 1)',
			'myself.assertEqual(x, 1)',
			'check = self.assertEqual',
		]);
		expect(judge(countPairs(words, isTest))).toEqual([]);
		const swap = fileDiff(
			'test_y.py',
			['    assert x == 1', '    assert y == 2'],
			['    assert x == 3'],
		);
		expect(judge(countPairs(swap, isTest))).toEqual([{ path: 'test_y.py', removed: 2, added: 1 }]);
	});
	test('a non-test file is not counted, whatever its text', () => {
		const diff = fileDiff('src/a.ts', ['const x = null;', 'expect(1);']);
		expect(judge(countPairs(diff, isTest))).toEqual([]);
	});
});
