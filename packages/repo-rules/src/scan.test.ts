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
	test('suppression-reason and number-or-default follow the family; markdown is not scanned', () => {
		const r = repo({
			'docs/a.md': '// eslint-disable-line x\n',
			'src/t.py': 'x = 1  # noqa\nport = Number(env.P) || 8080\n',
			'src/s.sol': '// solhint-disable-line\n',
			'src/w.t.sol': "it.skip('a', () => {});\n",
		});
		const res = scan(r.root, loadConfig(r.root));
		expect(res.actual['suppression-reason']).toEqual({ 'src/t.py': 1, 'src/s.sol': 1 });
		expect(res.actual['number-or-default']).toEqual({});
		expect(res.actual['focused-skipped-tests']).toEqual({});
	});
	test('a file with two hits counts two and lists both', () => {
		const r = repo({
			'src/two.ts':
				'const a = 1;\n// eslint-disable-next-line one\nx();\n// eslint-disable-line two\n',
			'src/two.test.ts': "it.skip('a', () => {});\nit.skip('b', () => {});\n",
		});
		const res = scan(r.root, loadConfig(r.root));
		expect(res.actual['suppression-reason']).toEqual({ 'src/two.ts': 2 });
		expect(res.actual['focused-skipped-tests']).toEqual({ 'src/two.test.ts': 2 });
		expect(
			res.hits.filter((h) => h.path === 'src/two.ts').map((h) => `${h.line}:${h.message}`),
		).toEqual([
			'2:eslint-disable-next-line without a reason',
			'4:eslint-disable-line without a reason',
		]);
	});
	test('per-rule excludes apply to each rule, not only max-lines', () => {
		const r = repo({
			'.repo-rules.json': JSON.stringify({
				exclude: {
					'suppression-reason': ['gen/**'],
					'focused-skipped-tests': ['legacy/**'],
					'number-or-default': ['old/**'],
				},
			}),
			'gen/a.ts': '// eslint-disable-line x\n',
			'src/b.ts': '// eslint-disable-line x\n',
			'legacy/c.test.ts': "it.skip('a', () => {});\n",
			'src/d.test.ts': "it.skip('a', () => {});\n",
			'old/e.ts': 'const p = Number(env.P) || 8080;\n',
			'src/f.ts': 'const p = Number(env.P) || 8080;\n',
		});
		const res = scan(r.root, loadConfig(r.root));
		expect(res.actual['suppression-reason']).toEqual({ 'src/b.ts': 1 });
		expect(res.actual['focused-skipped-tests']).toEqual({ 'src/d.test.ts': 1 });
		expect(res.actual['number-or-default']).toEqual({ 'src/f.ts': 1 });
	});
	test('MAX_LINES_EXCLUDE exempts only max-lines; generated and built JS keep the other rules', () => {
		const r = repo({
			'src/generated/g.ts': '// eslint-disable-line x\nconst p = Number(env.P) || 8080;\n',
			'dist/d.js': '// eslint-disable-line x\n',
			'build/x.test.ts': "it.skip('a', () => {});\n",
		});
		const res = scan(r.root, loadConfig(r.root));
		expect(res.actual['max-lines']).toEqual({});
		expect(res.actual['suppression-reason']).toEqual({ 'src/generated/g.ts': 1, 'dist/d.js': 1 });
		expect(res.actual['number-or-default']).toEqual({ 'src/generated/g.ts': 1 });
		expect(res.actual['focused-skipped-tests']).toEqual({ 'build/x.test.ts': 1 });
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
	test('loadBaseline: exact messages, not only the substrings above', () => {
		const cases: [string, string][] = [
			['null', `${BASELINE_FILE}: version must be 1`],
			['{"version": "1", "rules": {}}', `${BASELINE_FILE}: version must be 1`],
			['{"version": 1, "rules": []}', `${BASELINE_FILE}: rules must be an object`],
			['{"version": 1, "rules": "x"}', `${BASELINE_FILE}: rules must be an object`],
			['{"version": 1, "extra": 1}', `${BASELINE_FILE}: unknown field «extra»`],
			['{"version": 1, "rules": {"no-rule": {}}}', `${BASELINE_FILE}: unknown rule «no-rule»`],
			[
				'{"version": 1, "rules": {"max-lines": null}}',
				`${BASELINE_FILE}: rules.max-lines must map paths to counts`,
			],
			[
				'{"version": 1, "rules": {"max-lines": {"a.md": 0}}}',
				`${BASELINE_FILE}: rules.max-lines["a.md"] must be a positive integer`,
			],
		];
		for (const [text, message] of cases) {
			const r = repo({ [BASELINE_FILE]: text });
			let got = 'no throw';
			try {
				loadBaseline(r.root);
			} catch (e) {
				got = (e as Error).message;
			}
			expect(got).toBe(message);
		}
	});
	test('loadBaseline: no rules key loads empty; a count of 1 and all four rules load; the file name is pinned', () => {
		expect(BASELINE_FILE).toBe('.repo-rules-baseline.json');
		const bare = repo({ [BASELINE_FILE]: '{"version": 1}\n' });
		expect(loadBaseline(bare.root)).toEqual(emptyCounts());
		const full = repo({
			[BASELINE_FILE]: JSON.stringify({
				version: 1,
				rules: {
					'max-lines': { 'a.md': 1 },
					'suppression-reason': { 'b.ts': 2 },
					'focused-skipped-tests': { 'c.test.ts': 3 },
					'number-or-default': { 'd.ts': 4 },
				},
			}),
		});
		expect(loadBaseline(full.root)).toEqual({
			'max-lines': { 'a.md': 1 },
			'suppression-reason': { 'b.ts': 2 },
			'focused-skipped-tests': { 'c.test.ts': 3 },
			'number-or-default': { 'd.ts': 4 },
		});
	});
	test('compare: a file at exactly its baseline is neither a violation nor stale; rules never mix', () => {
		const actual = emptyCounts();
		actual['suppression-reason'] = { 'mix.ts': 2, 'fresh.ts': 1 };
		actual['number-or-default'] = { 'mix.ts': 1 };
		const base = emptyCounts();
		base['suppression-reason'] = { 'mix.ts': 1 };
		base['number-or-default'] = { 'mix.ts': 1 };
		const hits = [
			hit('mix.ts', 1),
			hit('mix.ts', 5),
			hit('fresh.ts', 7),
			{ rule: 'number-or-default' as const, path: 'mix.ts', line: 9, message: 'Number(x) || 1' },
		];
		const cmp = compare(actual, hits, base);
		expect(cmp.violations.map((v) => `${v.path}:${v.line}:${v.message}`).sort()).toEqual([
			'fresh.ts:7:eslint-disable-line without a reason',
			'mix.ts:1:eslint-disable-line without a reason (baseline 1)',
			'mix.ts:5:eslint-disable-line without a reason (baseline 1)',
		]);
		expect(cmp.stale).toEqual([]);
	});
	test('growth: an unchanged entry and a shrinking one are not listed', () => {
		const prev = emptyCounts();
		prev['max-lines'] = { 'same.md': 900, 'down.md': 900 };
		const next = emptyCounts();
		next['max-lines'] = { 'same.md': 900, 'down.md': 850 };
		expect(growth(prev, next)).toEqual([]);
	});
	test('writeBaseline lists rules in REPO_RULES order, whatever the input key order', () => {
		const r = repo();
		const counts: ReturnType<typeof emptyCounts> = {
			'number-or-default': { 'a.ts': 1 },
			'focused-skipped-tests': {},
			'suppression-reason': {},
			'max-lines': { 'a.md': 801 },
		};
		writeBaseline(r.root, counts);
		const rules = JSON.parse(readFileSync(join(r.root, BASELINE_FILE), 'utf8')).rules;
		expect(Object.keys(rules)).toEqual(['max-lines', 'number-or-default']);
	});
});
