import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

import { checkCatalogs, syncCatalogs } from './catalogs.ts';
import type { StackConfig } from './config.ts';

function canonFixture(): string {
	const dir = mkdtempSync(join(tmpdir(), 'stack-cat-'));
	writeFileSync(
		join(dir, 'catalogs.json'),
		JSON.stringify({ dev: { oxlint: '1.83.0', typescript: '7.0.2' }, libs: { react: '19.2.7' } }),
	);
	return dir;
}

function repoFixture(ws: string): string {
	const dir = mkdtempSync(join(tmpdir(), 'stack-repo-'));
	writeFileSync(join(dir, 'pnpm-workspace.yaml'), ws);
	return dir;
}

const cfg = (over: Partial<StackConfig> = {}): StackConfig => ({
	profile: 'node',
	with: [],
	exceptions: [],
	...over,
});

test('выставляет версии dev и сохраняет комментарии и чужие каталоги', () => {
	const repo = repoFixture(`packages:
  - packages/*

catalogs:
  # версии инструментов приходят из канона
  dev:
    oxlint: 1.74.0
  product:
    lodash: 4.17.21
`);
	syncCatalogs(repo, cfg(), canonFixture());
	const out = readFileSync(join(repo, 'pnpm-workspace.yaml'), 'utf8');
	expect(out).toContain('# версии инструментов приходят из канона');
	expect(out).toContain('oxlint: 1.83.0');
	expect(out).toContain('typescript: 7.0.2');
	expect(out).toContain('lodash: 4.17.21');
});

test('пин значений CatalogChange: dev.oxlint — апдейт, dev.typescript — новая запись', () => {
	const repo = repoFixture(`packages:
  - packages/*

catalogs:
  # версии инструментов приходят из канона
  dev:
    oxlint: 1.74.0
  product:
    lodash: 4.17.21
`);
	const changes = syncCatalogs(repo, cfg(), canonFixture());
	expect(changes).toContainEqual({ group: 'dev', name: 'oxlint', from: '1.74.0', to: '1.83.0' });
	expect(changes).toContainEqual({
		group: 'dev',
		name: 'typescript',
		from: undefined,
		to: '7.0.2',
	});
});

// Task 13: a scoped name (`@foo/bar`) isn't a plain-scalar-safe YAML key, so the `yaml` package
// quotes it either way — but its default is double quotes, and oxfmt (canon .oxfmtrc.jsonc,
// singleQuote:true) then reformats it right back, painting a workspace file `sync` just wrote.
// Mutation: dropping `{ singleQuote: true }` from doc.toString() in syncCatalogs turns this red.
test('новая scoped-запись каталога пишется в одинарных кавычках (singleQuote: true)', () => {
	const canon = mkdtempSync(join(tmpdir(), 'stack-cat-'));
	writeFileSync(join(canon, 'catalogs.json'), JSON.stringify({ dev: { '@scope/pkg': '2.0.0' } }));
	const repo = repoFixture('packages:\n  - packages/*\n');
	syncCatalogs(repo, cfg(), canon);
	const out = readFileSync(join(repo, 'pnpm-workspace.yaml'), 'utf8');
	expect(out).toContain("'@scope/pkg': 2.0.0");
	expect(out).not.toContain('"@scope/pkg"');
});

test('создаёт узел catalogs, если его не было', () => {
	const repo = repoFixture('packages:\n  - packages/*\n');
	syncCatalogs(repo, cfg(), canonFixture());
	expect(readFileSync(join(repo, 'pnpm-workspace.yaml'), 'utf8')).toContain('dev:');
});

test('группа libs приезжает только при with', () => {
	const canon = canonFixture();
	const a = repoFixture('packages:\n  - packages/*\n');
	syncCatalogs(a, cfg(), canon);
	expect(readFileSync(join(a, 'pnpm-workspace.yaml'), 'utf8')).not.toContain('react');
	const b = repoFixture('packages:\n  - packages/*\n');
	syncCatalogs(b, cfg({ with: ['libs'] }), canon);
	expect(readFileSync(join(b, 'pnpm-workspace.yaml'), 'utf8')).toContain('react: 19.2.7');
});

test('sync идемпотентен', () => {
	const canon = canonFixture();
	const repo = repoFixture('packages:\n  - packages/*\n');
	syncCatalogs(repo, cfg(), canon);
	expect(syncCatalogs(repo, cfg(), canon)).toEqual([]);
});

test('check краснеет на устаревшей версии и на отсутствующей записи', () => {
	const canon = canonFixture();
	const repo = repoFixture('packages:\n  - packages/*\n\ncatalogs:\n  dev:\n    oxlint: 1.74.0\n');
	const codes = checkCatalogs(repo, cfg(), canon).map((f) => f.code);
	expect(codes).toContain('catalog-drift');
	expect(codes).toContain('catalog-missing');
	syncCatalogs(repo, cfg(), canon);
	expect(checkCatalogs(repo, cfg(), canon)).toEqual([]);
});

test('находка о записи каталога несёт адрес для исключения: catalog+name своей записи', () => {
	const canon = canonFixture();
	const repo = repoFixture(
		'packages:\n  - packages/*\n\ncatalogs:\n  dev:\n    oxlint: 1.74.0\n    typescript: 7.0.1\n',
	);
	const found = checkCatalogs(repo, cfg(), canon);
	expect(found.map((f) => [f.code, f.address])).toEqual([
		['catalog-drift', { catalog: 'dev', name: 'oxlint' }],
		['catalog-drift', { catalog: 'dev', name: 'typescript' }],
	]);
});

test('запись каталога, сломанная в YAML-мэппинг, не превращается в "[object Object]"', () => {
	const canon = canonFixture();
	const repo = repoFixture(
		'packages:\n  - packages/*\n\ncatalogs:\n  dev:\n    typescript:\n      pinned: true\n',
	);
	const found = checkCatalogs(repo, cfg(), canon);
	const typescript = found.find((f) => f.target === 'catalogs.dev.typescript');
	expect(typescript?.code).toBe('catalog-drift');
	expect(typescript?.message).toContain('"pinned":true');
	expect(typescript?.message).not.toContain('[object Object]');
});

test('число без кавычек в YAML (typescript: 7) не считается расхождением с канон-строкой "7"', () => {
	const canon = mkdtempSync(join(tmpdir(), 'stack-cat-'));
	writeFileSync(join(canon, 'catalogs.json'), JSON.stringify({ dev: { typescript: '7' } }));
	const repo = repoFixture('packages:\n  - packages/*\n\ncatalogs:\n  dev:\n    typescript: 7\n');
	expect(checkCatalogs(repo, cfg(), canon)).toEqual([]);
});

test('репозиторий без pnpm-workspace.yaml не проверяется', () => {
	const repo = mkdtempSync(join(tmpdir(), 'stack-repo-'));
	expect(checkCatalogs(repo, cfg({ profile: 'infra' }), canonFixture())).toEqual([]);
	expect(syncCatalogs(repo, cfg({ profile: 'infra' }), canonFixture())).toEqual([]);
});
