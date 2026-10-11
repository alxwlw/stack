import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, test } from 'bun:test';

import { cleanup, cli, repo } from './testkit.ts';

afterAll(cleanup);

const DISABLE = '// eslint-disable-next-line no-console\nconsole.log(1);\n';

describe('repo-rules CLI', () => {
	test('check: violations print path:line rule message, exit 1', () => {
		const r = repo({ 'src/a.ts': DISABLE });
		const res = cli(['-C', r.root, 'check']);
		expect(res.code).toBe(1);
		expect(res.stdout).toContain(
			'src/a.ts:1  suppression-reason  eslint-disable-next-line without a reason',
		);
		expect(res.stdout).toContain('repo-rules: 1 violation(s), 0 stale, 4 rule(s) checked');
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
		expect(ok.stdout).toContain('note  Tests-Removed: the second check duplicated the first');
		const push = cli(['-C', r.root, 'diff'], { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push' });
		expect(push.code).toBe(0);
		expect(push.stdout).toContain('repo-rules diff: skipped (not a pull request)');
	});
	test('errors exit 2 with one line, never a stack trace', () => {
		const r = repo({ '.repo-rules.json': '{"colour": 1}' });
		const badCfg = cli(['-C', r.root, 'check']);
		expect(badCfg.code).toBe(2);
		expect(badCfg.stderr).toBe('repo-rules: .repo-rules.json: unknown field «colour»\n');
		const flag = cli(['-C', repo().root, 'check', '--bogus']);
		expect(flag.code).toBe(2);
		expect(flag.stderr).toContain("Unknown option '--bogus'");
		expect(flag.stderr).not.toContain('    at ');
		expect(cli(['-C', '/', 'check']).code).toBe(2);
		expect(cli(['-C', repo().root, 'diff']).code).toBe(2);
		expect(cli(['-C', repo().root, 'nope']).code).toBe(2);
		expect(cli([]).code).toBe(2);
	});
	test('--help exits 0, --version prints the package version', () => {
		expect(cli(['--help']).code).toBe(0);
		const pkg = JSON.parse(readFileSync(join(import.meta.dir, '../package.json'), 'utf8'));
		expect(cli(['--version']).stdout.trim()).toBe(pkg.version);
	});
	test('the bin has a node shebang and runs without bun', () => {
		const src = readFileSync(join(import.meta.dir, 'cli.mjs'), 'utf8');
		expect(src.startsWith('#!/usr/bin/env node\n')).toBe(true);
		expect(existsSync(join(import.meta.dir, 'main.mjs'))).toBe(true);
	});
});
