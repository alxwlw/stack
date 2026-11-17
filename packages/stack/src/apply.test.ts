import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'bun:test';
import { isSeq, parseDocument } from 'yaml';

import { applyChanges, renderChanges } from './apply.ts';
import type { Change } from './findings.ts';
import { repoDir } from './testkit.ts';

test('две записи одного каталога — один итог на файл, обе записи в нём, комментарий цел', () => {
	const ws = 'packages:\n  - packages/*\ncatalogs:\n  # из канона\n  dev:\n    oxlint: 1.70.0\n';
	const out = renderChanges(new Map([['pnpm-workspace.yaml', ws]]), [
		{
			file: 'pnpm-workspace.yaml',
			kind: 'yaml-set',
			path: ['catalogs', 'dev', 'oxlint'],
			value: '1.83.0',
		},
		{
			file: 'pnpm-workspace.yaml',
			kind: 'yaml-set',
			path: ['catalogs', 'dev', 'typescript'],
			value: '7.0.2',
		},
	]);
	expect([...out.keys()]).toEqual(['pnpm-workspace.yaml']);
	const text = out.get('pnpm-workspace.yaml') ?? '';
	expect(text).toContain('# из канона');
	expect(text).toContain('oxlint: 1.83.0');
	expect(text).toContain('typescript: 7.0.2');
});

test('разные виды правок одного файла — ошибка программы', () => {
	expect(() =>
		renderChanges(new Map(), [
			{ file: 'a', kind: 'write', content: 'x' },
			{ file: 'a', kind: 'json-set', path: ['k'], value: 'v' },
		]),
	).toThrow('conflicting changes for a');
});

test('две записи write в один файл — побеждает последняя', () => {
	const out = renderChanges(new Map(), [
		{ file: 'a', kind: 'write', content: 'первая' },
		{ file: 'a', kind: 'write', content: 'вторая' },
	]);
	expect(out.get('a')).toBe('вторая');
});

test('json-set подряд по одному файлу: обе правки в нём, отступы целы', () => {
	const out = renderChanges(new Map([['p.json', '{\n    "a": "1",\n    "b": "2"\n}\n']]), [
		{ file: 'p.json', kind: 'json-set', path: ['a'], value: 'x' },
		{ file: 'p.json', kind: 'json-set', path: ['b'], value: 'y' },
	]);
	expect(out.get('p.json')).toBe('{\n    "a": "x",\n    "b": "y"\n}\n');
});

const WS = 'packages:\n  - packages/*\n# из канона\ncatalogs:\n  dev:\n    a: 1.0.0\n';

test('applyChanges: write во вложенный путь создаёт каталоги, yaml-set правит файл из снимка', () => {
	const root = repoDir({ 'ws.yaml': WS });
	applyChanges(
		root,
		[{ file: '.moon/tasks/x.yml', kind: 'write', content: 'tasks: {}\n' }],
		new Map(),
	);
	expect(readFileSync(join(root, '.moon/tasks/x.yml'), 'utf8')).toBe('tasks: {}\n');
	applyChanges(
		root,
		[
			{ file: 'ws.yaml', kind: 'yaml-set', path: ['catalogs', 'dev', 'a'], value: '2.0.0' },
			{ file: 'ws.yaml', kind: 'yaml-set', path: ['catalogs', 'dev', 'b'], value: '3.0.0' },
		],
		new Map([['ws.yaml', WS]]),
	);
	expect(readFileSync(join(root, 'ws.yaml'), 'utf8')).toBe(
		'packages:\n  - packages/*\n# из канона\ncatalogs:\n  dev:\n    a: 2.0.0\n    b: 3.0.0\n',
	);
});

// Диск читает загрузчик, один раз: применитель правит то, что в снимке, а не то, что лежит сейчас.
test('applyChanges: текущее содержимое берётся из снимка, а не с диска', () => {
	const root = repoDir({ 'ws.yaml': 'disk: 1\n' });
	applyChanges(
		root,
		[{ file: 'ws.yaml', kind: 'yaml-set', path: ['snap'], value: '2' }],
		new Map([['ws.yaml', 'snapshot: 1\n']]),
	);
	expect(readFileSync(join(root, 'ws.yaml'), 'utf8')).toBe("snapshot: 1\nsnap: '2'\n");
});

test('applyChanges: файла нет в снимке — правка создаёт его', () => {
	const root = repoDir({});
	applyChanges(
		root,
		[{ file: 'p.json', kind: 'json-set', path: ['packageManager'], value: 'pnpm@1.0.0' }],
		new Map(),
	);
	expect(readFileSync(join(root, 'p.json'), 'utf8')).toBe('{"packageManager":"pnpm@1.0.0"}');
});

const W = 'pnpm-workspace.yaml';
const append = (value: string, path: string[] = ['list']): Change => ({
	file: W,
	kind: 'yaml-append',
	path,
	value,
});
const render = (current: string | undefined, changes: Change[]): string =>
	renderChanges(new Map([[W, current]]), changes).get(W) ?? '';
const js = (text: string) => parseDocument(text).toJS();

test.each<[string, string | undefined]>([
	['ключа нет', 'packages:\n  - packages/*\n'],
	['ключ без значения', 'packages:\n  - packages/*\nlist:\n'],
	['пустая последовательность', 'packages:\n  - packages/*\nlist: []\n'],
	['файл пуст', ''],
	['файла нет', undefined],
])('yaml-append: %s — последовательность создаётся, записи идут в порядке правок', (_, current) => {
	const out = render(current, [append('a@1'), append('@scope/b@2')]);
	expect(isSeq(parseDocument(out).get('list'))).toBe(true);
	expect(js(out)).toEqual({ ...js(current ?? ''), list: ['a@1', '@scope/b@2'] });
});

test('yaml-append: существующая последовательность — в конец; чужие записи, порядок и комментарии целы', () => {
	const current =
		'# шапка\nlist:\n  # про foo\n  - foo@1.0.0 # держим\n  - bar\n  # хвост\nnext: 1\n';
	const out = render(current, [append('a@1'), append('@scope/b@2')]);
	expect(js(out)).toEqual({ list: ['foo@1.0.0', 'bar', 'a@1', '@scope/b@2'], next: 1 });
	for (const comment of ['# шапка', '# про foo', '# держим', '# хвост']) {
		expect(out).toContain(comment);
	}
	// Как и ключи каталогов: scoped-имя в одинарных кавычках, иначе у потребителя краснеет oxfmt.
	expect(out).toContain("  - '@scope/b@2'\n");
});

test.each([
	['в строке ключа', 'list: # держим\nnext: 1\n', '# держим'],
	['под ключом', 'list:\n  # потом\nnext: 1\n', '# потом'],
])('yaml-append: ключ без значения — комментарий %s остаётся', (_, current, comment) => {
	const out = render(current, [append('a@1')]);
	expect(js(out)).toEqual({ list: ['a@1'], next: 1 });
	expect(out).toContain(comment);
});

test('yaml-append: нестроковые элементы последовательности остаются на месте', () => {
	const out = render('list:\n  - 5\n  - { a: b }\n  -\n', [append('a@1')]);
	expect(js(out).list).toEqual([5, { a: 'b' }, null, 'a@1']);
});

test('yaml-set и yaml-append одного файла совместимы, их взаимный порядок на итог не влияет', () => {
	const current = "catalogs:\n  dev:\n    x: 1.0.0\nlist:\n  - foo\n  - 'own@1'\n";
	const changes: Change[] = [
		{ file: W, kind: 'yaml-set', path: ['catalogs', 'dev', 'x'], value: '2.0.0' },
		{ file: W, kind: 'yaml-set', path: ['list', 1], value: 'own@1 || 2' },
		append('a@1'),
	];
	const out = render(current, changes);
	expect(js(out)).toEqual({
		catalogs: { dev: { x: '2.0.0' } },
		list: ['foo', 'own@1 || 2', 'a@1'],
	});
	expect(render(current, [...changes].reverse())).toBe(out);
});

test.each([
	['скаляр', 'list: foo\n'],
	['map', 'list: { a: b }\n'],
	['alias', 'shared: &shared\n  - a\nlist: *shared\n'],
])('yaml-append: по пути %s — ошибка с именем файла и ключа', (_, current) => {
	expect(() => render(current, [append('a@1')])).toThrow(
		'pnpm-workspace.yaml: list is not a sequence',
	);
});

test('yaml-append: вложенный путь — недостающие узлы создаются, в ошибке путь через точку', () => {
	expect(js(render('b: 1\n', [append('x', ['a', 'list'])]))).toEqual({ b: 1, a: { list: ['x'] } });
	expect(() => render('a:\n  list: 5\n', [append('x', ['a', 'list'])])).toThrow(
		'pnpm-workspace.yaml: a.list is not a sequence',
	);
});

test.each<[string, Change]>([
	['write', { file: W, kind: 'write', content: 'x' }],
	['json-set', { file: W, kind: 'json-set', path: ['k'], value: 'v' }],
])('yaml-append и %s одного файла — ошибка программы', (_, other) => {
	expect(() => render('', [append('a@1'), other])).toThrow(`conflicting changes for ${W}`);
	expect(() => render('', [other, append('a@1')])).toThrow(`conflicting changes for ${W}`);
});
