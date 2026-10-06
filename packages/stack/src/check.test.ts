import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

import type { Canon } from './canon.ts';
import { checkRepo, syncRepo } from './check.ts';

const canon: Canon = {
	files: [{ dest: '.editorconfig', content: 'root = true\n' }],
	catalogs: { dev: { oxlint: '1.83.0' } },
	nodePin: '26.8.1',
	// Не реальный пин канона — см. package-manager.test.ts.
	pnpmPin: '10.99.0',
};

test('исключение на .prototools держит и packageManager — в sync и в check', () => {
	const repo = mkdtempSync(join(tmpdir(), 'stack-repo-'));
	const withPrototools: Canon = {
		...canon,
		files: [{ dest: '.prototools', content: 'pnpm = "10.99.0"\n' }],
	};
	writeFileSync(join(repo, '.prototools'), 'pnpm = "11.1.2"\n');
	writeFileSync(join(repo, 'package.json'), '{ "name": "r", "packageManager": "pnpm@11.1.2" }');
	const exceptions = [{ file: '.prototools', reason: 'новый пин ещё не проверен' }];

	const { applied, held } = syncRepo(repo, withPrototools, exceptions);
	expect(applied).toEqual([]);
	expect(held.map((f) => f.code).sort()).toEqual(['file-drift', 'package-manager']);
	expect(readFileSync(join(repo, 'package.json'), 'utf8')).toContain('pnpm@11.1.2');

	const findings = checkRepo(repo, withPrototools, exceptions);
	expect(findings.filter((f) => !f.suppressedBy)).toEqual([]);
	expect(findings.map((f) => f.code).sort()).toEqual(['file-drift', 'package-manager']);
});

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
	// Вторая запись dev-каталога: соседняя запись в том же файле не должна затереть удержанную
	// (planCatalogs делит один doc на все записи, apply пишет файл целиком).
	const twoEntries: Canon = {
		...canon,
		catalogs: { dev: { oxlint: '1.83.0', typescript: '7.0.2' } },
	};
	const exceptions = [{ catalog: 'dev', name: 'oxlint', reason: 'ждём апстрим-фикс' }];
	const { applied, held } = syncRepo(repo, twoEntries, exceptions);
	expect(applied.map((d) => d.target).sort()).toEqual(['.editorconfig', 'catalogs.dev.typescript']);
	expect(held.map((f) => f.target)).toEqual(['catalogs.dev.oxlint']);
	expect(readFileSync(join(repo, '.editorconfig'), 'utf8')).toBe('root = true\n');
	const workspace = readFileSync(join(repo, 'pnpm-workspace.yaml'), 'utf8');
	expect(workspace).toContain('oxlint: 1.70.0');
	expect(workspace).toContain('typescript: 7.0.2');
	expect(checkRepo(repo, twoEntries, exceptions).filter((f) => !f.suppressedBy)).toEqual([]);
});

test('sync без исключений применяет весь план — как раньше', () => {
	const repo = mkdtempSync(join(tmpdir(), 'stack-repo-'));
	writeFileSync(join(repo, '.editorconfig'), 'сломали\n');
	const { applied, held } = syncRepo(repo, canon, []);
	expect(applied.map((d) => d.code)).toEqual(['file-drift']);
	expect(held).toEqual([]);
	expect(readFileSync(join(repo, '.editorconfig'), 'utf8')).toBe('root = true\n');
});

test('checkRepo: renovate-ignore только у репо с bot renovate', () => {
	const repo = mkdtempSync(join(tmpdir(), 'stack-repo-'));
	writeFileSync(join(repo, 'pnpm-workspace.yaml'), 'packages: []\n');
	const codes = (bot?: Canon['bot']) =>
		checkRepo(repo, { ...canon, files: [], catalogs: {}, bot }, []).map((f) => f.code);
	expect(codes('renovate')).toContain('renovate-ignore');
	expect(codes('dependabot')).not.toContain('renovate-ignore');
	expect(codes(undefined)).not.toContain('renovate-ignore');
});

test('renovate-ignore не подавляется исключением — и исключение выходит stale-exception', () => {
	const repo = mkdtempSync(join(tmpdir(), 'stack-repo-'));
	writeFileSync(join(repo, 'pnpm-workspace.yaml'), 'packages: []\n');
	const findings = checkRepo(repo, { ...canon, files: [], catalogs: {}, bot: 'renovate' }, [
		{ file: 'renovate.json', reason: 'r' },
	]);
	const ignore = findings.find((f) => f.code === 'renovate-ignore');
	expect(ignore).toBeDefined();
	expect(ignore?.suppressedBy).toBeUndefined();
	expect(findings.some((f) => f.code === 'stale-exception')).toBe(true);
});

test('dependabot-ignore не подавляется исключением — и исключение выходит stale-exception', () => {
	const repo = mkdtempSync(join(tmpdir(), 'stack-repo-'));
	writeFileSync(join(repo, 'pnpm-workspace.yaml'), 'packages: []\n');
	mkdirSync(join(repo, '.github'));
	writeFileSync(
		join(repo, '.github/dependabot.yml'),
		'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n',
	);
	const findings = checkRepo(repo, { ...canon, files: [], catalogs: {} }, [
		{ file: '.github/dependabot.yml', reason: 'r' },
	]);
	const ignore = findings.find((f) => f.code === 'dependabot-ignore');
	expect(ignore).toBeDefined();
	expect(ignore?.suppressedBy).toBeUndefined();
	expect(findings.some((f) => f.code === 'stale-exception')).toBe(true);
});
