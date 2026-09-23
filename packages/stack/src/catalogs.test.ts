import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

import type { Canon } from './canon.ts';
import { planCatalogs } from './catalogs.ts';

const canon: Canon = {
	files: [],
	catalogs: { dev: { oxlint: '1.83.0', typescript: '7.0.2' } },
	nodePin: '26.8.1',
};
const withCatalogs = (catalogs: Canon['catalogs']): Canon => ({ ...canon, catalogs });

function repoFixture(ws: string): string {
	const dir = mkdtempSync(join(tmpdir(), 'stack-repo-'));
	writeFileSync(join(dir, 'pnpm-workspace.yaml'), ws);
	return dir;
}

// Применить план — то, что делает `stack sync`; возвращает план, чтобы пинить его строки fix.
function sync(repo: string, c: Canon = canon) {
	const plan = planCatalogs(repo, c);
	for (const d of plan) d.apply();
	return plan;
}

const WS_WITH_COMMENT = `packages:
  - packages/*

catalogs:
  # версии инструментов приходят из канона
  dev:
    oxlint: 1.74.0
  product:
    lodash: 4.17.21
`;

test('выставляет версии dev и сохраняет комментарии и чужие каталоги', () => {
	const repo = repoFixture(WS_WITH_COMMENT);
	sync(repo);
	const out = readFileSync(join(repo, 'pnpm-workspace.yaml'), 'utf8');
	expect(out).toContain('# версии инструментов приходят из канона');
	expect(out).toContain('oxlint: 1.83.0');
	expect(out).toContain('typescript: 7.0.2');
	expect(out).toContain('lodash: 4.17.21');
});

test('пин строк fix: dev.oxlint — апдейт, dev.typescript — новая запись', () => {
	const plan = sync(repoFixture(WS_WITH_COMMENT));
	expect(plan.map((d) => [d.code, d.fix])).toEqual([
		['catalog-drift', 'catalog dev.oxlint: 1.74.0 → 1.83.0'],
		['catalog-missing', 'catalog dev.typescript: — → 7.0.2'],
	]);
});

// Task 13: a scoped name (`@foo/bar`) isn't a plain-scalar-safe YAML key, so the `yaml` package
// quotes it either way — but its default is double quotes, and oxfmt (canon .oxfmtrc.jsonc,
// singleQuote:true) then reformats it right back, painting a workspace file `sync` just wrote.
// Mutation: dropping `{ singleQuote: true }` from doc.toString() in planCatalogs' apply() turns
// this red.
test('новая scoped-запись каталога пишется в одинарных кавычках (singleQuote: true)', () => {
	const repo = repoFixture('packages:\n  - packages/*\n');
	sync(repo, withCatalogs({ dev: { '@scope/pkg': '2.0.0' } }));
	const out = readFileSync(join(repo, 'pnpm-workspace.yaml'), 'utf8');
	expect(out).toContain("'@scope/pkg': 2.0.0");
	expect(out).not.toContain('"@scope/pkg"');
});

test('создаёт узел catalogs, если его не было', () => {
	const repo = repoFixture('packages:\n  - packages/*\n');
	sync(repo);
	expect(readFileSync(join(repo, 'pnpm-workspace.yaml'), 'utf8')).toContain('dev:');
});

test('план покрывает все группы канона, не только dev', () => {
	const repo = repoFixture('packages:\n  - packages/*\n');
	const plan = sync(repo, withCatalogs({ dev: { oxlint: '1.83.0' }, libs: { react: '19.2.7' } }));
	expect(plan.map((d) => d.fix)).toEqual([
		'catalog dev.oxlint: — → 1.83.0',
		'catalog libs.react: — → 19.2.7',
	]);
	expect(readFileSync(join(repo, 'pnpm-workspace.yaml'), 'utf8')).toContain('react: 19.2.7');
});

test('sync идемпотентен: после применения план пуст', () => {
	const repo = repoFixture('packages:\n  - packages/*\n');
	sync(repo);
	expect(planCatalogs(repo, canon)).toEqual([]);
});

test('план краснеет на устаревшей версии и на отсутствующей записи', () => {
	const repo = repoFixture('packages:\n  - packages/*\n\ncatalogs:\n  dev:\n    oxlint: 1.74.0\n');
	const codes = planCatalogs(repo, canon).map((f) => f.code);
	expect(codes).toContain('catalog-drift');
	expect(codes).toContain('catalog-missing');
	sync(repo);
	expect(planCatalogs(repo, canon)).toEqual([]);
});

test('находка о записи каталога несёт адрес для исключения: catalog+name своей записи', () => {
	const repo = repoFixture(
		'packages:\n  - packages/*\n\ncatalogs:\n  dev:\n    oxlint: 1.74.0\n    typescript: 7.0.1\n',
	);
	expect(planCatalogs(repo, canon).map((f) => [f.code, f.address])).toEqual([
		['catalog-drift', { catalog: 'dev', name: 'oxlint' }],
		['catalog-drift', { catalog: 'dev', name: 'typescript' }],
	]);
});

test('запись каталога, сломанная в YAML-мэппинг, не превращается в "[object Object]"', () => {
	const repo = repoFixture(
		'packages:\n  - packages/*\n\ncatalogs:\n  dev:\n    typescript:\n      pinned: true\n',
	);
	const typescript = planCatalogs(repo, canon).find((f) => f.target === 'catalogs.dev.typescript');
	expect(typescript?.code).toBe('catalog-drift');
	expect(typescript?.message).toContain('"pinned":true');
	expect(typescript?.message).not.toContain('[object Object]');
});

test('число без кавычек в YAML (typescript: 7) не считается расхождением с канон-строкой "7"', () => {
	const repo = repoFixture('packages:\n  - packages/*\n\ncatalogs:\n  dev:\n    typescript: 7\n');
	expect(planCatalogs(repo, withCatalogs({ dev: { typescript: '7' } }))).toEqual([]);
});

test('репозиторий без pnpm-workspace.yaml не проверяется', () => {
	const repo = mkdtempSync(join(tmpdir(), 'stack-repo-'));
	expect(planCatalogs(repo, canon)).toEqual([]);
});
