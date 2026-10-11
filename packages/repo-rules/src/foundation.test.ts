import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, test } from 'bun:test';

import { DEFAULT_TEST_GLOBS, loadConfig, MAX_LINES_EXCLUDE } from './config.mjs';
import { countLines, readText, repoRoot, RepoRulesError, trackedFiles } from './git.mjs';
import { globToRegExp, matcher } from './glob.mjs';
import { cleanup, repo } from './testkit.ts';

afterAll(cleanup);

describe('globToRegExp', () => {
	const cases: [string, string, boolean][] = [
		['docs/**/plans/**', 'docs/superpowers/plans/2026-x.md', true],
		['docs/**/plans/**', 'docs/plans/x.md', true],
		['docs/**/plans/**', 'docs/specs/x.md', false],
		['**/*.lock', 'yarn.lock', true],
		['**/*.lock', 'a/b/bun.lock', true],
		['**/test/**', 'test/a.ts', true],
		['**/test/**', 'pkg/test/deep/a.ts', true],
		['**/test/**', 'pkg/testing/a.ts', false],
		['**/*.{test,spec}.*', 'src/a.test.ts', true],
		['**/*.{test,spec}.*', 'src/a.spec.tsx', true],
		['**/*.{test,spec}.*', 'src/atest.ts', false],
		['public/charting_library/**', 'public/charting_library/x/y.js', true],
		['*.md', 'a/b.md', false],
		['a?.ts', 'ab.ts', true],
		['a.ts', 'a+ts', false],
	];
	for (const [glob, path, want] of cases) {
		test(`${glob} ${want ? 'matches' : 'skips'} ${path}`, () => {
			expect(globToRegExp(glob).test(path)).toBe(want);
		});
	}
	test('matcher: any of several globs', () => {
		const m = matcher(['**/*.json', 'docs/**/plans/**']);
		expect(m('package.json')).toBe(true);
		expect(m('docs/plans/x.md')).toBe(true);
		expect(m('src/a.ts')).toBe(false);
	});
	test('default exclusions cover generated migrations and changelogs', () => {
		const m = matcher(MAX_LINES_EXCLUDE);
		expect(m('packages/db/prisma/migrations/2026_init/migration.sql')).toBe(true);
		expect(m('CHANGELOG.md')).toBe(true);
		expect(m('docs/specs/x.md')).toBe(false);
	});
});

describe('git helpers', () => {
	test('trackedFiles lists committed files, not untracked ones', () => {
		const r = repo({ 'a.ts': 'x\n', 'dir/b.md': 'y\n' });
		writeFileSync(join(r.root, 'untracked.ts'), 'z\n');
		expect(trackedFiles(r.root).sort()).toEqual(['a.ts', 'dir/b.md']);
	});
	test('trackedFiles leaves gitlinks (submodules) out', () => {
		const r = repo({ 'a.ts': 'x\n' });
		const sha = r.git('rev-parse', 'HEAD').trim();
		r.git('update-index', '--add', '--cacheinfo', `160000,${sha},vendor/sub`);
		r.git('commit', '-q', '-m', 'gitlink');
		expect(r.git('ls-files', '-s', 'vendor/sub')).toStartWith('160000 ');
		expect(trackedFiles(r.root)).toEqual(['a.ts']);
	});
	test('trackedFiles keeps non-ASCII paths unquoted', () => {
		const r = repo({ 'тест.md': 'x\n' });
		expect(trackedFiles(r.root)).toEqual(['тест.md']);
	});
	test('readText: binary and missing files are null', () => {
		const r = repo({ 'bin.dat': 'a\u0000b', 'a.txt': 'hi\n' });
		expect(readText(r.root, 'bin.dat')).toBeNull();
		expect(readText(r.root, 'gone.txt')).toBeNull();
		expect(readText(r.root, 'a.txt')).toBe('hi\n');
	});
	test('countLines counts a last line without a newline', () => {
		expect(countLines('')).toBe(0);
		expect(countLines('a\n')).toBe(1);
		expect(countLines('a\nb')).toBe(2);
		expect(countLines('a\r\nb\r\n')).toBe(2);
	});
	test('repoRoot from a subdirectory; outside a repo is a RepoRulesError', () => {
		const r = repo({ 'sub/a.ts': 'x\n' });
		expect(repoRoot(join(r.root, 'sub'))).toBe(r.git('rev-parse', '--show-toplevel').trim());
		expect(() => repoRoot('/')).toThrow(RepoRulesError);
	});
});

describe('loadConfig', () => {
	test('defaults without a file', () => {
		const r = repo();
		const cfg = loadConfig(r.root);
		expect(cfg.maxLines).toBe(800);
		expect(cfg.exclude).toEqual({});
		expect(cfg.testGlobs).toEqual(DEFAULT_TEST_GLOBS);
	});
	test('fields from .repo-rules.json', () => {
		const r = repo({
			'.repo-rules.json': JSON.stringify({
				maxLines: 500,
				exclude: { '*': ['vendor-x/**'], 'max-lines': ['docs/*.html'] },
				testGlobs: ['**/*.check.ts'],
			}),
		});
		const cfg = loadConfig(r.root);
		expect(cfg.maxLines).toBe(500);
		expect(cfg.exclude['max-lines']).toEqual(['docs/*.html']);
		expect(cfg.testGlobs).toEqual(['**/*.check.ts']);
	});
	const bad: [string, string][] = [
		['{', 'not JSON'],
		['[]', 'top level is not an object'],
		['{"colour": 1}', 'unknown field «colour»'],
		['{"maxLines": 0}', 'maxLines must be a positive integer'],
		['{"maxLines": 1.5}', 'maxLines must be a positive integer'],
		['{"exclude": {"no-such-rule": []}}', 'exclude: unknown rule «no-such-rule»'],
		['{"exclude": {"*": "x"}}', 'exclude.* must be a list of globs'],
		['{"testGlobs": [1]}', 'testGlobs must be a list of globs'],
	];
	for (const [text, message] of bad) {
		test(`rejects ${text}`, () => {
			const r = repo({ '.repo-rules.json': text });
			expect(() => loadConfig(r.root)).toThrow(message);
		});
	}
});
