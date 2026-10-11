import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, test } from 'bun:test';

import { cleanup, CLI, cli, lines, repo } from './testkit.ts';

afterAll(cleanup);

const DISABLE = '// eslint-disable-next-line no-console\nconsole.log(1);\n';
const USAGE =
	'usage: repo-rules [-C <dir>] check [--json]\n' +
	'       repo-rules [-C <dir>] diff [--base <ref>] [--json]\n' +
	'       repo-rules [-C <dir>] baseline [--init] [--allow-grow]';

describe('repo-rules CLI', () => {
	test('check: violations print path:line rule message, exit 1', () => {
		const r = repo({ 'src/a.ts': DISABLE });
		const res = cli(['-C', r.root, 'check']);
		expect(res.code).toBe(1);
		expect(res.stdout).toBe(
			'src/a.ts:1  suppression-reason  eslint-disable-next-line without a reason\n' +
				'repo-rules: 1 violation(s), 0 stale, 4 rule(s) checked\n',
		);
	});
	test('check --json', () => {
		const r = repo({ 'src/a.ts': DISABLE });
		const res = cli(['-C', r.root, 'check', '--json']);
		const out = JSON.parse(res.stdout);
		expect(out.violations).toEqual([
			{
				rule: 'suppression-reason',
				path: 'src/a.ts',
				line: 1,
				message: 'eslint-disable-next-line without a reason',
			},
		]);
		expect(out.stale).toEqual([]);
		expect(out.notes).toEqual([]);
	});
	test('baseline --init → check clean → growth refused → stale → shrink', () => {
		const r = repo({ 'src/a.ts': DISABLE });
		expect(cli(['-C', r.root, 'baseline']).code).toBe(2);
		expect(cli(['-C', r.root, 'baseline', '--init']).code).toBe(0);
		expect(cli(['-C', r.root, 'baseline', '--init']).code).toBe(2);
		expect(cli(['-C', r.root, 'check']).code).toBe(0);

		r.write({ 'src/a.ts': `${DISABLE}${DISABLE}` });
		expect(cli(['-C', r.root, 'check']).code).toBe(1);
		const refused = cli(['-C', r.root, 'baseline']);
		expect(refused.code).toBe(1);
		expect(refused.stdout).toContain('src/a.ts  suppression-reason  1 → 2');
		expect(cli(['-C', r.root, 'baseline', '--allow-grow']).code).toBe(0);
		expect(cli(['-C', r.root, 'check']).code).toBe(0);

		r.write({ 'src/a.ts': 'console.log(1);\n' });
		const stale = cli(['-C', r.root, 'check']);
		expect(stale.code).toBe(1);
		expect(stale.stdout).toContain('baseline 2, now 0');
		expect(cli(['-C', r.root, 'baseline']).code).toBe(0);
		expect(JSON.parse(readFileSync(join(r.root, '.repo-rules-baseline.json'), 'utf8'))).toEqual({
			version: 1,
			rules: {},
		});
		expect(cli(['-C', r.root, 'check']).code).toBe(0);
	});
	test('-C a subdirectory works from the repository root', () => {
		const r = repo({ 'src/deep/a.ts': DISABLE });
		expect(cli(['-C', join(r.root, 'src/deep'), 'check']).stdout).toContain('src/deep/a.ts:1');
	});
	test('diff: exit 1 on removed assertions, 0 with a trailer, skipped on a push', () => {
		const r = repo({ 'a.test.ts': 'expect(1);\nexpect(2);\n' });
		r.git('checkout', '-q', '-b', 'feat');
		r.write({ 'a.test.ts': 'expect(1);\n' });
		r.commit('weaken');
		const red = cli(['-C', r.root, 'diff', '--base', 'main']);
		expect(red.code).toBe(1);
		expect(red.stdout).toContain('a.test.ts  removed-assertions  −1 / +0 assertions');
		r.commit('note', 'Tests-Removed: the second check duplicated the first');
		const ok = cli(['-C', r.root, 'diff', '--base', 'main']);
		expect(ok.code).toBe(0);
		expect(ok.stdout).toBe(
			'note  Tests-Removed: the second check duplicated the first\nrepo-rules diff: 0 violation(s)\n',
		);
		const push = cli(['-C', r.root, 'diff'], { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push' });
		expect(push.code).toBe(0);
		expect(push.stdout).toBe(
			'note  skipped (not a pull request)\nrepo-rules diff: skipped (not a pull request)\n',
		);
	});
	test('errors exit 2 with one line, never a stack trace', () => {
		const r = repo({ '.repo-rules.json': '{"colour": 1}' });
		const badCfg = cli(['-C', r.root, 'check']);
		expect(badCfg.code).toBe(2);
		expect(badCfg.stderr).toBe('repo-rules: .repo-rules.json: unknown field «colour»\n');
		const flag = cli(['-C', repo().root, 'check', '--bogus']);
		expect(flag.code).toBe(2);
		expect(flag.stderr).toContain("Unknown option '--bogus'");
		expect(flag.stderr).toContain(USAGE);
		expect(flag.stderr).not.toContain('    at ');
		expect(cli(['-C', '/', 'check']).code).toBe(2);
		expect(cli(['-C', repo().root, 'diff']).code).toBe(2);
		expect(cli(['-C', repo().root, 'nope']).code).toBe(2);
		expect(cli([]).code).toBe(2);
	});
	test('--help exits 0, --version prints the package version', () => {
		for (const flag of ['--help', '-h']) {
			const res = cli([flag]);
			expect(res.code).toBe(0);
			expect(res.stdout).toBe(`${USAGE}\n`);
		}
		const version = cli(['--version']);
		const pkg = JSON.parse(readFileSync(join(import.meta.dir, '../package.json'), 'utf8'));
		expect(version.code).toBe(0);
		expect(version.stdout).toBe(`${pkg.version}\n`);
	});
	test('no command, or an unknown one, prints usage on stdout and exits 2', () => {
		const bad = repo({ '.repo-rules.json': '{"colour": 1}' });
		const none = cli(['-C', bad.root]);
		expect(none.code).toBe(2);
		expect(none.stdout).toBe(`${USAGE}\n`);
		expect(none.stderr).toBe('');
		const unknown = cli(['-C', repo().root, 'nope']);
		expect(unknown.code).toBe(2);
		expect(unknown.stdout).toBe(`${USAGE}\n`);
	});
	test('baseline: refusal and success messages are exact', () => {
		const r = repo({ 'src/a.ts': DISABLE });
		expect(cli(['-C', r.root, 'baseline']).stderr).toBe(
			'repo-rules: no .repo-rules-baseline.json: run repo-rules baseline --init\n',
		);
		expect(cli(['-C', r.root, 'baseline', '--init']).stdout).toBe(
			'repo-rules baseline: wrote .repo-rules-baseline.json (1 entr(ies))\n',
		);
		expect(cli(['-C', r.root, 'baseline', '--init']).stderr).toBe(
			'repo-rules: .repo-rules-baseline.json already exists\n',
		);
		r.write({ 'src/a.ts': `${DISABLE}${DISABLE}` });
		expect(cli(['-C', r.root, 'baseline']).stdout).toBe(
			'src/a.ts  suppression-reason  1 → 2\n' +
				'repo-rules baseline: 1 entr(ies) would grow — fix them or pass --allow-grow\n',
		);
	});
	test('check: a stale entry prints its full line and counts in the summary', () => {
		const r = repo({ 'src/a.ts': DISABLE });
		expect(cli(['-C', r.root, 'baseline', '--init']).code).toBe(0);
		r.write({ 'src/a.ts': 'console.log(1);\n' });
		expect(cli(['-C', r.root, 'check']).stdout).toBe(
			'src/a.ts  suppression-reason  baseline 1, now 0 — исключения устарели: repo-rules baseline\n' +
				'repo-rules: 0 violation(s), 1 stale, 4 rule(s) checked\n',
		);
	});
	test('check --json reports a stale entry with its baseline and actual counts', () => {
		const r = repo({ 'src/a.ts': DISABLE });
		expect(cli(['-C', r.root, 'baseline', '--init']).code).toBe(0);
		r.write({ 'src/a.ts': 'console.log(1);\n' });
		const out = JSON.parse(cli(['-C', r.root, 'check', '--json']).stdout);
		expect(out.violations).toEqual([]);
		expect(out.stale).toEqual([
			{ rule: 'suppression-reason', path: 'src/a.ts', baseline: 1, actual: 0 },
		]);
	});
	test('diff --json carries rule, line 0 and the message; text prints its summary', () => {
		const r = repo({ 'a.test.ts': 'expect(1);\nexpect(2);\n' });
		r.git('checkout', '-q', '-b', 'feat');
		r.write({ 'a.test.ts': 'expect(1);\n' });
		r.commit('weaken');
		const red = cli(['-C', r.root, 'diff', '--base', 'main', '--json']);
		expect(red.code).toBe(1);
		expect(JSON.parse(red.stdout)).toEqual({
			violations: [
				{ rule: 'removed-assertions', path: 'a.test.ts', line: 0, message: '−1 / +0 assertions' },
			],
			stale: [],
			notes: [],
		});
		expect(cli(['-C', r.root, 'diff', '--base', 'main']).stdout).toBe(
			'a.test.ts  removed-assertions  −1 / +0 assertions\n' + 'repo-rules diff: 1 violation(s)\n',
		);
	});
	test('check: a file over 800 lines is reported with its count and the limit', () => {
		const r = repo({ 'src/big.ts': lines(801) });
		expect(cli(['-C', r.root, 'check']).stdout).toContain(
			'src/big.ts:801  max-lines  801 lines (limit 800)',
		);
	});
	test('an unexpected error prints internal error on stderr and exits 2', () => {
		const r = repo({ 'src/a.ts': 'x\n' });
		// A dangling baseline symlink: the file reads as absent, the write fails with ENOENT.
		symlinkSync(join(r.root, 'missing-dir', 'b.json'), join(r.root, '.repo-rules-baseline.json'));
		const res = cli(['-C', r.root, 'baseline', '--init']);
		expect(res.code).toBe(2);
		expect(res.stderr.startsWith('repo-rules: internal error: ')).toBe(true);
		expect(res.stderr).toContain('    at ');
	});
	test('a full disk on stdout exits 2 with one stderr line (Linux: /dev/full)', () => {
		const r = repo({ 'src/a.ts': DISABLE });
		const res = spawnSync('sh', ['-c', `node '${CLI}' -C '${r.root}' check > /dev/full`], {
			encoding: 'utf8',
		});
		expect(res.status).toBe(2);
		expect(res.stderr).toMatch(/^repo-rules: ENOSPC[^\n]*\n$/);
		expect(res.stderr).not.toContain('    at ');
	});
	test('diff --json notes: the Tests-Removed reason, and the skip on a push', () => {
		const r = repo({ 'a.test.ts': 'expect(1);\nexpect(2);\n' });
		r.git('checkout', '-q', '-b', 'feat');
		r.write({ 'a.test.ts': 'expect(1);\n' });
		r.commit('weaken');
		r.commit('note', 'Tests-Removed: the second check duplicated the first');
		const ok = cli(['-C', r.root, 'diff', '--base', 'main', '--json']);
		expect(ok.code).toBe(0);
		expect(JSON.parse(ok.stdout)).toEqual({
			violations: [],
			stale: [],
			notes: ['Tests-Removed: the second check duplicated the first'],
		});
		const push = cli(['-C', r.root, 'diff', '--json'], {
			GITHUB_ACTIONS: 'true',
			GITHUB_EVENT_NAME: 'push',
		});
		expect(push.code).toBe(0);
		expect(JSON.parse(push.stdout)).toEqual({
			violations: [],
			stale: [],
			notes: ['skipped (not a pull request)'],
		});
	});
	test('testGlobs replaces the defaults: the README list still reads test_*.py', () => {
		const config = {
			testGlobs: [
				'**/*.{test,spec}.*',
				'**/__tests__/**',
				'**/test/**',
				'**/tests/**',
				'**/*.t.sol',
				'**/test_*.py',
				'**/*_test.py',
			],
		};
		const r = repo({
			'.repo-rules.json': JSON.stringify(config),
			'test_a.py': 'def test_a():\n    assert 1 == 1\n    assert 2 == 2\n',
		});
		r.git('checkout', '-q', '-b', 'feat');
		r.write({ 'test_a.py': 'def test_a():\n    assert 1 == 1\n' });
		r.commit('weaken');
		const res = cli(['-C', r.root, 'diff', '--base', 'main']);
		expect(res.code).toBe(1);
		expect(res.stdout).toContain('test_a.py  removed-assertions  −1 / +0 assertions');
	});
	test('check --help prints usage and exits 0, even with violations', () => {
		const r = repo({ 'src/a.ts': DISABLE });
		const res = cli(['-C', r.root, 'check', '--help']);
		expect(res.code).toBe(0);
		expect(res.stdout).toBe(`${USAGE}\n`);
	});
	test('the bin has a node shebang and runs without bun', () => {
		const src = readFileSync(join(import.meta.dir, 'cli.mjs'), 'utf8');
		expect(src.startsWith('#!/usr/bin/env node\n')).toBe(true);
		expect(existsSync(join(import.meta.dir, 'main.mjs'))).toBe(true);
	});
});
