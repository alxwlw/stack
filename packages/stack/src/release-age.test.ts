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
import { ACME_SETTINGS } from './testkit-sources.ts';

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

test('своя запись с другими версиями заменяется одной текущей', () => {
	const out = rendered(ws(`${AGE}minimumReleaseAgeExclude:\n  - '@alxwlw/stack@1.8.0 || 1.9.2'\n`));
	expect(list(out)).toEqual(['@alxwlw/stack@1.10.0']);
});

test.each(['@alxwlw/stack@1.9.2 || 1.10.0', '@alxwlw/stack', '@alxwlw/*', '@alxwlw/stack@1.10.0'])(
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

// Приёмка 8: текст файла отличается только своей записью — соседи, порядок, кавычки, комментарии
// (в том числе на строке самой записи) и всё, что стоит после списка, на месте.
const around = (own: string): string =>
	ws(
		`${AGE}# держим по причине\n${KEY}:\n  - foo@1.0.0 # временно\n  # - '@alxwlw/other@0.1.0'\n` +
			`  - ${own} # свой\n  - "bar"\n\n# хвост\nlinkWorkspacePackages: true\n`,
	);

test.each([
	["'@alxwlw/stack@1.8.0 || 1.9.2'", "'@alxwlw/stack@1.10.0'"],
	['"@alxwlw/stack@1.8.0 || 1.9.2"', '"@alxwlw/stack@1.10.0"'],
])('текст файла отличается только своей записью (%s)', (before, after) => {
	expect(rendered(around(before))).toBe(around(after));
});

const ELEVEN = Array.from({ length: 11 }, (_, i) => `1.8.${i}`).join(' || ');
test.each([
	['одна старая версия', '@alxwlw/stack@1.9.2'],
	['одиннадцать версий без текущей', `@alxwlw/stack@${ELEVEN}`],
	['диапазон', '@alxwlw/stack@^1.0.0'],
	['шаблон версии', '@alxwlw/stack@1.x'],
	['пусто после @', '@alxwlw/stack@'],
])('своя запись, не покрывающая версию (%s), становится одной текущей', (_name, entry) => {
	const text = ws(`${AGE}${KEY}:\n  - '${entry}'\n`);
	expect(drift(text)).toHaveLength(1);
	expect(list(rendered(text))).toStrictEqual(['@alxwlw/stack@1.10.0']);
});

test('закомментированная запись — не запись: комментарий на месте, новая идёт в конец', () => {
	const out = rendered(ws(`${AGE}${KEY}:\n  - foo\n  # - '@alxwlw/stack@1.6.0'\n`));
	expect(list(out)).toStrictEqual(['foo', '@alxwlw/stack@1.10.0']);
	expect(out).toContain("# - '@alxwlw/stack@1.6.0'");
});

test('удержанная исключением своя запись не меняется', () => {
	const text = ws(`${AGE}${KEY}:\n  - '@alxwlw/stack@1.8.0 || 1.9.2'\n`);
	const held = [{ catalog: 'dev', name: '@alxwlw/stack', reason: 'держим' }];
	expect(rendered(text, canon, held)).toBe(text);
});

test('две свои записи без текущей версии — переписана первая, вторая не тронута', () => {
	const out = rendered(ws(`${AGE}${KEY}:\n  - '@alxwlw/stack@1.0.0'\n  - '@alxwlw/stack@1.1.0'\n`));
	expect(list(out)).toStrictEqual(['@alxwlw/stack@1.10.0', '@alxwlw/stack@1.1.0']);
});

test('второй sync пуст, а следующая версия канона снова оставляет одну запись', () => {
	const once = rendered(ws(`${AGE}${KEY}:\n  - '@alxwlw/stack@1.8.0 || 1.9.2'\n`));
	expect(drift(once)).toStrictEqual([]);
	const next = testCanon({ catalogs: { dev: { '@alxwlw/stack': '1.11.0', oxlint: '1.90.0' } } });
	expect(list(rendered(once, next))).toStrictEqual(['@alxwlw/stack@1.11.0']);
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
	expect(list(out)).toEqual(['@alxwlw/stack@1.10.0']);
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

test('несколько пакетов: своя запись заменяется на месте, новая идёт в конец', () => {
	const out = rendered(
		ws2(`${AGE}minimumReleaseAgeExclude:\n  - foo\n  - '@alxwlw/stack@1.0.0'\n`),
		canon2,
	);
	expect(list(out)).toEqual(['foo', '@alxwlw/stack@1.10.0', '@alxwlw/other@2.0.0']);
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
			value: '@alxwlw/stack@1.10.0',
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
	['@alxwlw/other', ['foo', '@alxwlw/stack@1.10.0', OWN['@alxwlw/third']]],
	['@alxwlw/third', ['foo', '@alxwlw/stack@1.10.0', OWN['@alxwlw/other']]],
])('замена своей записи и добавления, удержан %s', (name, expected) => {
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

const transitive = testCanon({
	catalogs: { dev: { '@alxwlw/stack': '1.2.3' } },
	ownPackages: [
		{ name: '@alxwlw/stack', version: '1.2.3' },
		{ name: '@alxwlw/repo-rules', version: '1.2.3' },
	],
});

const wsTransitive = (extra: string) =>
	`packages:\n  - packages/*\n\ncatalogs:\n  dev:\n    '@alxwlw/stack': 1.2.3\n${extra}`;

test('свой пакет вне каталога dev получает запись', () => {
	const found = drift(wsTransitive(AGE), transitive);
	expect(found.map((f) => f.target)).toStrictEqual([
		'minimumReleaseAgeExclude.@alxwlw/stack',
		'minimumReleaseAgeExclude.@alxwlw/repo-rules',
	]);
	expect(found[1]?.change).toStrictEqual({
		kind: 'yaml-append',
		file: 'pnpm-workspace.yaml',
		path: ['minimumReleaseAgeExclude'],
		value: '@alxwlw/repo-rules@1.2.3',
	});
});

test.each(['@alxwlw/*', '@alxwlw/repo-rules'])(
	'запись %s покрывает свой пакет вне каталога',
	(entry) => {
		const text = wsTransitive(`${AGE}${KEY}:\n  - '@alxwlw/stack@1.2.3'\n  - '${entry}'\n`);
		expect(drift(text, transitive)).toStrictEqual([]);
	},
);

test('находку для пакета вне каталога удерживает исключение catalog+name', () => {
	const text = wsTransitive(AGE);
	const exception = { catalog: 'dev', name: '@alxwlw/repo-rules', reason: 'держим' };
	const found = check(testRepo(transitive, { 'pnpm-workspace.yaml': text }), transitive, [
		exception,
	]);
	const mine = found.filter((f) => f.code === 'release-age-exclude');
	expect(mine.find((f) => f.target.endsWith('@alxwlw/repo-rules'))?.suppressedBy?.reason).toBe(
		'держим',
	);
	expect(found.some((f) => f.code === 'stale-exception')).toBe(false);
	expect(rendered(text, transitive, [exception])).not.toContain('@alxwlw/repo-rules');
});

test('запись <scope>/* покрывает пакеты своего scope и не покрывает пакет, названный точным именем', () => {
	const acme = testCanon({
		settings: ACME_SETTINGS,
		catalogs: { dev: { '@acme/lint': '1.0.0', 'acme-engine': '2.0.0' } },
	});
	const text = `packages:\n  - packages/*\n\n${AGE}${KEY}:\n  - '@acme/*'\n  - '@alxwlw/*'\n`;
	expect(drift(text, acme).map((d) => d.fix)).toStrictEqual([
		'minimumReleaseAgeExclude: acme-engine@2.0.0',
	]);
});
