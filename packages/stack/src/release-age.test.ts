import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'bun:test';
import { isSeq, parseDocument } from 'yaml';

import { renderChanges } from './apply.ts';
import type { Canon } from './canon.ts';
import { check, plan, syncRepo } from './check.ts';
import { type Exception, isHeld, resolve } from './exceptions.ts';
import type { Change } from './findings.ts';
import { WORKSPACE_FILE } from './repo.ts';
import { repoDir, testCanon, testRepo } from './testkit.ts';

const KEY = 'minimumReleaseAgeExclude';

const canon = testCanon({ catalogs: { dev: { '@alxwlw/stack': '1.10.0', oxlint: '1.90.0' } } });

const ws = (extra: string) =>
	`packages:\n  - packages/*\n\ncatalogs:\n  dev:\n    '@alxwlw/stack': 1.10.0\n    oxlint: 1.90.0\n${extra}`;
const AGE = 'minimumReleaseAge: 1440\n';

const drift = (text: string, c: Canon = canon) =>
	plan(testRepo(c, { 'pnpm-workspace.yaml': text }), c).filter(
		(f) => f.code === 'release-age-exclude',
	);

// sync на значениях: план → удержание → итоговый текст файла; диск не участвует.
function rendered(text: string, c: Canon = canon, exceptions: Exception[] = []): string {
	const repo = testRepo(c, { [WORKSPACE_FILE]: text });
	const applied = resolve(plan(repo, c), exceptions).findings.filter((d) => !isHeld(d));
	return (
		renderChanges(
			repo.files,
			applied.map((d) => d.change),
		).get(WORKSPACE_FILE) ?? text
	);
}
const list = (out: string): unknown => parseDocument(out).toJS().minimumReleaseAgeExclude;

test('без minimumReleaseAge находок нет', () => {
	expect(drift(ws(''))).toEqual([]);
});

test('minimumReleaseAge: 0 — находок нет', () => {
	expect(drift(ws('minimumReleaseAge: 0\n'))).toEqual([]);
});

test('нет записи — sync добавляет @alxwlw/stack@1.10.0', () => {
	const out = rendered(ws(`${AGE}minimumReleaseAgeExclude:\n  - foo@1.0.0\n`));
	expect(list(out)).toEqual(['foo@1.0.0', '@alxwlw/stack@1.10.0']);
	expect(out).not.toContain('oxlint@');
});

test('запись с другими версиями дополняется', () => {
	const out = rendered(ws(`${AGE}minimumReleaseAgeExclude:\n  - '@alxwlw/stack@1.8.0 || 1.9.2'\n`));
	expect(list(out)).toEqual(['@alxwlw/stack@1.8.0 || 1.9.2 || 1.10.0']);
});

test.each(['@alxwlw/stack@1.9.2 || 1.10.0', '@alxwlw/stack', '@alxwlw/*'])(
	'версия уже покрыта — находок нет, sync ничего не пишет (%s)',
	(entry) => {
		const text = ws(`${AGE}minimumReleaseAgeExclude:\n  - '${entry}'\n`);
		expect(drift(text)).toEqual([]);
		expect(rendered(text)).toBe(text);
	},
);

test('чужие записи, их порядок и комментарии не трогаются', () => {
	const out = rendered(
		ws(`${AGE}# держим по причине\n${KEY}:\n  - foo@1.0.0 # временно\n  - bar\n`),
	);
	expect(list(out)).toEqual(['foo@1.0.0', 'bar', '@alxwlw/stack@1.10.0']);
	expect(out).toContain('# держим по причине');
	expect(out).toContain('# временно');
});

test('ключа нет — создаётся последовательность, а не map', () => {
	const out = rendered(ws(AGE));
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
	expect(rendered(text, canon, [exception])).toBe(text);
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
	const out = rendered(ws(`${AGE}minimumReleaseAgeExclude:\n  - '@alxwlw/stack@1.8.0||1.9.2'\n`));
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

const canon2 = testCanon({
	catalogs: { dev: { '@alxwlw/stack': '1.10.0', '@alxwlw/other': '2.0.0', oxlint: '1.90.0' } },
});
const ws2 = (extra: string) =>
	`packages:\n  - packages/*\n\ncatalogs:\n  dev:\n    '@alxwlw/stack': 1.10.0\n    '@alxwlw/other': 2.0.0\n    oxlint: 1.90.0\n${extra}`;

test('несколько пакетов: своя запись дополняется, новая идёт в конец', () => {
	const out = rendered(
		ws2(`${AGE}minimumReleaseAgeExclude:\n  - foo\n  - '@alxwlw/stack@1.0.0'\n`),
		canon2,
	);
	expect(list(out)).toEqual(['foo', '@alxwlw/stack@1.0.0 || 1.10.0', '@alxwlw/other@2.0.0']);
});

test('несколько пакетов без ключа — обе записи', () => {
	const out = rendered(ws2(AGE), canon2);
	expect(list(out)).toEqual(['@alxwlw/stack@1.10.0', '@alxwlw/other@2.0.0']);
});

test('ключ есть, значения нет — последовательность создаётся, sync не падает', () => {
	const out = rendered(ws(`${AGE}minimumReleaseAgeExclude:\n`));
	expect(list(out)).toEqual(['@alxwlw/stack@1.10.0']);
	expect(list(rendered(ws2(`${AGE}minimumReleaseAgeExclude:\n`), canon2))).toEqual([
		'@alxwlw/stack@1.10.0',
		'@alxwlw/other@2.0.0',
	]);
});

test.each(['foo', '{ a: b }'])(
	'minimumReleaseAgeExclude не последовательность (%s) — находок нет, текст прежний',
	(value) => {
		const text = ws(`${AGE}minimumReleaseAgeExclude: ${value}\n`);
		expect(drift(text)).toEqual([]);
		expect(rendered(text)).toBe(text);
	},
);

const OWN = {
	'@alxwlw/stack': '@alxwlw/stack@1.10.0',
	'@alxwlw/other': '@alxwlw/other@2.0.0',
	'@alxwlw/third': '@alxwlw/third@3.0.0',
} as const;
type Name = keyof typeof OWN;
const NAMES = Object.keys(OWN) as Name[];
const canon3 = testCanon({
	catalogs: {
		dev: {
			'@alxwlw/stack': '1.10.0',
			'@alxwlw/other': '2.0.0',
			'@alxwlw/third': '3.0.0',
			oxlint: '1.90.0',
		},
	},
});
const ws3 = (extra: string) =>
	`packages:\n  - packages/*\n\ncatalogs:\n  dev:\n    '@alxwlw/stack': 1.10.0\n    '@alxwlw/other': 2.0.0\n    '@alxwlw/third': 3.0.0\n    oxlint: 1.90.0\n${AGE}${extra}`;
const hold = (...names: string[]): Exception[] =>
	names.map((name) => ({ catalog: 'dev', name, reason: 'держим' }));
const changes = (text: string): Change[] =>
	plan(testRepo(canon3, { [WORKSPACE_FILE]: text }), canon3)
		.filter((f) => f.code === 'release-age-exclude')
		.map((d) => d.change);

// Состояние ключа: название, хвост файла, чужие записи списка.
const STATES: [string, string, string[]][] = [
	['ключа нет', '', []],
	['ключ без значения', `${KEY}:\n`, []],
	['пустой список', `${KEY}: []\n`, []],
	['чужая запись', `${KEY}:\n  - foo@1.0.0\n`, ['foo@1.0.0']],
];
const OWN_ENTRY = `${KEY}:\n  - foo\n  - '@alxwlw/stack@1.0.0'\n`;

test.each(STATES)(
	'план не зависит от состояния ключа (%s): yaml-append на пакет, без индексов',
	(_, extra) => {
		expect(changes(ws3(extra))).toEqual(
			NAMES.map((name) => ({
				kind: 'yaml-append',
				file: WORKSPACE_FILE,
				path: [KEY],
				value: OWN[name],
			})),
		);
	},
);

test('своя запись с другой версией — yaml-set по её индексу, остальные пакеты — yaml-append', () => {
	expect(changes(ws3(OWN_ENTRY))).toEqual([
		{
			kind: 'yaml-set',
			file: WORKSPACE_FILE,
			path: [KEY, 1],
			value: '@alxwlw/stack@1.0.0 || 1.10.0',
		},
		{ kind: 'yaml-append', file: WORKSPACE_FILE, path: [KEY], value: OWN['@alxwlw/other'] },
		{ kind: 'yaml-append', file: WORKSPACE_FILE, path: [KEY], value: OWN['@alxwlw/third'] },
	]);
});

test.each<[string, string, string[]]>([
	['ключа нет', '', ['@alxwlw/other@2.0.0', '@alxwlw/third@3.0.0']],
	['ключ без значения', `${KEY}:\n`, ['@alxwlw/other@2.0.0', '@alxwlw/third@3.0.0']],
	[
		'чужая запись',
		`${KEY}:\n  - foo@1.0.0\n`,
		['foo@1.0.0', '@alxwlw/other@2.0.0', '@alxwlw/third@3.0.0'],
	],
])('удержан @alxwlw/stack (%s) — список без null, sync не падает', (_, extra, expected) => {
	expect(list(rendered(ws3(extra), canon3, hold('@alxwlw/stack')))).toEqual(expected);
});

// Все подмножества удержанных, кроме «удержано всё»: 7 подмножеств на каждое из 4 состояний ключа.
const SUBSETS = Array.from({ length: 2 ** NAMES.length - 1 }, (_, mask) =>
	NAMES.filter((_, i) => (mask & (1 << i)) !== 0),
);
test.each(
	STATES.flatMap(([state, extra, foreign]) =>
		SUBSETS.map((held): [string, string, string, string[], Name[]] => [
			state,
			held.join(', ') || 'ничего',
			extra,
			foreign,
			held,
		]),
	),
)(
	'%s, удержано: %s — применённые записи идут подряд в порядке канона',
	(_s, _h, extra, foreign, held) => {
		const out = rendered(ws3(extra), canon3, hold(...held));
		expect(list(out)).toEqual([
			...foreign,
			...NAMES.filter((name) => !held.includes(name)).map((name) => OWN[name]),
		]);
	},
);

test.each(STATES)('удержаны все записи (%s) — текст прежний', (_, extra) => {
	const text = ws3(extra);
	expect(rendered(text, canon3, hold(...NAMES))).toBe(text);
});

test.each<[Name, string[]]>([
	['@alxwlw/stack', ['foo', '@alxwlw/stack@1.0.0', OWN['@alxwlw/other'], OWN['@alxwlw/third']]],
	['@alxwlw/other', ['foo', '@alxwlw/stack@1.0.0 || 1.10.0', OWN['@alxwlw/third']]],
	['@alxwlw/third', ['foo', '@alxwlw/stack@1.0.0 || 1.10.0', OWN['@alxwlw/other']]],
])('дополнение своей записи и добавления, удержан %s', (name, expected) => {
	expect(list(rendered(ws3(OWN_ENTRY), canon3, hold(name)))).toEqual(expected);
});

test('нестроковые элементы списка — не свои, запись идёт в конец', () => {
	const out = rendered(ws(`${AGE}${KEY}:\n  - 5\n  - { a: b }\n`));
	expect(list(out)).toEqual([5, { a: 'b' }, '@alxwlw/stack@1.10.0']);
});

test('minimumReleaseAgeExclude — alias на последовательность: находок нет, текст прежний', () => {
	const text = ws(`${AGE}shared: &shared\n  - a\n${KEY}: *shared\n`);
	expect(drift(text)).toEqual([]);
	expect(rendered(text)).toBe(text);
});

test('ключ без значения с комментарием — комментарий остаётся', () => {
	const out = rendered(ws(`${AGE}${KEY}: # держим\n`));
	expect(list(out)).toEqual(['@alxwlw/stack@1.10.0']);
	expect(out).toContain('# держим');
});
