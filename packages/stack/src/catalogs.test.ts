import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

import type { Canon } from './canon.ts';
import { plan, planRepo, syncRepo } from './check.ts';
import { repoDir, testCanon, testRepo } from './testkit.ts';

const canon = testCanon({ catalogs: { dev: { oxlint: '1.83.0', typescript: '7.0.2' } } });
const withCatalogs = (catalogs: Canon['catalogs']): Canon => ({ ...canon, catalogs });

// Дрейф каталогов репозитория, у которого pnpm-workspace.yaml — ws (null — файла нет).
const catalogDrift = (ws: string | null, c: Canon = canon) =>
	plan(testRepo(c, { 'pnpm-workspace.yaml': ws }), c).filter(
		(f) => f.code === 'catalog-drift' || f.code === 'catalog-missing',
	);

// Применить план — то, что делает `stack sync`; возвращает applied из syncRepo, чтобы пинить строки fix.
function sync(repo: string, c: Canon = canon) {
	return syncRepo(repo, c, []).applied;
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
	const repo = repoDir({ 'pnpm-workspace.yaml': WS_WITH_COMMENT });
	sync(repo);
	const out = readFileSync(join(repo, 'pnpm-workspace.yaml'), 'utf8');
	expect(out).toContain('# версии инструментов приходят из канона');
	expect(out).toContain('oxlint: 1.83.0');
	expect(out).toContain('typescript: 7.0.2');
	expect(out).toContain('lodash: 4.17.21');
});

test('пин строк fix: dev.oxlint — апдейт, dev.typescript — новая запись', () => {
	const applied = sync(repoDir({ 'pnpm-workspace.yaml': WS_WITH_COMMENT }));
	expect(applied.map((d) => [d.code, d.fix])).toEqual([
		['catalog-drift', 'catalog dev.oxlint: 1.74.0 → 1.83.0'],
		['catalog-missing', 'catalog dev.typescript: — → 7.0.2'],
	]);
});

// Вне каталогов sync не переносит длинные строки. У yaml lineWidth по умолчанию 80: без lineWidth: 0
// длинный override на git-URL уходил в `\`-перенос, а длинный plain-скаляр — на вторую строку.
const LONG_URL = `"git+https://github.com/example/some-long-fork-name.git#${'a'.repeat(40)}"`;
const WS_WITH_LONG_LINES = `${WS_WITH_COMMENT}
overrides:
  "pkg>dep": ${LONG_URL}
  # длинный plain-скаляр
  plain: some very long plain scalar value that goes well past the eighty column limit of yaml
`;
const fromOverrides = (s: string) => s.slice(s.indexOf('\noverrides:'));

test('sync не переносит длинные строки вне каталогов', () => {
	const repo = repoDir({ 'pnpm-workspace.yaml': WS_WITH_LONG_LINES });
	sync(repo);
	const out = readFileSync(join(repo, 'pnpm-workspace.yaml'), 'utf8');
	expect(out).toContain('typescript: 7.0.2');
	expect(fromOverrides(out)).toBe(fromOverrides(WS_WITH_LONG_LINES));
});

test('повторный sync — пустой план, файл байт-в-байт тот же', () => {
	const repo = repoDir({ 'pnpm-workspace.yaml': WS_WITH_LONG_LINES });
	sync(repo);
	const once = readFileSync(join(repo, 'pnpm-workspace.yaml'), 'utf8');
	expect(sync(repo)).toEqual([]);
	expect(readFileSync(join(repo, 'pnpm-workspace.yaml'), 'utf8')).toBe(once);
});

// Task 13: a scoped name (`@foo/bar`) isn't a plain-scalar-safe YAML key, so the `yaml` package
// quotes it either way — but its default is double quotes, and oxfmt (canon .oxfmtrc.jsonc,
// singleQuote:true) then reformats it right back, painting a workspace file `sync` just wrote.
// Mutation: dropping `{ singleQuote: true }` from doc.toString() in renderChanges (apply.ts) turns
// this red.
test('новая scoped-запись каталога пишется в одинарных кавычках (singleQuote: true)', () => {
	const repo = repoDir({ 'pnpm-workspace.yaml': 'packages:\n  - packages/*\n' });
	sync(repo, withCatalogs({ dev: { '@scope/pkg': '2.0.0' } }));
	const out = readFileSync(join(repo, 'pnpm-workspace.yaml'), 'utf8');
	expect(out).toContain("'@scope/pkg': 2.0.0");
	expect(out).not.toContain('"@scope/pkg"');
});

test('создаёт узел catalogs, если его не было', () => {
	const repo = repoDir({ 'pnpm-workspace.yaml': 'packages:\n  - packages/*\n' });
	sync(repo);
	expect(readFileSync(join(repo, 'pnpm-workspace.yaml'), 'utf8')).toContain('dev:');
});

test('план покрывает все группы канона, не только dev', () => {
	const repo = repoDir({ 'pnpm-workspace.yaml': 'packages:\n  - packages/*\n' });
	const applied = sync(
		repo,
		withCatalogs({ dev: { oxlint: '1.83.0' }, libs: { react: '19.2.7' } }),
	);
	expect(applied.map((d) => d.fix)).toEqual([
		'catalog dev.oxlint: — → 1.83.0',
		'catalog libs.react: — → 19.2.7',
	]);
	expect(readFileSync(join(repo, 'pnpm-workspace.yaml'), 'utf8')).toContain('react: 19.2.7');
});

test('sync идемпотентен: после применения план пуст', () => {
	const repo = repoDir({ 'pnpm-workspace.yaml': 'packages:\n  - packages/*\n' });
	sync(repo);
	expect(planRepo(repo, canon)).toEqual([]);
});

test('план краснеет на устаревшей версии и на отсутствующей записи', () => {
	const ws = 'packages:\n  - packages/*\n\ncatalogs:\n  dev:\n    oxlint: 1.74.0\n';
	expect(catalogDrift(ws).map((f) => f.code)).toEqual(['catalog-drift', 'catalog-missing']);
	const repo = repoDir({ 'pnpm-workspace.yaml': ws });
	sync(repo);
	expect(planRepo(repo, canon)).toEqual([]);
});

test('находка о записи каталога несёт предмет для исключения: catalog+name своей записи', () => {
	const ws =
		'packages:\n  - packages/*\n\ncatalogs:\n  dev:\n    oxlint: 1.74.0\n    typescript: 7.0.1\n';
	expect(catalogDrift(ws)).toMatchObject([
		{ code: 'catalog-drift', catalog: 'dev', name: 'oxlint' },
		{ code: 'catalog-drift', catalog: 'dev', name: 'typescript' },
	]);
});

test('запись каталога, сломанная в YAML-мэппинг, не превращается в "[object Object]"', () => {
	const typescript = catalogDrift(
		'packages:\n  - packages/*\n\ncatalogs:\n  dev:\n    typescript:\n      pinned: true\n',
	).find((f) => f.target === 'catalogs.dev.typescript');
	expect(typescript?.code).toBe('catalog-drift');
	expect(typescript?.message).toContain('"pinned":true');
	expect(typescript?.message).not.toContain('[object Object]');
});

test('число без кавычек в YAML (typescript: 7) не считается расхождением с канон-строкой "7"', () => {
	expect(
		catalogDrift(
			'packages:\n  - packages/*\n\ncatalogs:\n  dev:\n    typescript: 7\n',
			withCatalogs({ dev: { typescript: '7' } }),
		),
	).toEqual([]);
});

test('репозиторий без pnpm-workspace.yaml не проверяется', () => {
	expect(catalogDrift(null)).toEqual([]);
});
