import * as fs from 'node:fs';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { expect, spyOn, test } from 'bun:test';

import type { Canon } from './canon.ts';
import { check, checkRepo, syncRepo } from './check.ts';
import { STACK_RENOVATE_PRESET } from './deps.ts';
import { repoDir, testCanon, testRepo } from './testkit.ts';

// Конфиг Renovate на пресете канона: тесты исключений и каталогов не про бота.
const RENOVATE = { 'renovate.json5': `{ extends: ['${STACK_RENOVATE_PRESET}'] }\n` };

const realWrite = fs.writeFileSync;

const canon = testCanon({
	files: [{ dest: '.editorconfig', content: 'root = true\n' }],
	catalogs: { dev: { oxlint: '1.83.0' } },
});

test('стенд: согласованный с каноном репозиторий — без находок', () => {
	const canon = testCanon({
		files: [{ dest: '.editorconfig', content: 'root = true\n' }],
		catalogs: { dev: { oxlint: '1.83.0' }, libs: { react: '19.2.7' } },
	});
	expect(check(testRepo(canon), canon, [])).toEqual([]);
});

// Канон сам кладёт конфиг Renovate: стенд не добавляет второй, и содержимое — из канона.
test('стенд: конфиг Renovate из канона вытесняет свой, в репозитории ровно одна версия файла', () => {
	const seeded = testCanon({
		files: [
			{
				dest: 'renovate.json5',
				content: `{ extends: ['${STACK_RENOVATE_PRESET}', 'из канона'] }\n`,
				strategy: 'create-if-absent',
			},
		],
	});
	const repo = testRepo(seeded);
	expect(repo.renovate?.config).toEqual({ extends: [STACK_RENOVATE_PRESET, 'из канона'] });
	expect(check(repo, seeded, [])).toEqual([]);
});

test('стенд: null в правках удаляет файл — правило, которому он нужен, подаёт голос', () => {
	expect(check(testRepo(canon, { 'renovate.json5': null }), canon, []).map((f) => f.code)).toEqual([
		'renovate-preset',
	]);
	expect(check(testRepo(canon, { '.editorconfig': null }), canon, []).map((f) => f.code)).toEqual([
		'file-missing',
	]);
});

test('исключение на .prototools держит и packageManager — в sync и в check', () => {
	const repo = repoDir({
		...RENOVATE,
		'.prototools': 'pnpm = "11.1.2"\n',
		'package.json': '{ "name": "r", "packageManager": "pnpm@11.1.2" }',
	});
	const withPrototools: Canon = {
		...canon,
		files: [{ dest: '.prototools', content: 'pnpm = "10.99.0"\n' }],
	};
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
	const empty = testCanon();
	const codes = check(testRepo(empty), empty, [{ file: '.нет-такого', reason: 'протухло' }]).map(
		(f) => f.code,
	);
	expect(codes).toEqual(['stale-exception']);
});

test('исключение, подошедшее к находке, не мешает другому остаться протухшим', () => {
	const findings = check(testRepo(canon, { '.editorconfig': null }), canon, [
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

const OVERRIDES = `overrides:
  "pkg>dep": "git+https://github.com/example/some-long-fork-name.git#${'a'.repeat(40)}"
  # длинный plain-скаляр
  plain: some very long plain scalar value that goes well past the eighty column limit of yaml
`;
const WS_BEFORE = `packages:
  - packages/*

catalogs:
  # из канона
  dev:
    oxlint: 1.70.0

${OVERRIDES}`;

test('check агрегирует находки из разных источников: файл и каталог одновременно', () => {
	const codes = check(
		testRepo(canon, { '.editorconfig': 'сломали\n', 'pnpm-workspace.yaml': WS_BEFORE }),
		canon,
		[],
	).map((f) => f.code);
	expect(codes).toContain('file-drift');
	expect(codes).toContain('catalog-drift');
});

// Порядок находок — часть вывода CLI: план (файлы, каталоги, packageManager), нечитаемые файлы,
// inline-version, engines-node, renovate-preset, dependabot-config; протухшие исключения — в конце.
test('check: порядок находок — план, unreadable-file, правила deps.ts, stale-exception', () => {
	const findings = check(
		testRepo(canon, {
			'.editorconfig': null,
			'package.json': '{ "packageManager": "pnpm@1.0.0", "engines": { "node": "^24" } }',
			'packages/a/package.json': '{ "devDependencies": { "oxlint": "1.70.0" } }',
			'packages/b/package.json': '{',
			'renovate.json5': null,
			'.github/dependabot.yml': 'version: 2\n',
		}),
		canon,
		[{ file: '.нет-такого', reason: 'протухло' }],
	);
	expect(findings.map((f) => f.code)).toEqual([
		'file-missing',
		'package-manager',
		'unreadable-file',
		'inline-version',
		'engines-node',
		'renovate-preset',
		'dependabot-config',
		'stale-exception',
	]);
});

test('sync не трогает файл, удержанный исключением, и check после него без stale-exception', () => {
	const repo = repoDir({ ...RENOVATE, '.editorconfig': 'свой отступ\n' });
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
	const repo = repoDir({ ...RENOVATE, 'pnpm-workspace.yaml': WS_BEFORE });
	// Вторая запись dev-каталога: соседняя запись в том же файле не должна затереть удержанную
	// (применитель пишет pnpm-workspace.yaml целиком, один раз).
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
	expect(workspace).toContain('  # из канона\n  dev:');
	expect(workspace.slice(workspace.indexOf('overrides:'))).toBe(OVERRIDES);
	expect(checkRepo(repo, twoEntries, exceptions).filter((f) => !f.suppressedBy)).toEqual([]);
});

test('sync без исключений применяет весь план — как раньше', () => {
	const repo = repoDir({ '.editorconfig': 'сломали\n' });
	const { applied, held } = syncRepo(repo, canon, []);
	expect(applied.map((d) => d.code)).toEqual(['file-drift']);
	expect(held).toEqual([]);
	expect(readFileSync(join(repo, '.editorconfig'), 'utf8')).toBe('root = true\n');
});

test('check: renovate-preset проверяется у каждого репо — без групп и без pnpm-workspace', () => {
	const bare = testCanon();
	const codes = check(
		testRepo(bare, { 'renovate.json5': null, 'pnpm-workspace.yaml': null }),
		bare,
		[],
	).map((f) => f.code);
	expect(codes).toContain('renovate-preset');
});

test('renovate-preset и dependabot-config не подавляются исключением — исключения выходят stale-exception', () => {
	const bare = testCanon();
	const findings = check(
		testRepo(bare, {
			'renovate.json5': null,
			'.github/dependabot.yml':
				'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n',
		}),
		bare,
		[
			{ file: 'renovate.json5', reason: 'r' },
			{ file: '.github/dependabot.yml', reason: 'r' },
		],
	);
	for (const code of ['renovate-preset', 'dependabot-config'] as const) {
		const f = findings.find((x) => x.code === code);
		expect(f).toBeDefined();
		expect(f?.suppressedBy).toBeUndefined();
	}
	expect(findings.filter((f) => f.code === 'stale-exception')).toHaveLength(2);
});

test('сломанный корневой package.json — одна находка unreadable-file, с pnpm-workspace.yaml и без', () => {
	const bare = testCanon();
	for (const withWorkspace of [true, false]) {
		const unreadable = check(
			testRepo(bare, {
				'package.json': '{ "name": "r", ',
				'pnpm-workspace.yaml': withWorkspace ? 'packages:\n  - packages/*\n' : null,
			}),
			bare,
			[],
		).filter((f) => f.code === 'unreadable-file');
		expect(
			unreadable.map((f) => f.target),
			`workspace: ${withWorkspace}`,
		).toEqual(['package.json']);
	}
});

// DX-17: sync пишет каждый файл один раз, сколько бы находок в нём ни было.
test('syncRepo: два дрейфа каталога, packageManager и файл — по одной записи на путь', () => {
	const repo = repoDir({
		...RENOVATE,
		'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
		'package.json': '{ "packageManager": "pnpm@1.0.0" }\n',
	});
	const twoEntries: Canon = {
		...canon,
		catalogs: { dev: { oxlint: '1.83.0', typescript: '7.0.2' } },
	};
	const writes: string[] = [];
	const spy = spyOn(fs, 'writeFileSync').mockImplementation(((path: string, data: string) => {
		writes.push(relative(repo, path));
		return realWrite(path, data);
	}) as typeof fs.writeFileSync);
	try {
		expect(syncRepo(repo, twoEntries, []).applied).toHaveLength(4);
	} finally {
		spy.mockRestore();
	}
	expect(writes.toSorted()).toEqual(['.editorconfig', 'package.json', 'pnpm-workspace.yaml']);
});
