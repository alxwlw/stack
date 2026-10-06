import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

import type { Canon } from './canon.ts';
import { checkRepo, syncRepo } from './check.ts';

const canon: Canon = {
	files: [{ dest: '.editorconfig', content: 'root = true\n' }],
	catalogs: { dev: { oxlint: '1.83.0' } },
	nodePin: '26.8.1',
};

test('исключение, которое ни к чему не подошло, — единственная находка: stale-exception', () => {
	const repo = mkdtempSync(join(tmpdir(), 'stack-repo-'));
	writeFileSync(join(repo, 'package.json'), '{ "name": "r" }');
	const empty: Canon = { ...canon, files: [], catalogs: {} };
	const codes = checkRepo(repo, empty, [{ file: '.нет-такого', reason: 'протухло' }]).map(
		(f) => f.code,
	);
	expect(codes).toEqual(['stale-exception']);
});

test('исключение, подошедшее к находке, не мешает другому остаться протухшим', () => {
	const repo = mkdtempSync(join(tmpdir(), 'stack-repo-'));
	const findings = checkRepo(repo, canon, [
		{ file: '.editorconfig', reason: 'легитимный отступ' },
		{ file: '.нет-такого', reason: 'протухло' },
	]);
	const editorconfig = findings.find((f) => f.target === '.editorconfig');
	expect(editorconfig?.code).toBe('file-missing');
	expect(editorconfig?.suppressedBy?.reason).toBe('легитимный отступ');
	const stale = findings.filter((f) => f.code === 'stale-exception');
	expect(stale).toHaveLength(1);
	expect(stale[0]?.target).toBe('.нет-такого');
});

test('checkRepo агрегирует находки из разных источников: файл и каталог одновременно', () => {
	const repo = mkdtempSync(join(tmpdir(), 'stack-repo-'));
	writeFileSync(join(repo, '.editorconfig'), 'сломали\n');
	writeFileSync(
		join(repo, 'pnpm-workspace.yaml'),
		'packages:\n  - packages/*\n\ncatalogs:\n  dev:\n    oxlint: 1.70.0\n',
	);
	const codes = checkRepo(repo, canon, []).map((f) => f.code);
	expect(codes).toContain('file-drift');
	expect(codes).toContain('catalog-drift');
});

test('sync не трогает файл, удержанный исключением, и check после него без stale-exception', () => {
	const repo = mkdtempSync(join(tmpdir(), 'stack-repo-'));
	writeFileSync(join(repo, '.editorconfig'), 'свой отступ\n');
	const exceptions = [{ file: '.editorconfig', reason: 'легитимный отступ' }];
	const { applied, held } = syncRepo(repo, canon, exceptions);
	expect(applied).toEqual([]);
	expect(held.map((f) => [f.code, f.suppressedBy?.reason])).toEqual([
		['file-drift', 'легитимный отступ'],
	]);
	expect(readFileSync(join(repo, '.editorconfig'), 'utf8')).toBe('свой отступ\n');
	expect(checkRepo(repo, canon, exceptions).filter((f) => !f.suppressedBy)).toEqual([]);
});

test('sync оставляет запись каталога, удержанную catalog+name, и применяет остальное', () => {
	const repo = mkdtempSync(join(tmpdir(), 'stack-repo-'));
	writeFileSync(
		join(repo, 'pnpm-workspace.yaml'),
		'packages:\n  - packages/*\n\ncatalogs:\n  dev:\n    oxlint: 1.70.0\n',
	);
	const exceptions = [{ catalog: 'dev', name: 'oxlint', reason: 'ждём апстрим-фикс' }];
	const { applied, held } = syncRepo(repo, canon, exceptions);
	// .editorconfig не удержан — он засеян; oxlint удержан — остался 1.70.0.
	expect(applied.map((d) => d.target)).toEqual(['.editorconfig']);
	expect(held.map((f) => f.target)).toEqual(['catalogs.dev.oxlint']);
	expect(readFileSync(join(repo, '.editorconfig'), 'utf8')).toBe('root = true\n');
	expect(readFileSync(join(repo, 'pnpm-workspace.yaml'), 'utf8')).toContain('oxlint: 1.70.0');
	expect(checkRepo(repo, canon, exceptions).filter((f) => !f.suppressedBy)).toEqual([]);
});

test('sync без исключений применяет весь план — как раньше', () => {
	const repo = mkdtempSync(join(tmpdir(), 'stack-repo-'));
	writeFileSync(join(repo, '.editorconfig'), 'сломали\n');
	const { applied, held } = syncRepo(repo, canon, []);
	expect(applied.map((d) => d.code)).toEqual(['file-drift']);
	expect(held).toEqual([]);
	expect(readFileSync(join(repo, '.editorconfig'), 'utf8')).toBe('root = true\n');
});
