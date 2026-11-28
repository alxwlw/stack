import * as fs from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, spyOn, test } from 'bun:test';
import { parse as parseJsonc } from 'jsonc-parser';
import { parse as parseYaml } from 'yaml';

import {
	canonDir,
	canonFor,
	type CanonSource,
	knownGroups,
	loadCanon,
	readCanonSource,
} from './canon.ts';
import { type Profile, type StackConfig, StackConfigError } from './config.ts';
import { RENOVATE_CONFIGS } from './repo.ts';
import { RULE_NAMES } from './rule-settings.ts';
import {
	canonBundles,
	canonFile,
	matchesAny,
	OWNER_SOURCE,
	parseBundles,
	repoDir,
} from './testkit.ts';
import { ACME_SETTINGS, acmeSource, rulesWithout, TEST_SETTINGS } from './testkit-sources.ts';

// Не канон-файл: README лежит рядом с пакетом, а не в canon/.
const README_PATH = join(import.meta.dir, '..', '..', '..', 'README.md');

const cfg = (over: Partial<StackConfig> = {}): StackConfig => ({
	profile: 'node',
	with: [],
	exceptions: [],
	...over,
});

const PROTOTOOLS = 'node = "26.8.1"\npnpm = "11.15.0"\n\n[plugins]\nx = "file://x.toml"\n';

// Источник-литерал: loadCanon не нужен, canonFor получает канон значением.
function fixtureSource(): CanonSource {
	return {
		settings: { ...TEST_SETTINGS, groups: [] },
		entries: [
			{
				src: 'files/editorconfig',
				dest: '.editorconfig',
				appliesTo: ['node', 'contracts', 'infra'],
				content: 'root = true\n',
			},
			{
				src: 'files/gitleaks-local.toml',
				dest: '.gitleaks.toml',
				appliesTo: ['node', 'contracts', 'infra'],
				strategy: 'create-if-absent',
				content: '[extend]\n',
			},
			{
				src: 'files/prototools',
				dest: '.prototools',
				appliesTo: ['node', 'infra'],
				content: PROTOTOOLS,
			},
			{
				src: 'files/contracts.prototools',
				dest: '.prototools',
				appliesTo: ['contracts'],
				content: 'node = "0.0.0-fixture"\npnpm = "0.0.0-fixture"\n',
			},
			{
				src: 'files/moon-task.yml',
				dest: '.moon/tasks/stack.yml',
				appliesTo: ['node'],
				group: 'moon-tasks',
				content: 'tasks: {}\n',
			},
		],
		catalogs: { dev: { oxlint: '1.83.0', typescript: '7.0.2' }, libs: { react: '19.2.7' } },
		groups: { files: ['moon-tasks'], catalogs: ['libs'] },
		manifest: { name: '@alxwlw/stack', version: '0.0.0' },
	};
}

// Источник с подменённым содержимым записи files/prototools.
function withPrototools(content: string): CanonSource {
	const source = fixtureSource();
	return {
		...source,
		entries: source.entries.map((e) => (e.src === 'files/prototools' ? { ...e, content } : e)),
	};
}

test('canonFor: файлы профиля с содержимым и стратегией; чужой профиль и чужая группа не приезжают', () => {
	expect(canonFor(fixtureSource(), cfg()).files).toEqual([
		{ dest: '.editorconfig', content: 'root = true\n' },
		{ dest: '.gitleaks.toml', content: '[extend]\n', strategy: 'create-if-absent' },
		{ dest: '.prototools', content: PROTOTOOLS },
	]);
});

test('canonFor: файл группы приезжает только при with', () => {
	const source = fixtureSource();
	const dests = (c: StackConfig) => canonFor(source, c).files.map((f) => f.dest);
	expect(dests(cfg())).not.toContain('.moon/tasks/stack.yml');
	expect(dests(cfg({ with: ['moon-tasks'] }))).toContain('.moon/tasks/stack.yml');
});

test('canonFor: каталоги — dev всегда, группа только при with', () => {
	const source = fixtureSource();
	const dev = { oxlint: '1.83.0', typescript: '7.0.2' };
	expect(canonFor(source, cfg()).catalogs).toEqual({ dev });
	const withGroups = canonFor(source, cfg({ with: ['libs'] })).catalogs;
	expect(Object.keys(withGroups)).toEqual(['dev', 'libs']);
	expect(withGroups).toEqual({ dev, libs: { react: '19.2.7' } });
});

test('canonFor: неизвестная группа в with — StackConfigError с её именем и списком допустимых', () => {
	const source = fixtureSource();
	expect(() => canonFor(source, cfg({ with: ['moon-task'] }))).toThrow(StackConfigError);
	expect(() => canonFor(source, cfg({ with: ['moon-task'] }))).toThrow(
		'unknown group "moon-task" in "with", expected one of: libs, moon-tasks, renovate',
	);
	// Опечатка не в первой позиции тоже ловится.
	expect(() => canonFor(source, cfg({ with: ['libs', 'moon-task'] }))).toThrow(
		'unknown group "moon-task" in "with", expected one of: libs, moon-tasks, renovate',
	);
	// Устаревшая группа принимается и ничего не включает.
	expect(canonFor(source, cfg({ with: ['renovate'] })).files).toEqual(
		canonFor(source, cfg()).files,
	);
});

test('canonFor: группа каталога без файлов в манифесте остаётся известной', () => {
	const source = fixtureSource();
	expect(source.entries.some((e) => e.group === 'libs')).toBe(false);
	expect(() => canonFor(source, cfg({ with: ['libs'] }))).not.toThrow();
});

test('canonFor: пины — строковые значения верхнего уровня канон-.prototools своего профиля', () => {
	const source = fixtureSource();
	expect(canonFor(source, cfg()).pins).toEqual({ node: '26.8.1', pnpm: '11.15.0' });
	expect(canonFor(source, cfg({ profile: 'contracts' })).pins).toEqual({
		node: '0.0.0-fixture',
		pnpm: '0.0.0-fixture',
	});
});

test('canonFor: прочие строковые пины верхнего уровня канон-.prototools попадают в pins', () => {
	const source = withPrototools('node = "26.8.1"\npnpm = "11.15.0"\nbun = "1.0.0"\n');
	expect(canonFor(source, cfg()).pins).toEqual({ node: '26.8.1', pnpm: '11.15.0', bun: '1.0.0' });
});

test('canonFor: таблицы и нестроковые значения .prototools — не пины', () => {
	const source = withPrototools(
		'node = "1.2.3"\npnpm = "4.5.6"\nretries = 3\n\n[plugins]\nx = "file://x.toml"\n',
	);
	expect(canonFor(source, cfg()).pins).toEqual({ node: '1.2.3', pnpm: '4.5.6' });
});

test('canonFor: в каноне .prototools нет пина pnpm — ошибка', () => {
	expect(() => canonFor(withPrototools('node = "26.8.1"\n'), cfg())).toThrow(
		'canon .prototools has no pnpm pin',
	);
});

test('canonFor: в манифесте нет .prototools для профиля — ошибка', () => {
	const source = fixtureSource();
	const noPrototools = {
		...source,
		entries: source.entries.filter((e) => e.dest !== '.prototools'),
	};
	expect(() => canonFor(noPrototools, cfg())).toThrow(
		'canon manifest has no .prototools entry for profile node',
	);
});

test('canonFor: в каноне .prototools нет пина node — ошибка', () => {
	expect(() => canonFor(withPrototools('pnpm = "11.15.0"\n'), cfg())).toThrow(
		'canon .prototools has no node pin',
	);
});

// Граница с диском: записи манифеста по порядку и содержимое файла.
test('readCanonSource на настоящем canon/: все записи манифеста с содержимым файла', () => {
	const manifest = JSON.parse(readFileSync(join(canonDir(), 'manifest.json'), 'utf8')) as {
		files: { src: string }[];
	};
	const { entries } = readCanonSource();
	expect(entries).toHaveLength(manifest.files.length);
	expect(entries.map((e) => e.src)).toEqual(manifest.files.map((f) => f.src));
	expect(entries.find((e) => e.src === 'files/prototools')?.content).toBe(
		readFileSync(join(canonDir(), 'files', 'prototools'), 'utf8'),
	);
});

// Литеральный canon/ на диске: manifest из записей, каталог только dev, два src-файла.
const literalCanon = (files: unknown): string =>
	repoDir({
		'settings.json': JSON.stringify({
			...TEST_SETTINGS,
			rules: rulesWithout('canon-not-extended'),
		}),
		'manifest.json': JSON.stringify({ files }),
		'catalogs.json': '{ "dev": {} }',
		'files/a': 'A',
		'files/b': 'B',
	});

const entry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
	src: 'files/a',
	dest: 'a.txt',
	appliesTo: ['node'],
	...over,
});

test('readCanonSource: литеральный manifest без нарушений читается', () => {
	const { entries } = readCanonSource(
		literalCanon([
			entry(),
			// Один dest в разных Profile — законно: у профиля своя версия файла.
			entry({ src: 'files/b', appliesTo: ['contracts', 'infra'] }),
			entry({ dest: 'seed.txt', strategy: 'create-if-absent', satisfiedBy: ['seed.json'] }),
			entry({ dest: 'v.txt', strategy: 'verbatim', group: 'g' }),
		]),
	);
	expect(entries.map((e) => [e.dest, e.content])).toEqual([
		['a.txt', 'A'],
		['a.txt', 'B'],
		['seed.txt', 'A'],
		['v.txt', 'A'],
	]);
});

const AT = /^canon manifest: entry 0 \(a\.txt\): /.source;
const badManifests: [string, unknown, RegExp][] = [
	['опечатка в appliesTo', [entry({ appliesTo: ['nod'] })], new RegExp(`${AT}.*appliesTo.*nod`)],
	['пустой appliesTo', [entry({ appliesTo: [] })], new RegExp(`${AT}.*appliesTo`)],
	['appliesTo — строка', [entry({ appliesTo: 'node' })], new RegExp(`${AT}.*appliesTo`)],
	[
		'повтор профиля в appliesTo',
		[entry({ appliesTo: ['node', 'node'] })],
		new RegExp(`${AT}.*appliesTo`),
	],
	[
		'опечатка в strategy',
		[entry({ strategy: 'create-if-absnt' })],
		new RegExp(`${AT}.*strategy.*create-if-absnt`),
	],
	[
		'satisfiedBy без strategy',
		[entry({ satisfiedBy: ['b.txt'] })],
		new RegExp(`${AT}.*satisfiedBy`),
	],
	[
		'satisfiedBy у verbatim',
		[entry({ strategy: 'verbatim', satisfiedBy: ['b.txt'] })],
		new RegExp(`${AT}.*satisfiedBy`),
	],
	[
		'satisfiedBy — строка',
		[entry({ strategy: 'create-if-absent', satisfiedBy: 'b.txt' })],
		new RegExp(`${AT}.*satisfiedBy`),
	],
	['неизвестный ключ записи', [entry({ stratgy: 'verbatim' })], new RegExp(`${AT}.*stratgy`)],
	['нет src', [{ dest: 'a.txt', appliesTo: ['node'] }], new RegExp(`${AT}.*src`)],
	['group — число', [entry({ group: 1 })], new RegExp(`${AT}.*group`)],
	['пустой src', [entry({ src: '' })], new RegExp(`${AT}.*src`)],
	['пустой group', [entry({ group: '' })], new RegExp(`${AT}.*group`)],
	[
		// Пустой satisfiedBy не закрывает ни одного имени: в manifest это ошибка.
		'satisfiedBy — пустой массив',
		[entry({ strategy: 'create-if-absent', satisfiedBy: [] })],
		new RegExp(`${AT}.*satisfiedBy`),
	],
	[
		'satisfiedBy — не строка в массиве',
		[entry({ strategy: 'create-if-absent', satisfiedBy: [1] })],
		new RegExp(`${AT}.*satisfiedBy`),
	],
	// Унаследованное имя не ключ записи: `in` пропустил бы его.
	[
		'унаследованное имя как ключ записи',
		[entry({ constructor: 'x' })],
		new RegExp(`${AT}.*constructor`),
	],
	['пустой dest', [entry({ dest: '' })], /^canon manifest: entry 0: .*dest/],
	['запись — не объект', ['files/a'], /^canon manifest: entry 0: /],
	['files — не массив', 'files/a', /^canon manifest: "files" must be an array$/],
	[
		'dest дважды в одном Profile',
		[entry(), entry({ src: 'files/b', appliesTo: ['contracts', 'node'] })],
		/^canon manifest: dest "a\.txt" is listed twice for profile node$/,
	],
	[
		// Группы выбирает потребитель: две группы с одним dest рано или поздно включат вместе.
		'dest дважды в одном Profile при разных group',
		[entry({ group: 'g' }), entry({ src: 'files/b', group: 'h' })],
		/^canon manifest: dest "a\.txt" is listed twice for profile node$/,
	],
];

test.each(badManifests)('readCanonSource отклоняет manifest: %s', (_name, files, message) => {
	expect(() => readCanonSource(literalCanon(files))).toThrow(message);
});

test('readCanonSource: засев называет dest, которого не пишет ни одна запись манифеста', () => {
	const dir = repoDir({
		'settings.json': JSON.stringify({
			...TEST_SETTINGS,
			rules: {
				...TEST_SETTINGS.rules,
				'canon-not-extended': { seeds: { '.nope.json': { kind: 'gitleaks' } } },
			},
		}),
		'manifest.json': JSON.stringify({ files: [entry()] }),
		'catalogs.json': '{ "dev": {} }',
		'files/a': 'A',
	});
	expect(() => readCanonSource(dir)).toThrow(
		'canon settings: "rules.canon-not-extended.seeds" names ".nope.json", which no manifest entry writes',
	);
});

test('manifest.json с текстом null — files не массив', () => {
	const dir = repoDir({
		'settings.json': JSON.stringify(TEST_SETTINGS),
		'manifest.json': 'null',
		'catalogs.json': '{ "dev": {} }',
	});
	expect(() => readCanonSource(dir)).toThrow(/^canon manifest: "files" must be an array$/);
});

test('нарушение manifest — обычная ошибка, не StackConfigError, и раньше чтения src', () => {
	// src не существует: без проверки manifest чтение упало бы на ENOENT.
	const dir = literalCanon([entry({ src: 'files/missing', appliesTo: ['nod'] })]);
	let error: unknown;
	try {
		readCanonSource(dir);
	} catch (caught) {
		error = caught;
	}
	expect(error).toBeInstanceOf(Error);
	expect(error).not.toBeInstanceOf(StackConfigError);
	expect((error as Error).message).toMatch(/^canon manifest: entry 0 \(a\.txt\): .*appliesTo/);
});

// canonFile — вход тестов в канон: файла нет в профиле (или вообще нет) — ошибка с dest и профилем, а не пустая строка.
test('canonFile: файла нет в профиле — ошибка с dest и профилем', () => {
	expect(() => canonFile('.oxfmtrc.jsonc', 'infra')).toThrow(
		'no canon file .oxfmtrc.jsonc for profile infra',
	);
});

test('canonFile: несуществующий dest — ошибка с dest и профилем', () => {
	expect(() => canonFile('.no-such-file.toml')).toThrow(
		'no canon file .no-such-file.toml for profile node',
	);
});

// Поведение правил канона (keywords, allowlist) проверяет сам gitleaks — gitleaks.test.ts.
test('канон gitleaks: первая строка не обещает pre-commit', () => {
	expect(canonFile('.gitleaks.canon.toml').split('\n')[0]).not.toContain('pre-commit');
});

test('канон markdownlint не обещает глоб oxfmt, которого нет', () => {
	const jsonc = canonFile('.markdownlint-cli2.jsonc');
	// Только комментарии: `globs` самого конфига законно содержат **/*.mdx.
	const comments = jsonc
		.split('\n')
		.filter((l) => l.trimStart().startsWith('//'))
		.join('\n');
	expect(comments).not.toContain('mdx');
	expect(comments).not.toContain('existing `.moon/tasks/oxfmt.yml`');
});

test('канон markdownlint: игноры планов и спек superpowers на месте', () => {
	const cfg = parseJsonc(canonFile('.markdownlint-cli2.jsonc')) as { ignores?: string[] };
	expect(cfg.ignores).toEqual(
		expect.arrayContaining(['docs/superpowers/plans/**', 'docs/superpowers/specs/**']),
	);
});

test('канон markdownlint: опция gitignore указывает на .markdownlintignore', () => {
	const cfg = parseJsonc(canonFile('.markdownlint-cli2.jsonc')) as { gitignore?: string };
	expect(cfg.gitignore).toBe('.markdownlintignore');
});

// Шов репо-локальных игноров: cli2 читает .markdownlintignore через опцию gitignore, файл
// засевается один раз (create-if-absent) и дальше принадлежит репо.
test('канон засевает .markdownlintignore как create-if-absent в каждом профиле', () => {
	const source = readCanonSource();
	for (const profile of OWNER_SOURCE.settings.profiles) {
		const entry = canonFor(source, {
			profile,
			with: source.groups.files,
			exceptions: [],
		}).files.find((f) => f.dest === '.markdownlintignore');
		expect(entry?.strategy).toBe('create-if-absent');
	}
});

// Renovate — единственный бот канона: dependabot.yml не засевается никому, а группа renovate
// осталась допустимым значением для старых .stack.jsonc и ничего не меняет.
test('canonFor: dependabot.yml не засевается; with renovate не меняет набор файлов', () => {
	const source = readCanonSource();
	for (const profile of OWNER_SOURCE.settings.profiles) {
		const plain = canonFor(source, { profile, with: [], exceptions: [] }).files.map((f) => f.dest);
		expect(plain).not.toContain('.github/dependabot.yml');
		const renovate = canonFor(source, { profile, with: ['renovate'], exceptions: [] }).files.map(
			(f) => f.dest,
		);
		expect(renovate).toEqual(plain);
	}
});

test('канон Renovate: workflow и засев конфига — в каждом профиле', () => {
	const source = readCanonSource();
	for (const profile of OWNER_SOURCE.settings.profiles) {
		const files = canonFor(source, { profile, with: [], exceptions: [] }).files;
		const wf = files.find((f) => f.dest === '.github/workflows/renovate.yml');
		// Файл обязан быть в наборе профиля и быть verbatim (strategy не задан).
		expect(wf).toBeDefined();
		expect(wf?.strategy).toBeUndefined();
		const seed = files.find((f) => f.dest === 'renovate.json5');
		expect(seed?.strategy).toBe('create-if-absent');
		// dest ∪ satisfiedBy = все места, где Renovate ищет конфиг: засев не плодит второй конфиг.
		expect(new Set([seed?.dest, ...(seed?.satisfiedBy ?? [])])).toEqual(new Set(RENOVATE_CONFIGS));
	}
});

// Связка канон-файла workflow с reusable стека проверяется в workflow-calls.test.ts: там разбирается YAML.
test('канон Renovate: засев конфига подключает пресет стека @v1', () => {
	const seed = canonFile('renovate.json5');
	expect(seed).toContain("'github>alxwlw/stack//renovate/canon.json5#v1'");
	expect(seed).toContain("'config:recommended'");
});

test('knownGroups: файловые, каталожные, устаревшие группы и группы правил — без повторов, по алфавиту', () => {
	expect(
		knownGroups({
			groups: { files: ['knip', 'moon-tasks'], catalogs: ['libs', 'knip'] },
			settings: { ...TEST_SETTINGS, groups: ['peers'], deprecatedGroups: { renovate: 'why' } },
		}),
	).toEqual(['knip', 'libs', 'moon-tasks', 'peers', 'renovate']);
});

const deprecatedDir = (name: string): string =>
	repoDir({
		'settings.json': JSON.stringify({ ...TEST_SETTINGS, deprecatedGroups: { [name]: 'why' } }),
		'manifest.json': JSON.stringify({ files: [entry({ group: 'knip' })] }),
		'catalogs.json': '{ "dev": {}, "libs": {} }',
		'files/a': 'A',
	});

test.each(['knip', 'libs'])(
	'устаревшее имя %s совпадает с файловой или каталожной группой — ошибка пакета канона',
	(name) => {
		let error: unknown;
		try {
			readCanonSource(deprecatedDir(name));
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(StackConfigError);
		expect((error as Error).message).toBe(
			`canon settings: "deprecatedGroups" names "${name}", which the canon also offers`,
		);
	},
);

test('canonFor: группа правил, которой канон не предлагает, — неизвестная группа в with', () => {
	const source = fixtureSource();
	const only = { ...source, settings: { ...source.settings, groups: ['repo-rules' as const] } };
	expect(() => canonFor(only, cfg({ with: ['peers'] }))).toThrow(StackConfigError);
	expect(() => canonFor(only, cfg({ with: ['peers'] }))).toThrow(
		'unknown group "peers" in "with", expected one of: libs, moon-tasks, renovate, repo-rules',
	);
});

test('canonFor: файловая группа с именем группы правил приезжает, правило не включено', () => {
	const source = fixtureSource();
	const peersFile = {
		src: 'files/peers',
		dest: 'peers.txt',
		appliesTo: ['node'],
		group: 'peers',
		content: 'P',
	};
	const s = {
		...source,
		entries: [...source.entries, peersFile],
		groups: { ...source.groups, files: [...source.groups.files, 'peers'] },
	};
	const canon = canonFor(s, cfg({ with: ['peers'] }));
	expect(canon.rules).toStrictEqual([]);
	expect(canon.files.map((f) => f.dest)).toContain('peers.txt');
});

test('canonFor: порядок Canon.rules — RULE_GROUPS, а не порядок groups настроек', () => {
	const source = fixtureSource();
	const s = {
		...source,
		settings: { ...source.settings, groups: ['guardrails', 'repo-rules', 'peers'] as const },
	};
	expect(canonFor(s, cfg({ with: ['guardrails', 'peers'] })).rules).toStrictEqual([
		'peers',
		'guardrails',
	]);
});

test('canonFor: чужой канон предлагает свои группы — peers в with отклонён', () => {
	expect(() => canonFor(acmeSource(), { profile: 'web', with: ['peers'], exceptions: [] })).toThrow(
		'unknown group "peers" in "with", expected one of: repo-rules',
	);
});

test('группа правила peers: известна, попадает в Canon.rules, файлов и каталогов не добавляет', () => {
	const source = readCanonSource();
	expect(knownGroups(source)).toContain('peers');
	for (const profile of OWNER_SOURCE.settings.profiles) {
		const plain = canonFor(source, { profile, with: [], exceptions: [] });
		const peers = canonFor(source, { profile, with: ['peers'], exceptions: [] });
		expect(plain.rules, profile).toStrictEqual([]);
		expect(peers.rules, profile).toStrictEqual(['peers']);
		expect(peers.files, profile).toStrictEqual(plain.files);
		expect(peers.catalogs, profile).toStrictEqual(plain.catalogs);
	}
});

test('группы правил в Canon.rules идут в порядке RULE_GROUPS, каким бы ни был порядок with', () => {
	const cfg = { profile: 'node' as const, with: ['guardrails', 'peers'], exceptions: [] };
	expect(canonFor(readCanonSource(), cfg).rules).toStrictEqual(['peers', 'guardrails']);
});

// Строки таблицы «Group» в README: имя группы (текст между обратными кавычками первой ячейки) → вторая ячейка.
function readmeGroupRows(): Map<string, string> {
	const lines = readFileSync(README_PATH, 'utf8').split('\n');
	const start = lines.findIndex((l) => l.startsWith('| Group'));
	const rows = new Map<string, string>();
	for (const line of lines.slice(start + 1)) {
		if (line.trim() === '') break;
		if (!line.startsWith('| `')) continue;
		const cells = line.split('|').map((c) => c.trim());
		const name = /`([^`]+)`/.exec(cells[1] ?? '')?.[1];
		if (name) rows.set(name, cells[2] ?? '');
	}
	return rows;
}

test('README: таблица групп перечисляет ровно группы канона', () => {
	expect([...readmeGroupRows().keys()].sort()).toEqual(knownGroups(readCanonSource()));
});

// «Seeds» в README обещает засев: файл принадлежит репозиторию, sync его не перезаписывает.
test('README: группа «Seeds …» засевает все свои файлы, группа «Syncs …» синхронизирует хотя бы один дословно', () => {
	const manifest = readCanonSource().entries;
	const broken: string[] = [];
	for (const [group, adds] of readmeGroupRows()) {
		const strategies = manifest
			.filter((f) => f.group === group)
			.map((f) => f.strategy ?? 'verbatim');
		if (
			adds.startsWith('Seeds') &&
			!(strategies.length > 0 && strategies.every((s) => s === 'create-if-absent'))
		)
			broken.push(group);
		if (adds.startsWith('Syncs') && !strategies.includes('verbatim')) broken.push(group);
	}
	expect(broken).toEqual([]);
});

const MOON_TASKS = ['typescript', 'oxlint', 'oxfmt', 'bun-test'];

test('moon-tasks: четыре файла задач синхронизируются дословно, stack.yml — засев', () => {
	const group = readCanonSource().entries.filter((f) => f.group === 'moon-tasks');
	for (const name of MOON_TASKS) {
		const entry = group.find((f) => f.dest === `.moon/tasks/${name}.yml`);
		expect(entry?.strategy ?? 'verbatim').toBe('verbatim');
		expect(entry?.appliesTo).toEqual(['node', 'contracts']);
	}
	// stack.yml — два входа манифеста с одним dest (команда у infra своя): засев оба, вместе — все профили.
	const seeds = group.filter((f) => f.dest === '.moon/tasks/stack.yml');
	expect(seeds.map((f) => f.strategy)).toEqual(['create-if-absent', 'create-if-absent']);
	expect(seeds.flatMap((f) => f.appliesTo).sort()).toEqual(['contracts', 'infra', 'node']);
});

test('moon-tasks: форма потребителей — Bun, tsc --noEmit от корня, lint с отчётом о лишних disable', () => {
	const read = (name: string): string => canonFile(`.moon/tasks/${name}.yml`);
	expect(read('typescript')).toContain(
		"'$workspaceRoot/node_modules/typescript/bin/tsc', '--noEmit'",
	);
	expect(read('oxlint')).toContain("'--type-aware'");
	expect(read('oxlint')).toContain("'--report-unused-disable-directives'");
	expect(read('oxlint')).not.toContain('lint-fix');
	expect(read('oxfmt')).toContain("'oxfmt', '--check', '.'");
	expect(read('bun-test')).toContain("args: ['test']");
	for (const name of MOON_TASKS) {
		expect(read(name)).toContain('sync-managed');
		expect(read(name)).not.toContain('create-if-absent');
	}
});

// Задачу из .moon/tasks/ наследует каждый проект воркспейса, а .stack.jsonc лежит в корне: засев
// запускает stack check из корня, входы — от корня. Команда — как в check.yml: pnpm exec в
// pnpm-воркспейсе, bunx у infra (там нет package.json и node_modules).
const STACK_CHECK: Record<Profile, { command: string; inputs: string[] }> = {
	node: {
		command: 'pnpm exec stack check',
		inputs: ['/.stack.jsonc', '/.prototools', '/pnpm-workspace.yaml'],
	},
	contracts: {
		command: 'pnpm exec stack check',
		inputs: ['/.stack.jsonc', '/.prototools', '/pnpm-workspace.yaml'],
	},
	infra: { command: 'bunx @alxwlw/stack check', inputs: ['/.stack.jsonc', '/.prototools'] },
};

test('moon-tasks: stack.yml запускается из корня воркспейса', () => {
	for (const profile of OWNER_SOURCE.settings.profiles) {
		const content = canonFile('.moon/tasks/stack.yml', profile);
		const task = (parseYaml(content) as { tasks: Record<string, Record<string, unknown>> }).tasks[
			'stack-check'
		];
		expect([profile, task?.command, task?.inputs]).toEqual([
			profile,
			STACK_CHECK[profile]?.command,
			STACK_CHECK[profile]?.inputs,
		]);
		expect([profile, task?.options]).toEqual([
			profile,
			{ cache: false, runFromWorkspaceRoot: true },
		]);
		expect(content).toContain('(seeded once via --with=moon-tasks; repo-owned afterwards)');
	}
});

test('readCanonSource читает manifest.json и catalogs.json по одному разу', () => {
	const spy = spyOn(fs, 'readFileSync');
	try {
		loadCanon({ profile: 'node', with: ['libs', 'knip'], exceptions: [] });
		const paths = spy.mock.calls.map((c) => String(c[0]));
		expect(paths.filter((p) => p.endsWith('manifest.json'))).toHaveLength(1);
		expect(paths.filter((p) => p.endsWith('catalogs.json'))).toHaveLength(1);
	} finally {
		spy.mockRestore();
	}
});

const okBundle = { match: ['@x/**'], required: ['@x/a'], sameVersion: [['@x/**']] };

// JSON.stringify не пишет собственный ключ __proto__ из литерала, поэтому текст файла задан строкой.
test('parseBundles отклоняет: запись с именем __proto__', () => {
	const text = '{"__proto__":{"match":["@x/**"],"required":["@x/a"],"sameVersion":[["@x/**"]]}}';
	expect(() => parseBundles(text, 'b.json')).toThrow('b.json: __proto__: ');
});

test('parseBundles: правильная запись читается как есть', () => {
	expect(parseBundles(JSON.stringify({ x: okBundle }), 'b.json')).toStrictEqual({ x: okBundle });
});

// [что сломано, содержимое файла, что обязано быть в сообщении, запись в сообщении]
const badBundles: [string, unknown, string, boolean][] = [
	['верх — массив', [okBundle], 'b.json', false],
	['ни одной записи', {}, 'b.json', false],
	['лишний ключ', { x: { ...okBundle, sameversion: [] } }, 'sameversion', true],
	['нет ключа', { x: { match: ['@x/**'], required: ['@x/a'] } }, 'sameVersion', true],
	['пустой match', { x: { ...okBundle, match: [] } }, 'match', true],
	['пустая группа sameVersion', { x: { ...okBundle, sameVersion: [[]] } }, 'sameVersion', true],
	['не строка в required', { x: { ...okBundle, required: [5] } }, 'required', true],
	['отрицание в match', { x: { ...okBundle, match: ['!@x/b'] } }, '!@x/b', true],
	['regex в sameVersion', { x: { ...okBundle, sameVersion: [['/^@x\\//']] } }, '/^@x\\//', true],
	['glob в required', { x: { ...okBundle, required: ['@x/*'] } }, '@x/*', true],
];

test.each(badBundles)('parseBundles отклоняет: %s', (_what, data, needle, hasEntry) => {
	const parse = () => parseBundles(JSON.stringify(data), 'b.json');
	expect(parse).toThrow(needle);
	expect(parse).toThrow('b.json: ');
	if (hasEntry) expect(parse).toThrow('b.json: x');
});

// Связки: пакеты, которые пинят друг друга точно и поднимаются одной веткой Renovate (Bundle в GLOSSARY).
// Состав выводится из каталога по шаблону: новая запись под шаблон связки проверяется без правки данных и тестов.
const bundles = canonBundles();
const catalogs = readCanonSource().catalogs;
const bundleNames = Object.keys(bundles);

describe('связки canon/bundles.json в каталогах канона', () => {
	test.each(bundleNames)(
		'%s: required под match и целиком в каждом каталоге с пакетом связки',
		(name) => {
			const b = bundles[name]!;
			expect(b.required.filter((n) => !matchesAny(b.match, n))).toStrictEqual([]);
			const holders = Object.entries(catalogs).filter(([, entries]) =>
				Object.keys(entries).some((k) => matchesAny(b.match, k)),
			);
			expect(holders.length).toBeGreaterThan(0);
			for (const [catalog, entries] of holders) {
				expect([catalog, b.required.filter((n) => !Object.hasOwn(entries, n))]).toStrictEqual([
					catalog,
					[],
				]);
			}
		},
	);

	test.each(bundleNames)('%s: в каждой группе sameVersion одна версия', (name) => {
		const b = bundles[name]!;
		for (const g of b.sameVersion) {
			for (const p of g) {
				const found = Object.values(catalogs).some((entries) =>
					Object.keys(entries).some((k) => matchesAny([p], k)),
				);
				expect([p, found]).toStrictEqual([p, true]);
			}
			for (const [catalog, entries] of Object.entries(catalogs)) {
				const names = Object.keys(entries).filter((k) => matchesAny(g, k));
				expect([catalog, names.filter((n) => !matchesAny(b.match, n))]).toStrictEqual([
					catalog,
					[],
				]);
				const listing = names.map((n) => `${n}@${entries[n]}`);
				const many = new Set(names.map((n) => entries[n])).size > 1;
				expect([catalog, g, many ? listing : []]).toStrictEqual([catalog, g, []]);
			}
		}
	});

	test('пакет каталога — не больше чем в одной связке и одной группе версий своей связки', () => {
		const bad: [string, string, string[]][] = [];
		for (const [catalog, entries] of Object.entries(catalogs)) {
			for (const n of Object.keys(entries)) {
				const hit = bundleNames.filter((k) => matchesAny(bundles[k]!.match, n));
				if (hit.length > 1) bad.push([catalog, n, hit]);
				for (const k of hit) {
					const groups = bundles[k]!.sameVersion.filter((g) => matchesAny(g, n));
					if (groups.length > 1) bad.push([catalog, n, groups.map((g) => g.join(' '))]);
				}
			}
		}
		expect(bad).toStrictEqual([]);
	});
});

const acmeDir = (files: unknown): string =>
	repoDir({
		'settings.json': JSON.stringify({
			...ACME_SETTINGS,
			rules: rulesWithout('canon-not-extended'),
		}),
		'manifest.json': JSON.stringify({ files }),
		'catalogs.json': '{ "dev": {} }',
		'files/a': 'A',
	});

test('appliesTo манифеста проверяется по профилям настроек', () => {
	const a = (appliesTo: string[]) => ({ src: 'files/a', dest: 'a', appliesTo });
	expect(readCanonSource(acmeDir([a(['web'])])).entries).toHaveLength(1);
	expect(() => readCanonSource(acmeDir([a(['node'])]))).toThrow(
		'canon manifest: entry 0 (a): "appliesTo" has "node": expected each of web, chain at most once',
	);
	expect(() => readCanonSource(acmeDir([a(['chain']), a(['web', 'chain'])]))).toThrow(
		'canon manifest: dest "a" is listed twice for profile chain',
	);
});

test('канон владельца включает все правила, пресет Renovate — с тегом мажора', () => {
	const { rules } = OWNER_SOURCE.settings;
	expect(Object.keys(rules).sort()).toStrictEqual([...RULE_NAMES].sort());
	// Без тега или с #main потребитель получал бы неопубликованный канон, а пресет — тот же источник,
	// что и rollout (плавающий v1).
	expect(rules['renovate-preset']?.preset).toMatch(/#v\d+$/);
});

// Тексты правил живут в двух местах — в settings.json и в литерале тестов; без этого теста тесты на
// testCanon прошли бы на тексте, которого у канона владельца уже нет. Тест снимает фаза 4 вместе с литералом.
test('TEST_SETTINGS — зеркало канона владельца: правила, группы, устаревшие группы', () => {
	const mirror = (s: typeof TEST_SETTINGS) => ({
		rules: s.rules,
		groups: s.groups,
		deprecatedGroups: s.deprecatedGroups,
	});
	expect(mirror(TEST_SETTINGS)).toStrictEqual(mirror(OWNER_SOURCE.settings));
});
