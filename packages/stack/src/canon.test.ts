import * as fs from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, spyOn, test } from 'bun:test';
import { parse as parseJsonc } from 'jsonc-parser';
import { parse as parseYaml } from 'yaml';

import {
	canonDir,
	canonFor,
	type CanonSource,
	loadCanon,
	readCanonSource,
	selectEntries,
} from './canon.ts';
import { type Profile, PROFILES, type StackConfig, StackConfigError } from './config.ts';
import { RENOVATE_CONFIGS } from './repo.ts';
import { canonFile, SCHEMA_PATH } from './testkit.ts';

// Не канон-файл: README лежит рядом с пакетом, а не в canon/.
const README_PATH = join(import.meta.dir, '..', '..', '..', 'README.md');

// Ruling 33: выбор записей только фильтрует список канон-файлов — оно не замечает, если два
// файла манифеста целят в один и тот же dest внутри одного профиля. planFiles() в этом случае
// планирует оба, applyChanges пишет файл один раз — с последней записью, и следующий план вечно
// видит дрейф по проигравшей записи. Гвард включает все with-группы разом, чтобы поймать дубликат,
// который проявляется только при определённой комбинации опциональных групп.
test('canon manifest: ни один профиль не получает два файла с одинаковым dest', () => {
	const source = readCanonSource();
	const allGroups = source.groups.files;
	for (const profile of PROFILES) {
		const dests = selectEntries(source, { profile, with: allGroups, exceptions: [] }).map(
			(f) => f.dest,
		);
		const duplicates = dests.filter((dest, i) => dests.indexOf(dest) !== i);
		expect(duplicates).toEqual([]);
	}
});

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
		groups: { files: ['moon-tasks'], catalogs: ['libs'], deprecated: ['renovate'] },
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

// Единственный тест чтения с диска: readCanonSource — граница с файловой системой.
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

test('канон gitleaks: eth-private-key ловится по eth_priv и не обещает лишнего', () => {
	const toml = canonFile('.gitleaks.canon.toml');
	expect(toml.split('\n')[0]).not.toContain('pre-commit');
	expect(toml).toMatch(/keywords = \[[^\]]*'eth_priv'/);
	expect(toml).toContain(String.raw`'''docs/superpowers/(specs|plans|archive)/'''`);
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
	for (const profile of PROFILES) {
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
	for (const profile of PROFILES) {
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
	for (const profile of PROFILES) {
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

// Связка канон-файла workflow с reusable стека проверяется в dogfood.test.ts: там разбирается YAML.
test('канон Renovate: засев конфига подключает пресет стека @v1', () => {
	const seed = canonFile('renovate.json5');
	expect(seed).toContain("'github>alxwlw/stack//renovate/canon.json5#v1'");
	expect(seed).toContain("'config:recommended'");
});

// `init` пишет `$schema` в .stack.jsonc, редактор валидирует против него: enum групп в schema.json
// должен покрывать все group из манифеста, каталоги кроме dev и устаревшие группы.
test('schema.json: enum групп with = группы манифеста ∪ каталоги (кроме dev) ∪ устаревшие', () => {
	const g = readCanonSource().groups;
	const expectedGroups = [...g.files, ...g.catalogs, ...g.deprecated].sort();

	const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as {
		properties?: { with?: { items?: { enum?: string[] } } };
	};
	const schemaEnum = schema.properties?.with?.items?.enum;
	expect(schemaEnum).toBeDefined();
	expect((schemaEnum ?? []).sort()).toEqual(expectedGroups);
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
	const g = readCanonSource().groups;
	expect([...readmeGroupRows().keys()].sort()).toEqual(
		[...g.files, ...g.catalogs, ...g.deprecated].sort(),
	);
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
	for (const profile of PROFILES) {
		const content = canonFile('.moon/tasks/stack.yml', profile);
		const task = (parseYaml(content) as { tasks: Record<string, Record<string, unknown>> }).tasks[
			'stack-check'
		];
		expect([profile, task?.command, task?.inputs]).toEqual([
			profile,
			STACK_CHECK[profile].command,
			STACK_CHECK[profile].inputs,
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

test('canonFor на значении: профиль и with выбирают записи, dev-каталог всегда', () => {
	const source: CanonSource = {
		entries: [
			{ src: 'a', dest: 'always', appliesTo: ['node', 'infra'], content: 'A' },
			{
				src: 'p',
				dest: '.prototools',
				appliesTo: ['node', 'infra'],
				content: 'node = "1"\npnpm = "2"\n',
			},
			{ src: 'g', dest: 'grouped', appliesTo: ['node', 'infra'], group: 'extra', content: 'G' },
			{ src: 'c', dest: 'node-skips', appliesTo: ['contracts'], content: 'C' },
		],
		catalogs: { dev: { x: '1' }, libs: { y: '2' } },
		groups: { files: ['extra'], catalogs: ['libs'], deprecated: [] },
	};
	const plain = canonFor(source, cfg({ profile: 'node', with: [] }));
	expect(plain.files.map((f) => f.dest)).toEqual(['always', '.prototools']);
	expect(plain.catalogs).toEqual({ dev: { x: '1' } });
	const full = canonFor(source, cfg({ profile: 'node', with: ['extra', 'libs'] }));
	expect(full.files.map((f) => f.dest)).toEqual(['always', '.prototools', 'grouped']);
	expect(full.files[0]?.content).toBe('A');
	expect(full.catalogs).toEqual({ dev: { x: '1' }, libs: { y: '2' } });
});
