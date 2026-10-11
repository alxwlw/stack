import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, test } from 'bun:test';

import {
	BASELINE_FILE,
	compare,
	emptyCounts,
	growth,
	loadBaseline,
	writeBaseline,
} from './baseline.mjs';
import { loadConfig } from './config.mjs';
import { scan } from './scan.mjs';
import { cleanup, lines, repo } from './testkit.ts';

afterAll(cleanup);

describe('scan', () => {
	test('each rule on its own files; excluded and binary files skipped', () => {
		const r = repo({
			'docs/spec.md': lines(801),
			'docs/superpowers/plans/p.md': lines(5000),
			'pnpm-lock.yaml': lines(5000),
			'src/short.ts': lines(800),
			'src/a.ts': '// eslint-disable-next-line x\nconst p = Number(env.P) || 8080;\n',
			'src/a.test.ts': `it.skip('a', () => {});\nconst p = Number(env.P) || 8080;\n`,
			'img.bin': `\u0000${lines(900)}`,
		});
		const res = scan(r.root, loadConfig(r.root));
		expect(res.actual['max-lines']).toEqual({ 'docs/spec.md': 801 });
		expect(res.actual['suppression-reason']).toEqual({ 'src/a.ts': 1 });
		expect(res.actual['focused-skipped-tests']).toEqual({ 'src/a.test.ts': 1 });
		// number-or-default skips test files
		expect(res.actual['number-or-default']).toEqual({ 'src/a.ts': 1 });
		expect(res.hits.find((h) => h.rule === 'max-lines')).toMatchObject({
			line: 801,
			message: '801 lines (limit 800)',
		});
	});
	test('repo config: maxLines, per-rule and global excludes, testGlobs', () => {
		const r = repo({
			'.repo-rules.json': JSON.stringify({
				maxLines: 10,
				exclude: { '*': ['vendor-x/**'], 'max-lines': ['docs/*.html'] },
				testGlobs: ['**/*.check.ts'],
			}),
			'docs/a.html': lines(20),
			'docs/b.md': lines(20),
			'vendor-x/lib.ts': `${lines(20)}// eslint-disable-line x\n`,
			'src/a.check.ts': `it.skip('a', () => {});\n`,
			'src/a.test.ts': `it.skip('a', () => {});\n`,
		});
		const res = scan(r.root, loadConfig(r.root));
		expect(Object.keys(res.actual['max-lines'])).toEqual(['docs/b.md']);
		expect(res.actual['suppression-reason']).toEqual({});
		expect(res.actual['focused-skipped-tests']).toEqual({ 'src/a.check.ts': 1 });
	});
});

describe('baseline', () => {
	const hit = (path: string, line: number) => ({
		rule: 'suppression-reason' as const,
		path,
		line,
		message: 'eslint-disable-line without a reason',
	});
	test('compare: over the baseline, absent from it, stale, a long file that grew or shrank', () => {
		const actual = emptyCounts();
		actual['suppression-reason'] = { 'a.ts': 2, 'new.ts': 1, 'shrunk.ts': 1 };
		actual['max-lines'] = { 'grew.md': 900, 'shrank.md': 850 };
		const base = emptyCounts();
		base['suppression-reason'] = { 'a.ts': 1, 'shrunk.ts': 3, 'gone.ts': 1 };
		base['max-lines'] = { 'grew.md': 880, 'shrank.md': 870 };
		const hits = [
			hit('a.ts', 1),
			hit('a.ts', 5),
			hit('new.ts', 2),
			hit('shrunk.ts', 9),
			{ rule: 'max-lines' as const, path: 'grew.md', line: 801, message: '900 lines (limit 800)' },
			{
				rule: 'max-lines' as const,
				path: 'shrank.md',
				line: 801,
				message: '850 lines (limit 800)',
			},
		];
		const cmp = compare(actual, hits, base);
		expect(cmp.violations.map((v) => `${v.path}:${v.line}`).sort()).toEqual([
			'a.ts:1',
			'a.ts:5',
			'grew.md:801',
			'new.ts:2',
		]);
		expect(cmp.violations.find((v) => v.path === 'a.ts')?.message).toContain('(baseline 1)');
		expect(cmp.stale.map((s) => `${s.rule}:${s.path}:${s.baseline}>${s.actual}`).sort()).toEqual([
			'max-lines:shrank.md:870>850',
			'suppression-reason:gone.ts:1>0',
			'suppression-reason:shrunk.ts:3>1',
		]);
	});
	test('growth lists rises and new entries only', () => {
		const prev = emptyCounts();
		prev['number-or-default'] = { 'a.ts': 2, 'b.ts': 1 };
		const next = emptyCounts();
		next['number-or-default'] = { 'a.ts': 3, 'c.ts': 1 };
		expect(growth(prev, next)).toEqual([
			{ rule: 'number-or-default', path: 'a.ts', from: 2, to: 3 },
			{ rule: 'number-or-default', path: 'c.ts', from: 0, to: 1 },
		]);
	});
	test('write → load round trip, keys sorted, empty rules dropped', () => {
		const r = repo();
		const c = emptyCounts();
		c['max-lines'] = { 'z.md': 900, 'a.md': 801 };
		writeBaseline(r.root, c);
		const text = readFileSync(join(r.root, BASELINE_FILE), 'utf8');
		expect(text).toBe(
			'{\n  "version": 1,\n  "rules": {\n    "max-lines": {\n      "a.md": 801,\n      "z.md": 900\n    }\n  }\n}\n',
		);
		expect(loadBaseline(r.root)?.['max-lines']).toEqual({ 'a.md': 801, 'z.md': 900 });
	});
	test('an existing tab-indented file keeps tabs (a repo formatter wrote it)', () => {
		const r = repo({ [BASELINE_FILE]: '{\n\t"version": 1,\n\t"rules": {}\n}\n' });
		writeBaseline(r.root, emptyCounts());
		expect(readFileSync(join(r.root, BASELINE_FILE), 'utf8')).toBe(
			'{\n\t"version": 1,\n\t"rules": {}\n}\n',
		);
	});
	test('no file → null', () => {
		expect(loadBaseline(repo().root)).toBeNull();
	});
	const bad: [string, string][] = [
		['{', 'not JSON'],
		['{"version": 2, "rules": {}}', 'version must be 1'],
		['{"version": 1, "extra": 1}', 'unknown field «extra»'],
		['{"version": 1, "rules": {"no-rule": {}}}', 'unknown rule «no-rule»'],
		['{"version": 1, "rules": {"max-lines": []}}', 'must map paths to counts'],
		['{"version": 1, "rules": {"max-lines": {"a.md": 0}}}', 'must be a positive integer'],
		['{"version": 1, "rules": {"max-lines": {"a.md": "9"}}}', 'must be a positive integer'],
	];
	for (const [text, message] of bad) {
		test(`rejects ${text}`, () => {
			const r = repo();
			writeFileSync(join(r.root, BASELINE_FILE), text);
			expect(() => loadBaseline(r.root)).toThrow(message);
		});
	}
});
