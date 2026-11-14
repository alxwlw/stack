import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'bun:test';
import { isSeq, parseDocument } from 'yaml';

import type { Canon } from './canon.ts';
import { check, plan, syncRepo } from './check.ts';
import { repoDir, testCanon, testRepo } from './testkit.ts';

const canon = testCanon({ catalogs: { dev: { '@alxwlw/stack': '1.10.0', oxlint: '1.90.0' } } });

const ws = (extra: string) =>
	`packages:\n  - packages/*\n\ncatalogs:\n  dev:\n    '@alxwlw/stack': 1.10.0\n    oxlint: 1.90.0\n${extra}`;
const AGE = 'minimumReleaseAge: 1440\n';

const drift = (text: string, c: Canon = canon) =>
	plan(testRepo(c, { 'pnpm-workspace.yaml': text }), c).filter(
		(f) => f.code === 'release-age-exclude',
	);

// sync на диске; возвращает итоговый pnpm-workspace.yaml и число применённых правок release-age.
function synced(text: string, c: Canon = canon): { out: string; applied: number } {
	const repo = repoDir({ 'pnpm-workspace.yaml': text });
	const { applied } = syncRepo(repo, c, []);
	return {
		out: readFileSync(join(repo, 'pnpm-workspace.yaml'), 'utf8'),
		applied: applied.filter((d) => d.code === 'release-age-exclude').length,
	};
}
const list = (out: string): unknown => parseDocument(out).toJS().minimumReleaseAgeExclude;

test('без minimumReleaseAge находок нет', () => {
	expect(drift(ws(''))).toEqual([]);
});

test('minimumReleaseAge: 0 — находок нет', () => {
	expect(drift(ws('minimumReleaseAge: 0\n'))).toEqual([]);
});

test('нет записи — sync добавляет @alxwlw/stack@1.10.0', () => {
	const { out } = synced(ws(`${AGE}minimumReleaseAgeExclude:\n  - foo@1.0.0\n`));
	expect(list(out)).toEqual(['foo@1.0.0', '@alxwlw/stack@1.10.0']);
	expect(out).not.toContain('oxlint@');
});

test('запись с другими версиями дополняется', () => {
	const { out } = synced(
		ws(`${AGE}minimumReleaseAgeExclude:\n  - '@alxwlw/stack@1.8.0 || 1.9.2'\n`),
	);
	expect(list(out)).toEqual(['@alxwlw/stack@1.8.0 || 1.9.2 || 1.10.0']);
});

test.each(['@alxwlw/stack@1.9.2 || 1.10.0', '@alxwlw/stack', '@alxwlw/*'])(
	'версия уже покрыта — находок нет, sync ничего не пишет (%s)',
	(entry) => {
		const text = ws(`${AGE}minimumReleaseAgeExclude:\n  - '${entry}'\n`);
		expect(drift(text)).toEqual([]);
		const { out, applied } = synced(text);
		expect(applied).toBe(0);
		expect(list(out)).toEqual([entry]);
	},
);

test('чужие записи и их порядок не трогаются', () => {
	const { out } = synced(
		ws(`${AGE}# держим по причине\nminimumReleaseAgeExclude:\n  - foo@1.0.0\n  - bar\n`),
	);
	expect(list(out)).toEqual(['foo@1.0.0', 'bar', '@alxwlw/stack@1.10.0']);
	expect(out).toContain('# держим по причине');
});

test('ключа нет — создаётся последовательность, а не map', () => {
	const { out } = synced(ws(AGE));
	const node = parseDocument(out).get('minimumReleaseAgeExclude');
	expect(isSeq(node)).toBe(true);
	expect(list(out)).toEqual(['@alxwlw/stack@1.10.0']);
});

test('исключение { catalog: dev, name: @alxwlw/stack } держит находку', () => {
	const text = ws(AGE);
	const exception = { catalog: 'dev', name: '@alxwlw/stack', reason: 'держим' };
	const found = check(testRepo(canon, { 'pnpm-workspace.yaml': text }), canon, [exception]);
	expect(
		found.filter((f) => f.code === 'release-age-exclude').map((f) => f.suppressedBy?.reason),
	).toEqual(['держим']);
	const repo = repoDir({ 'pnpm-workspace.yaml': text });
	syncRepo(repo, canon, [exception]);
	expect(readFileSync(join(repo, 'pnpm-workspace.yaml'), 'utf8')).toBe(text);
});

test('check показывает release-age-exclude как исправимую sync', () => {
	const found = check(testRepo(canon, { 'pnpm-workspace.yaml': ws(AGE) }), canon, []);
	const f = found.filter((x) => x.code === 'release-age-exclude');
	expect(f).toHaveLength(1);
	expect(f[0]).toHaveProperty('change');
	expect(f[0]?.target).toBe('minimumReleaseAgeExclude.@alxwlw/stack');
});

test('список без пробелов распознаётся', () => {
	const covered = ws(`${AGE}minimumReleaseAgeExclude:\n  - '@alxwlw/stack@1.8.0||1.10.0'\n`);
	expect(drift(covered)).toEqual([]);
	const { out } = synced(ws(`${AGE}minimumReleaseAgeExclude:\n  - '@alxwlw/stack@1.8.0||1.9.2'\n`));
	expect(list(out)).toEqual(['@alxwlw/stack@1.8.0||1.9.2 || 1.10.0']);
});

test('каталоги и release-age в одном sync', () => {
	const text = `# шапка\npackages:\n  - packages/*\n\n${AGE}\ncatalogs:\n  dev:\n    '@alxwlw/stack': 1.9.0 # старая\n`;
	const repo = repoDir({ 'pnpm-workspace.yaml': text });
	const { applied } = syncRepo(repo, canon, []);
	expect(applied.map((d) => d.code).sort()).toEqual([
		'catalog-drift',
		'catalog-missing',
		'release-age-exclude',
	]);
	const out = readFileSync(join(repo, 'pnpm-workspace.yaml'), 'utf8');
	expect(out).toContain('# шапка');
	expect(out).toContain('# старая');
	const js = parseDocument(out).toJS();
	expect(js.catalogs.dev['@alxwlw/stack']).toBe('1.10.0');
	expect(js.minimumReleaseAgeExclude).toEqual(['@alxwlw/stack@1.10.0']);
});
