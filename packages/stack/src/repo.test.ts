import { expect, test } from 'bun:test';

import { checkEnginesNode, checkInlineVersions, checkRenovatePreset } from './deps.ts';
import { loadRepo, repoFromFiles } from './repo.ts';
import { repoDir, testCanon } from './testkit.ts';

const byTarget = (r: { unreadable: { target: string }[] }) => r.unreadable.map((f) => f.target);

test('битый корневой package.json — одна unreadable-file, с pnpm-workspace.yaml и без', () => {
	for (const files of [
		new Map([['package.json', '{']]),
		new Map([
			['package.json', '{'],
			['pnpm-workspace.yaml', 'packages: []'],
		]),
	]) {
		const repo = repoFromFiles(files);
		expect(byTarget(repo)).toEqual(['package.json']);
		expect(repo.unreadable[0]?.code).toBe('unreadable-file');
		expect(repo.packages.size).toBe(0);
	}
});

test('битый вложенный package.json — одна находка на файл, соседний разобран', () => {
	const repo = repoFromFiles(
		new Map([
			['package.json', '{"name":"root"}'],
			['packages/a/package.json', '{"name":"a"}'],
			['packages/b/package.json', '{'],
		]),
	);
	expect(byTarget(repo)).toEqual(['packages/b/package.json']);
	expect([...repo.packages.keys()].sort()).toEqual(['package.json', 'packages/a/package.json']);
	expect(repo.packages.get('packages/a/package.json')).toEqual({ name: 'a' });
});

test('порядок unreadable: корневой, вложенные, Renovate', () => {
	const repo = repoFromFiles(
		new Map([
			['renovate.json5', '{'],
			['packages/a/package.json', '{'],
			['package.json', '{'],
		]),
	);
	expect(byTarget(repo)).toEqual(['package.json', 'packages/a/package.json', 'renovate.json5']);
});

test('битый renovate.json5 — одна unreadable-file, renovate есть, config нет', () => {
	const repo = repoFromFiles(new Map([['renovate.json5', '{']]));
	expect(repo.unreadable).toEqual([
		{
			code: 'unreadable-file',
			target: 'renovate.json5',
			message: 'renovate.json5 does not parse as JSON5',
		},
	]);
	expect(repo.renovate).toEqual({ path: 'renovate.json5' });
	expect('config' in (repo.renovate ?? {})).toBe(false);
});

test('Renovate: берётся первый существующий в порядке RENOVATE_CONFIGS, комментарии JSON5 читаются', () => {
	const repo = repoFromFiles(
		new Map([
			['.github/renovate.json5', '{extends: ["b"]}'],
			['renovate.json', '// c\n{"extends": ["a"]}'],
		]),
	);
	expect(repo.renovate).toEqual({ path: 'renovate.json', config: { extends: ['a'] } });
	expect(repo.unreadable).toEqual([]);
});

test('находки загрузчика совпадают с находками правил побайтно', () => {
	const dir = repoDir({
		'pnpm-workspace.yaml': 'packages: []',
		'package.json': '{',
		'packages/a/package.json': '{"x":',
		'renovate.json5': '{',
	});
	const canon = testCanon();
	const repo = loadRepo(dir, canon);
	const sort = <T extends { target: string }>(l: T[]) =>
		[...l].sort((a, b) => a.target.localeCompare(b.target));
	const fromRules = [
		...checkInlineVersions(dir, canon),
		...checkRenovatePreset(dir).filter((f) => f.code === 'unreadable-file'),
	];
	expect(sort(repo.unreadable)).toEqual(sort(fromRules));
	// без pnpm-workspace.yaml корневой файл даёт находку у checkEnginesNode
	const bare = repoDir({ 'package.json': '{' });
	expect(loadRepo(bare, canon).unreadable).toEqual(checkEnginesNode(bare, canon));
});

test('infra: ни package.json, ни pnpm-workspace.yaml — пустые packages, без находок, без Renovate', () => {
	const repo = loadRepo(repoDir({ '.prototools': 'node = "1"\n' }), testCanon());
	expect(repo.packages.size).toBe(0);
	expect(repo.unreadable).toEqual([]);
	expect(repo.renovate).toBeUndefined();
});

test('битые package.json в node_modules, .worktrees, .moon/cache, dist/, build/ не читаются', () => {
	const repo = loadRepo(
		repoDir({
			'pnpm-workspace.yaml': 'packages: []',
			'package.json': '{}',
			'packages/a/package.json': '{}',
			'node_modules/x/package.json': '{',
			'.worktrees/w/package.json': '{',
			'.moon/cache/c/package.json': '{',
			'packages/a/dist/package.json': '{',
			'build/package.json': '{',
		}),
		testCanon(),
	);
	expect([...repo.packages.keys()].sort()).toEqual(['package.json', 'packages/a/package.json']);
	expect(repo.unreadable).toEqual([]);
});

test('без pnpm-workspace.yaml вложенные package.json не читаются', () => {
	const repo = loadRepo(
		repoDir({
			'package.json': '{}',
			'packages/a/package.json': '{',
			'packages/b/package.json': '{}',
		}),
		testCanon(),
	);
	expect([...repo.packages.keys()]).toEqual(['package.json']);
	expect(repo.unreadable).toEqual([]);
});

test('читает dest и satisfiedBy канон-файлов', () => {
	const dir = repoDir({
		'.github/renovate.json5': '{}',
		'seed.txt': 'a',
		'alt/seed.txt': 'b',
		'other.txt': 'x',
	});
	const repo = loadRepo(
		dir,
		testCanon({
			files: [
				{
					dest: 'renovate.json5',
					content: '{}',
					strategy: 'create-if-absent',
					satisfiedBy: ['.github/renovate.json5'],
				},
				{
					dest: 'seed.txt',
					content: 'a',
					strategy: 'create-if-absent',
					satisfiedBy: ['alt/seed.txt'],
				},
			],
		}),
	);
	expect(repo.files.get('.github/renovate.json5')).toBe('{}');
	expect(repo.files.get('seed.txt')).toBe('a');
	expect(repo.files.get('alt/seed.txt')).toBe('b');
	expect(repo.files.has('renovate.json5')).toBe(false);
	expect(repo.files.has('other.txt')).toBe(false);
	expect(repo.renovate?.path).toBe('.github/renovate.json5');
});

test('package.json не объект (null, массив) — разобран как пустой, не находка', () => {
	const repo = repoFromFiles(
		new Map([
			['package.json', 'null'],
			['a/package.json', '[1]'],
		]),
	);
	expect(repo.unreadable).toEqual([]);
	expect(repo.packages.get('package.json')).toEqual({});
	expect(repo.packages.get('a/package.json')).toEqual({});
});

test('читаются только файлы: каталог по пути из канона в files не попадает', () => {
	const dir = repoDir({ 'renovate.json5/inner.txt': 'x' });
	const repo = loadRepo(dir, testCanon({ files: [{ dest: 'renovate.json5', content: '{}' }] }));
	expect(repo.files.has('renovate.json5')).toBe(false);
	expect(repo.renovate).toBeUndefined();
});
