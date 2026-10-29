import { readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

import { check, plan, syncRepo } from './check.ts';
import {
	DEPENDABOT_CONFIGS,
	loadRepo,
	type Read,
	readSnapshot,
	RENOVATE_CONFIGS,
	repoFromSnapshot,
	type Snapshot,
	WORKSPACE_FILE,
} from './repo.ts';
import { ioError, repoDir, testCanon, testRepo } from './testkit.ts';

// Снимок, в котором все файлы прочитаны.
const texts = (files: Map<string, string>) =>
	new Map<string, Read>([...files].map(([path, text]) => [path, { text }]));
const fromTexts = (files: Map<string, string>) => repoFromSnapshot(texts(files));

const byTarget = (r: { unreadable: { target: string }[] }) => r.unreadable.map((f) => f.target);

test('битый корневой package.json — одна unreadable-file, с pnpm-workspace.yaml и без', () => {
	for (const files of [
		new Map([['package.json', '{']]),
		new Map([
			['package.json', '{'],
			['pnpm-workspace.yaml', 'packages: []'],
		]),
	]) {
		const repo = fromTexts(files);
		expect(byTarget(repo)).toEqual(['package.json']);
		expect(repo.unreadable[0]?.code).toBe('unreadable-file');
		expect(repo.packages.size).toBe(0);
	}
});

test('битый вложенный package.json — одна находка на файл, соседний разобран', () => {
	const repo = fromTexts(
		new Map([
			['pnpm-workspace.yaml', 'packages: []'],
			['package.json', '{"name":"root"}'],
			['packages/a/package.json', '{"name":"a"}'],
			['packages/b/package.json', '{'],
		]),
	);
	expect(byTarget(repo)).toEqual(['packages/b/package.json']);
	expect([...repo.packages.keys()].sort()).toEqual(['package.json', 'packages/a/package.json']);
	expect(repo.packages.get('packages/a/package.json')).toEqual({ name: 'a' });
});

test('порядок unreadable: корневой, pnpm-workspace.yaml, вложенные, Renovate', () => {
	const repo = fromTexts(
		new Map([
			['renovate.json5', '{'],
			['packages/a/package.json', '{'],
			['pnpm-workspace.yaml', 'a: [\n'],
			['package.json', '{'],
		]),
	);
	expect(byTarget(repo)).toEqual([
		'package.json',
		'pnpm-workspace.yaml',
		'packages/a/package.json',
		'renovate.json5',
	]);
});

test('битый renovate.json5 — одна unreadable-file, renovate есть, config нет', () => {
	const repo = fromTexts(new Map([['renovate.json5', '{']]));
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
	const repo = fromTexts(
		new Map([
			['.github/renovate.json5', '{extends: ["b"]}'],
			['renovate.json', '// c\n{"extends": ["a"]}'],
		]),
	);
	expect(repo.renovate).toEqual({ path: 'renovate.json', config: { extends: ['a'] } });
	expect(repo.unreadable).toEqual([]);
});

const failed = (code: string, what: string): Read => ({
	failed: ioError(code, `${what}, open 'x'`),
});
const triple = (r: { unreadable: { code: string; target: string; message: string }[] }) =>
	r.unreadable.map((f) => [f.code, f.target, f.message]);

test('значения: нечитаемый корневой package.json — одна unreadable-file, в packages его нет, путь есть', () => {
	const repo = testRepo(testCanon(), {
		'package.json': { failed: ioError('EACCES', "permission denied, open 'package.json'") },
	});
	expect(triple(repo)).toEqual([
		[
			'unreadable-file',
			'package.json',
			"package.json does not parse: EACCES: permission denied, open 'package.json'",
		],
	]);
	expect(repo.packages.has('package.json')).toBe(false);
	expect(repo.paths.has('package.json')).toBe(true);
});

test('значения: сбой чтения и сбой разбора сортируются по rank одним списком', () => {
	const repo = testRepo(testCanon(), {
		'packages/a/package.json': '{',
		'pnpm-workspace.yaml': failed('EACCES', 'permission denied'),
		'renovate.json': failed('EISDIR', 'illegal operation on a directory'),
		'package.json': failed('EACCES', 'permission denied'),
	});
	expect(byTarget(repo)).toEqual([
		'package.json',
		'pnpm-workspace.yaml',
		'packages/a/package.json',
		'renovate.json',
	]);
});

test('значения: первый конфиг Renovate не читается — заслоняет следующий, тот не разбирается', () => {
	const repo = testRepo(testCanon(), {
		'renovate.json5': null,
		'renovate.json': failed('EISDIR', 'illegal operation on a directory'),
		'.github/renovate.json5': '{',
	});
	expect(triple(repo)).toEqual([
		['unreadable-file', 'renovate.json', 'renovate.json does not parse as JSON5'],
	]);
	expect(repo.renovate).toEqual({ path: 'renovate.json' });
	expect(repo.files.get('.github/renovate.json5')).toBe('{');
});

test('значения: нечитаемый pnpm-workspace.yaml — находка, workspace нет, вложенные package.json загружены', () => {
	const repo = testRepo(testCanon(), {
		'pnpm-workspace.yaml': { failed: ioError('EACCES', 'permission denied') },
		'packages/a/package.json': '{"name":"a"}',
	});
	expect(triple(repo)).toEqual([
		[
			'unreadable-file',
			'pnpm-workspace.yaml',
			'pnpm-workspace.yaml does not parse: EACCES: permission denied',
		],
	]);
	expect(repo.workspace).toBeUndefined();
	expect(repo.packages.get('packages/a/package.json')).toEqual({ name: 'a' });
});

test('значения: нечитаемый путь, который никто не разбирает, — только в paths', () => {
	const repo = testRepo(testCanon(), {
		'.editorconfig': failed('EISDIR', 'illegal operation on a directory'),
	});
	expect(repo.paths.has('.editorconfig')).toBe(true);
	expect(repo.files.has('.editorconfig')).toBe(false);
	expect(repo.unreadable).toEqual([]);
});

test('значения: missing в снимке — пути нет', () => {
	const repo = testRepo(testCanon(), { '.editorconfig': { missing: true } });
	expect(repo.paths.has('.editorconfig')).toBe(false);
});

test('значения: вложенный package.json без pnpm-workspace.yaml в снимке не разбирается', () => {
	const repo = testRepo(testCanon(), {
		'pnpm-workspace.yaml': null,
		'packages/a/package.json': '{',
		'packages/b/package.json': failed('EACCES', 'permission denied'),
	});
	expect(repo.unreadable).toEqual([]);
	expect([...repo.packages.keys()]).toEqual(['package.json']);
});

// Единственный источник unreadable-file — repo.unreadable: правила о нечитаемом файле молчат, поэтому
// check отдаёт каждую находку загрузчика ровно один раз, с workspace и без него.
test('check выдаёт находки загрузчика ровно по разу, с pnpm-workspace.yaml и без', () => {
	const canon = testCanon();
	const targets = (dir: string) => {
		const repo = loadRepo(dir, canon);
		const reported = check(repo, canon, [])
			.filter((f) => f.code === 'unreadable-file')
			.map((f) => f.target);
		expect(reported).toEqual(byTarget(repo));
		return reported;
	};
	expect(
		targets(
			repoDir({
				'pnpm-workspace.yaml': 'packages: []',
				'package.json': '{',
				'packages/a/package.json': '{"x":',
				'renovate.json5': '{',
			}),
		),
	).toEqual(['package.json', 'packages/a/package.json', 'renovate.json5']);
	expect(targets(repoDir({ 'package.json': '{' }))).toEqual(['package.json']);
});

test('infra: пустой снимок — пустые packages, без находок, без Renovate', () => {
	const repo = fromTexts(new Map());
	expect(repo.packages.size).toBe(0);
	expect(repo.unreadable).toEqual([]);
	expect(repo.renovate).toBeUndefined();
});

test('корневой package.json идёт первым в packages, даже если в снимке он после вложенного', () => {
	const repo = fromTexts(
		new Map([
			['packages/a/package.json', '{"name":"a"}'],
			['package.json', '{"name":"root"}'],
			['pnpm-workspace.yaml', 'packages: []'],
		]),
	);
	expect([...repo.packages.keys()]).toEqual(['package.json', 'packages/a/package.json']);
});

test('package.json не объект (null, массив) — разобран как пустой, не находка', () => {
	const repo = fromTexts(
		new Map([
			['pnpm-workspace.yaml', 'packages: []'],
			['package.json', 'null'],
			['a/package.json', '[1]'],
		]),
	);
	expect(repo.unreadable).toEqual([]);
	expect(repo.packages.get('package.json')).toEqual({});
	expect(repo.packages.get('a/package.json')).toEqual({});
});

test('Renovate: нет файла (missing) у первого — берётся следующий, находки нет', () => {
	const repo = testRepo(testCanon(), {
		'renovate.json5': null,
		'renovate.json': { missing: true },
		'.renovaterc.json': '{ "extends": ["a"] }',
	});
	expect(repo.renovate).toEqual({ path: '.renovaterc.json', config: { extends: ['a'] } });
	expect(repo.unreadable).toEqual([]);
});

test('нечитаемый (EACCES) package.json — одна unreadable-file, как у правил', () => {
	const repo = testRepo(testCanon(), {
		'package.json': { failed: ioError('EACCES', "permission denied, open 'package.json'") },
	});
	expect(repo.unreadable).toHaveLength(1);
	expect(repo.unreadable[0]?.message).toStartWith('package.json does not parse: EACCES');
	expect(repo.packages.size).toBe(0);
});

test('нечитаемые вложенный package.json и корневой — по одной находке, порядок корень, вложенный', () => {
	const repo = testRepo(testCanon(), {
		'packages/a/package.json': failed('EACCES', 'permission denied'),
		'package.json': failed('EACCES', 'permission denied'),
	});
	expect(byTarget(repo)).toEqual(['package.json', 'packages/a/package.json']);
});

test('нечитаемый (EACCES) pnpm-workspace.yaml — одна находка', () => {
	const repo = testRepo(testCanon(), {
		'pnpm-workspace.yaml': failed('EACCES', 'permission denied'),
	});
	expect(byTarget(repo)).toEqual(['pnpm-workspace.yaml']);
	expect(repo.unreadable[0]?.message).toStartWith('pnpm-workspace.yaml does not parse: EACCES');
});

// Нечитаемый вложенный package.json (читается позже разбора Renovate) всё равно идёт до конфига Renovate.
test('нечитаемый вложенный package.json идёт до Renovate, который не разобрался', () => {
	const repo = testRepo(testCanon(), {
		'packages/a/package.json': failed('EACCES', 'permission denied'),
		'renovate.json5': '{',
	});
	expect(byTarget(repo)).toEqual(['packages/a/package.json', 'renovate.json5']);
});

test('каталог (failed) на месте renovate.json заслоняет renovate.json5, тот остаётся в paths и files', () => {
	const repo = testRepo(testCanon(), {
		'renovate.json': failed('EISDIR', 'illegal operation on a directory'),
		'renovate.json5': '{',
	});
	expect(repo.renovate).toEqual({ path: 'renovate.json' });
	expect(triple(repo)).toEqual([
		['unreadable-file', 'renovate.json', 'renovate.json does not parse as JSON5'],
	]);
	expect(repo.paths.has('renovate.json5')).toBe(true);
	expect(repo.files.get('renovate.json5')).toBe('{');
});

test('битый pnpm-workspace.yaml — в находке только первая строка ошибки yaml', () => {
	const repo = fromTexts(new Map([['pnpm-workspace.yaml', 'a: [\n']]));
	expect(repo.unreadable).toHaveLength(1);
	const message = repo.unreadable[0]?.message ?? '';
	expect(message).toBe(
		'pnpm-workspace.yaml does not parse: Flow sequence in block collection must be sufficiently indented and end with a ] at line 2, column 1:',
	);
	expect(message).not.toContain('\n');
});

test('paths: ключи files и существующие нечитаемые пути; missing пути не даёт', () => {
	expect(
		repoFromSnapshot(
			new Map<string, Read>([
				['a.txt', { text: 'x' }],
				['dir', { failed: ioError('EISDIR', "illegal operation on a directory, read 'dir'") }],
				['gone', { missing: true }],
			]),
		).paths,
	).toEqual(new Set(['a.txt', 'dir']));
});

test('pnpm-workspace.yaml разобран в repo.workspace; без файла и при ошибках YAML документа нет', () => {
	const ok = fromTexts(
		new Map([['pnpm-workspace.yaml', 'catalogs:\n  dev:\n    oxlint: 1.0.0\n']]),
	);
	expect(ok.workspace?.getIn(['catalogs', 'dev', 'oxlint'])).toBe('1.0.0');
	expect(ok.unreadable).toEqual([]);
	expect(fromTexts(new Map()).workspace).toBeUndefined();
	const broken = fromTexts(new Map([['pnpm-workspace.yaml', 'catalogs: [\n  dev: {\n']]));
	expect(broken.workspace).toBeUndefined();
	expect(broken.unreadable).toHaveLength(1);
	expect(broken.unreadable[0]).toMatchObject({
		code: 'unreadable-file',
		target: 'pnpm-workspace.yaml',
	});
	expect(broken.unreadable[0]?.message).toStartWith('pnpm-workspace.yaml does not parse: ');
});

test('вложенные package.json без pnpm-workspace.yaml среди путей repoFromSnapshot не разбирает', () => {
	const files = new Map([
		['package.json', '{}'],
		['packages/a/package.json', '{'],
		['packages/b/package.json', '{}'],
	]);
	const bare = fromTexts(files);
	expect([...bare.packages.keys()]).toEqual(['package.json']);
	expect(bare.unreadable).toEqual([]);
	// путь есть, но не прочитан (каталог): вложенные всё равно в области
	const unreadableWorkspace = repoFromSnapshot(
		new Map<string, Read>([
			...texts(files),
			['pnpm-workspace.yaml', { failed: ioError('EISDIR', 'illegal operation on a directory') }],
		]),
	);
	expect(byTarget(unreadableWorkspace)).toEqual(['pnpm-workspace.yaml', 'packages/a/package.json']);
});

test('pnpm-workspace.yaml нечитаем: одна находка, документа нет, вложенные читаются, check не плодит каталожных', () => {
	const canon = testCanon({ catalogs: { dev: { oxlint: '1.83.0' } } });
	const repo = testRepo(canon, {
		'pnpm-workspace.yaml': failed('EISDIR', 'illegal operation on a directory'),
		'packages/a/package.json': '{',
	});
	expect(byTarget(repo)).toEqual(['pnpm-workspace.yaml', 'packages/a/package.json']);
	expect(repo.unreadable[0]?.message).toStartWith('pnpm-workspace.yaml does not parse: EISDIR');
	expect(repo.workspace).toBeUndefined();
	expect(repo.paths.has('pnpm-workspace.yaml')).toBe(true);
	expect(
		check(repo, canon, []).filter(
			(f) => f.target.startsWith('pnpm-workspace') || f.code.startsWith('catalog'),
		),
	).toMatchObject([{ code: 'unreadable-file', target: 'pnpm-workspace.yaml' }]);
});

test('pnpm-workspace.yaml с ошибками YAML — одна находка вместо катушки catalog-missing, sync не падает', () => {
	const canon = testCanon({ catalogs: { dev: { oxlint: '1.83.0', typescript: '7.0.2' } } });
	const broken = 'catalogs: [\n  dev: {\n';
	expect(check(testRepo(canon, { 'pnpm-workspace.yaml': broken }), canon, [])).toMatchObject([
		{ code: 'unreadable-file', target: 'pnpm-workspace.yaml' },
	]);
	const dir = repoDir({ 'pnpm-workspace.yaml': broken, 'package.json': '{}' });
	expect(syncRepo(dir, canon, []).applied.filter((d) => d.code.startsWith('catalog'))).toEqual([]);
	expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toBe(broken);
});

// existsSync-паритет: каталог на месте satisfiedBy — файл «есть», второй конфиг не засевается.
test('каталог renovate.json при каноне renovate.json5 (satisfiedBy) — plan без file-missing', () => {
	const canon = testCanon({
		files: [
			{
				dest: 'renovate.json5',
				content: '{}',
				strategy: 'create-if-absent',
				satisfiedBy: ['renovate.json', '.renovaterc'],
			},
		],
	});
	const repo = testRepo(canon, {
		'renovate.json5': null,
		'renovate.json': failed('EISDIR', 'illegal operation on a directory'),
	});
	expect(plan(repo, canon)).toEqual([]);
});

test('каталог на месте create-if-absent файла — не отсутствие, засева нет', () => {
	const canon = testCanon({
		files: [{ dest: 'seed.txt', content: 'a', strategy: 'create-if-absent' }],
	});
	const repo = testRepo(canon, {
		'seed.txt': failed('EISDIR', 'illegal operation on a directory'),
	});
	expect(repo.files.has('seed.txt')).toBe(false);
	expect(repo.paths.has('seed.txt')).toBe(true);
	expect(plan(repo, canon)).toEqual([]);
});

test('каталог на месте verbatim-файла остаётся file-missing — громко, как и было', () => {
	const canon = testCanon({ files: [{ dest: 'seed.txt', content: 'a' }] });
	const repo = testRepo(canon, {
		'seed.txt': failed('EISDIR', 'illegal operation on a directory'),
	});
	expect(plan(repo, canon)).toMatchObject([{ code: 'file-missing', target: 'seed.txt' }]);
});

test('dependabot: каталог на месте конфига — существующий путь, dependabot-config как на main', () => {
	const repo = testRepo(testCanon(), {
		'.github/dependabot.yml': failed('EISDIR', 'illegal operation on a directory'),
	});
	expect(check(repo, testCanon(), []).filter((f) => f.code === 'dependabot-config')).toMatchObject([
		{ target: '.github/dependabot.yml' },
	]);
});

test('inline-version при нечитаемом pnpm-workspace.yaml: гейт workspace — по существованию пути', () => {
	const canon = testCanon({ catalogs: { dev: { oxlint: '1.83.0' } } });
	const repo = testRepo(canon, {
		'pnpm-workspace.yaml': failed('EISDIR', 'illegal operation on a directory'),
		'package.json': '{"devDependencies":{"oxlint":"1.0.0"}}',
	});
	expect(check(repo, canon, []).map((f) => f.code)).toContain('inline-version');
});

// Адаптер диска: сверяем значения снимка, а не находки.
const read = (snapshot: Snapshot, path: string): Read => snapshot.get(path) as Read;
const nested = (snapshot: Snapshot) =>
	[...snapshot.keys()].filter((p) => p.endsWith('package.json')).sort();

test('readSnapshot: нет файла, ENOTDIR и ELOOP — missing; каталог — failed с EISDIR', () => {
	const dir = repoDir({
		'.github': 'не каталог',
		'renovate.json5/inner.txt': 'x',
		'package.json': '{}',
	});
	symlinkSync('renovate.json', join(dir, 'renovate.json'));
	const snapshot = readSnapshot(dir, testCanon());
	expect(read(snapshot, 'package.json')).toEqual({ text: '{}' });
	expect(read(snapshot, '.renovaterc.json')).toEqual({ missing: true });
	expect(read(snapshot, '.github/renovate.json')).toEqual({ missing: true });
	expect(read(snapshot, 'renovate.json')).toEqual({ missing: true });
	expect(read(snapshot, WORKSPACE_FILE)).toEqual({ missing: true });
	const dirRead = read(snapshot, 'renovate.json5');
	expect(dirRead).toHaveProperty('failed');
	expect((dirRead as { failed: Error }).failed).toMatchObject({ code: 'EISDIR' });
});

test('readSnapshot: вложенные package.json читаются только при pnpm-workspace.yaml (текст или failed) и мимо SKIP', () => {
	const tree = {
		'package.json': '{}',
		'packages/a/package.json': '{}',
		'node_modules/x/package.json': '{',
		'.worktrees/w/package.json': '{',
		'.moon/cache/c/package.json': '{',
		'packages/a/dist/package.json': '{',
		'build/package.json': '{',
	};
	const expected = ['package.json', 'packages/a/package.json'];
	const withText = readSnapshot(
		repoDir({ ...tree, 'pnpm-workspace.yaml': 'packages: []' }),
		testCanon(),
	);
	expect(nested(withText)).toEqual(expected);
	expect(read(withText, 'packages/a/package.json')).toEqual({ text: '{}' });
	const withDir = readSnapshot(
		repoDir({ ...tree, 'pnpm-workspace.yaml/inner.txt': 'x' }),
		testCanon(),
	);
	expect(nested(withDir)).toEqual(expected);
	expect(nested(readSnapshot(repoDir(tree), testCanon()))).toEqual(['package.json']);
});

test('readSnapshot: кандидаты — package.json, pnpm-workspace.yaml, dest и satisfiedBy канона, Renovate и dependabot', () => {
	const dir = repoDir({
		'.github/renovate.json5': '{}',
		'.github/dependabot.yml': 'version: 2',
		'.github/dependabot.yaml': 'version: 3',
		'seed.txt': 'a',
		'alt/seed.txt': 'b',
		'other.txt': 'x',
	});
	const snapshot = readSnapshot(
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
	expect([...snapshot.keys()].sort()).toEqual(
		[
			'package.json',
			WORKSPACE_FILE,
			'renovate.json5',
			'.github/renovate.json5',
			'seed.txt',
			'alt/seed.txt',
			...RENOVATE_CONFIGS,
			...DEPENDABOT_CONFIGS,
		]
			.filter((p, i, all) => all.indexOf(p) === i)
			.sort(),
	);
	expect(read(snapshot, 'seed.txt')).toEqual({ text: 'a' });
	expect(read(snapshot, 'alt/seed.txt')).toEqual({ text: 'b' });
	expect(read(snapshot, '.github/dependabot.yml')).toEqual({ text: 'version: 2' });
	expect(read(snapshot, '.github/dependabot.yaml')).toEqual({ text: 'version: 3' });
	expect(read(snapshot, 'renovate.json5')).toEqual({ missing: true });
	expect(snapshot.has('other.txt')).toBe(false);
});
