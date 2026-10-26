import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

import { applyChanges, renderChanges } from './apply.ts';

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

test('applyChanges: write во вложенный путь создаёт каталоги, yaml-set правит существующий файл', () => {
	const root = mkdtempSync(join(tmpdir(), 'stack-apply-'));
	applyChanges(root, [
		{ file: '.moon/tasks/x.yml', kind: 'write', content: 'tasks: {}\n' },
		{
			file: 'ws.yaml',
			kind: 'write',
			content: 'packages:\n  - packages/*\n# из канона\ncatalogs:\n  dev:\n    a: 1.0.0\n',
		},
	]);
	expect(readFileSync(join(root, '.moon/tasks/x.yml'), 'utf8')).toBe('tasks: {}\n');
	applyChanges(root, [
		{ file: 'ws.yaml', kind: 'yaml-set', path: ['catalogs', 'dev', 'a'], value: '2.0.0' },
		{ file: 'ws.yaml', kind: 'yaml-set', path: ['catalogs', 'dev', 'b'], value: '3.0.0' },
	]);
	expect(readFileSync(join(root, 'ws.yaml'), 'utf8')).toBe(
		'packages:\n  - packages/*\n# из канона\ncatalogs:\n  dev:\n    a: 2.0.0\n    b: 3.0.0\n',
	);
});
