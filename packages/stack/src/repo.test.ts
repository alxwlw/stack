import { chmodSync, existsSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

import { check, checkRepo, plan, syncRepo } from './check.ts';
import { loadRepo, repoFromFiles } from './repo.ts';
import { repoDir, testCanon, testRepo } from './testkit.ts';

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
	const repo = repoFromFiles(
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
			['pnpm-workspace.yaml', 'packages: []'],
			['package.json', 'null'],
			['a/package.json', '[1]'],
		]),
	);
	expect(repo.unreadable).toEqual([]);
	expect(repo.packages.get('package.json')).toEqual({});
	expect(repo.packages.get('a/package.json')).toEqual({});
});

test('читаются только файлы: каталог по пути канон-файла в files не попадает, находки нет', () => {
	const dir = repoDir({ 'seed.txt/inner.txt': 'x' });
	const repo = loadRepo(dir, testCanon({ files: [{ dest: 'seed.txt', content: 'a' }] }));
	expect(repo.files.has('seed.txt')).toBe(false);
	expect(repo.paths.has('seed.txt')).toBe(true);
	expect(repo.unreadable).toEqual([]);
});

test('loadRepo читает .github/dependabot.yml и .github/dependabot.yaml', () => {
	const repo = loadRepo(
		repoDir({
			'.github/dependabot.yml': 'version: 2',
			'.github/dependabot.yaml': 'version: 3',
		}),
		testCanon(),
	);
	expect(repo.files.get('.github/dependabot.yml')).toBe('version: 2');
	expect(repo.files.get('.github/dependabot.yaml')).toBe('version: 3');
});

// chmod 0 не действует от root
test.skipIf(process.getuid?.() === 0)(
	'нечитаемый (EACCES) package.json — одна unreadable-file, как у правил',
	() => {
		const dir = repoDir({ 'package.json': '{}' });
		chmodSync(join(dir, 'package.json'), 0);
		const repo = loadRepo(dir, testCanon());
		expect(repo.unreadable).toHaveLength(1);
		expect(repo.unreadable[0]?.message).toStartWith('package.json does not parse: EACCES');
		expect(repo.packages.size).toBe(0);
	},
);

test.skipIf(process.getuid?.() === 0)(
	'нечитаемые вложенный package.json и корневой — по одной находке, порядок корень, вложенный',
	() => {
		const dir = repoDir({
			'pnpm-workspace.yaml': 'packages: []',
			'package.json': '{}',
			'packages/a/package.json': '{}',
		});
		chmodSync(join(dir, 'package.json'), 0);
		chmodSync(join(dir, 'packages/a/package.json'), 0);
		expect(byTarget(loadRepo(dir, testCanon()))).toEqual([
			'package.json',
			'packages/a/package.json',
		]);
	},
);

test('каталог renovate.json — одна находка и заслоняет renovate.json5', () => {
	const dir = repoDir({
		'renovate.json/inner.txt': 'x',
		'renovate.json5': '{',
	});
	const repo = loadRepo(dir, testCanon());
	expect(repo.renovate).toEqual({ path: 'renovate.json' });
	expect(repo.unreadable).toEqual([
		{
			code: 'unreadable-file',
			target: 'renovate.json',
			message: 'renovate.json does not parse as JSON5',
		},
	]);
	expect(repo.files.get('renovate.json5')).toBe('{');
});

test('нечитаемый renovate.json не отнимает у paths существующий renovate.json5', () => {
	const repo = loadRepo(
		repoDir({ 'renovate.json/inner.txt': 'x', 'renovate.json5': '{}' }),
		testCanon(),
	);
	expect(repo.paths.has('renovate.json5')).toBe(true);
});

test('битый pnpm-workspace.yaml — в находке только первая строка ошибки yaml', () => {
	const repo = repoFromFiles(new Map([['pnpm-workspace.yaml', 'a: [\n']]));
	expect(repo.unreadable).toHaveLength(1);
	const message = repo.unreadable[0]?.message ?? '';
	expect(message).toBe(
		'pnpm-workspace.yaml does not parse: Flow sequence in block collection must be sufficiently indented and end with a ] at line 2, column 1:',
	);
	expect(message).not.toContain('\n');
});

test('порядок unreadable при нечитаемых файлах: корневой, вложенный, Renovate', () => {
	const repo = loadRepo(
		repoDir({
			'pnpm-workspace.yaml': 'packages: []',
			'package.json/inner.txt': 'x',
			'packages/a/package.json': '{',
			'renovate.json/inner.txt': 'x',
		}),
		testCanon(),
	);
	expect(byTarget(repo)).toEqual(['package.json', 'packages/a/package.json', 'renovate.json']);
	expect(repo.unreadable[0]?.message).toStartWith('package.json does not parse: EISDIR');
});

// «Нет файла» — так же, как его видит existsSync: не только ENOENT, но и ENOTDIR (путь под обычным
// файлом) и ELOOP (петля симлинков). Это не находка и не заслоняет следующий конфиг Renovate.
test('путь под обычным файлом (ENOTDIR) — нет файла: Renovate берётся следующий, находки нет', () => {
	const repo = loadRepo(
		repoDir({ '.github': 'не каталог', '.renovaterc.json': '{ "extends": ["a"] }' }),
		testCanon(),
	);
	expect(repo.renovate).toEqual({ path: '.renovaterc.json', config: { extends: ['a'] } });
	expect(repo.unreadable).toEqual([]);
	expect(repo.files.has('.github/renovate.json')).toBe(false);
});

test('петля симлинков (ELOOP) вместо конфига Renovate — нет файла, находки нет', () => {
	const dir = repoDir({ '.renovaterc.json': '{}' });
	symlinkSync('renovate.json', join(dir, 'renovate.json'));
	const repo = loadRepo(dir, testCanon());
	expect(repo.renovate).toEqual({ path: '.renovaterc.json', config: {} });
	expect(repo.unreadable).toEqual([]);
});

test('paths: ключи files и существующие нечитаемые пути; несуществующий пути не даёт', () => {
	expect(repoFromFiles(new Map([['a.txt', 'x']]), ['dir']).paths).toEqual(
		new Set(['a.txt', 'dir']),
	);
	const repo = loadRepo(
		repoDir({ 'package.json': '{}', '.editorconfig/inner.txt': 'x' }),
		testCanon({
			files: [
				{ dest: '.editorconfig', content: 'a' },
				{ dest: '.absent', content: 'b' },
			],
		}),
	);
	expect(repo.paths.has('package.json')).toBe(true);
	expect(repo.paths.has('.editorconfig')).toBe(true);
	expect(repo.paths.has('.absent')).toBe(false);
	expect(repo.paths.has('pnpm-workspace.yaml')).toBe(false);
});

test('pnpm-workspace.yaml разобран в repo.workspace; без файла и при ошибках YAML документа нет', () => {
	const ok = repoFromFiles(
		new Map([['pnpm-workspace.yaml', 'catalogs:\n  dev:\n    oxlint: 1.0.0\n']]),
	);
	expect(ok.workspace?.getIn(['catalogs', 'dev', 'oxlint'])).toBe('1.0.0');
	expect(ok.unreadable).toEqual([]);
	expect(repoFromFiles(new Map()).workspace).toBeUndefined();
	const broken = repoFromFiles(new Map([['pnpm-workspace.yaml', 'catalogs: [\n  dev: {\n']]));
	expect(broken.workspace).toBeUndefined();
	expect(broken.unreadable).toHaveLength(1);
	expect(broken.unreadable[0]).toMatchObject({
		code: 'unreadable-file',
		target: 'pnpm-workspace.yaml',
	});
	expect(broken.unreadable[0]?.message).toStartWith('pnpm-workspace.yaml does not parse: ');
});

test('вложенные package.json без pnpm-workspace.yaml среди путей repoFromFiles не разбирает', () => {
	const files = new Map([
		['package.json', '{}'],
		['packages/a/package.json', '{'],
		['packages/b/package.json', '{}'],
	]);
	const bare = repoFromFiles(files);
	expect([...bare.packages.keys()]).toEqual(['package.json']);
	expect(bare.unreadable).toEqual([]);
	// путь есть, но не прочитан (каталог): вложенные всё равно в области
	expect(byTarget(repoFromFiles(files, ['pnpm-workspace.yaml']))).toEqual([
		'packages/a/package.json',
	]);
});

test('pnpm-workspace.yaml — каталог: одна находка, документа нет, вложенные package.json читаются', () => {
	const dir = repoDir({
		'pnpm-workspace.yaml/inner.txt': 'x',
		'package.json': '{}',
		'packages/a/package.json': '{',
	});
	const repo = loadRepo(dir, testCanon());
	expect(byTarget(repo)).toEqual(['pnpm-workspace.yaml', 'packages/a/package.json']);
	expect(repo.unreadable[0]?.message).toStartWith('pnpm-workspace.yaml does not parse: EISDIR');
	expect(repo.workspace).toBeUndefined();
	expect(repo.paths.has('pnpm-workspace.yaml')).toBe(true);
	// check не молчит и не плодит каталожных находок: ровно эта одна
	const canon = testCanon({ catalogs: { dev: { oxlint: '1.83.0' } } });
	expect(
		checkRepo(dir, canon, []).filter(
			(f) => f.target.startsWith('pnpm-workspace') || f.code.startsWith('catalog'),
		),
	).toMatchObject([{ code: 'unreadable-file', target: 'pnpm-workspace.yaml' }]);
});

test.skipIf(process.getuid?.() === 0)(
	'нечитаемый (EACCES) pnpm-workspace.yaml — одна находка',
	() => {
		const dir = repoDir({ 'pnpm-workspace.yaml': 'packages: []', 'package.json': '{}' });
		chmodSync(join(dir, 'pnpm-workspace.yaml'), 0);
		const repo = loadRepo(dir, testCanon());
		expect(byTarget(repo)).toEqual(['pnpm-workspace.yaml']);
		expect(repo.unreadable[0]?.message).toStartWith('pnpm-workspace.yaml does not parse: EACCES');
	},
);

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
	const dir = repoDir({ 'renovate.json/inner.txt': 'x' });
	expect(plan(loadRepo(dir, canon), canon)).toEqual([]);
	syncRepo(dir, canon, []);
	expect(existsSync(join(dir, 'renovate.json5'))).toBe(false);
});

test('каталог на месте create-if-absent файла — не отсутствие, засева нет', () => {
	const canon = testCanon({
		files: [{ dest: 'seed.txt', content: 'a', strategy: 'create-if-absent' }],
	});
	expect(plan(loadRepo(repoDir({ 'seed.txt/inner.txt': 'x' }), canon), canon)).toEqual([]);
});

test('каталог на месте verbatim-файла остаётся file-missing — громко, как и было', () => {
	const canon = testCanon({ files: [{ dest: 'seed.txt', content: 'a' }] });
	expect(plan(loadRepo(repoDir({ 'seed.txt/inner.txt': 'x' }), canon), canon)).toMatchObject([
		{ code: 'file-missing', target: 'seed.txt' },
	]);
});

test('dependabot: каталог на месте конфига — существующий путь, dependabot-config как на main', () => {
	const dir = repoDir({ '.github/dependabot.yml/inner.txt': 'x' });
	expect(
		checkRepo(dir, testCanon(), []).filter((f) => f.code === 'dependabot-config'),
	).toMatchObject([{ target: '.github/dependabot.yml' }]);
});

test('inline-version при нечитаемом pnpm-workspace.yaml: гейт workspace — по существованию пути', () => {
	const canon = testCanon({ catalogs: { dev: { oxlint: '1.83.0' } } });
	const dir = repoDir({
		'pnpm-workspace.yaml/inner.txt': 'x',
		'package.json': '{"devDependencies":{"oxlint":"1.0.0"}}',
	});
	expect(checkRepo(dir, canon, []).map((f) => f.code)).toContain('inline-version');
});

// Нечитаемый вложенный package.json (читается позже разбора Renovate) всё равно идёт до конфига Renovate.
test.skipIf(process.getuid?.() === 0)(
	'нечитаемый вложенный package.json идёт до Renovate, который не разобрался',
	() => {
		const dir = repoDir({
			'pnpm-workspace.yaml': 'packages: []',
			'packages/a/package.json': '{}',
			'renovate.json5': '{',
		});
		chmodSync(join(dir, 'packages/a/package.json'), 0);
		expect(byTarget(loadRepo(dir, testCanon()))).toEqual([
			'packages/a/package.json',
			'renovate.json5',
		]);
	},
);
