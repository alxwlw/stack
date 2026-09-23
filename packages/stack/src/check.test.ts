import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

import type { Canon } from './canon.ts';
import { checkRepo } from './check.ts';

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
