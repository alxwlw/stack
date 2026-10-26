import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'bun:test';
import { parse as parseJsonc } from 'jsonc-parser';

import { canonGroups, filesFor, loadCanon, loadManifest, parsePins } from './canon.ts';
import { PROFILES, type StackConfig, StackConfigError } from './config.ts';
import { RENOVATE_CONFIGS } from './repo.ts';
import { canonFile, SCHEMA_PATH } from './testkit.ts';

// Не канон-файл: README лежит рядом с пакетом, а не в canon/.
const README_PATH = join(import.meta.dir, '..', '..', '..', 'README.md');

// Ruling 33: filesFor() только фильтрует список канон-файлов — оно не замечает, если два
// файла манифеста целят в один и тот же dest внутри одного профиля. planFiles() в этом случае
// планирует оба, applyChanges пишет файл один раз — с последней записью, и следующий план вечно
// видит дрейф по проигравшей записи. Гвард включает все with-группы разом, чтобы поймать дубликат,
// который проявляется только при определённой комбинации опциональных групп.
test('canon manifest: ни один профиль не получает два файла с одинаковым dest', () => {
	const manifest = loadManifest();
	const allGroups = [...new Set(manifest.map((f) => f.group).filter((g) => g != null))];
	for (const profile of PROFILES) {
		const dests = filesFor({ profile, with: allGroups, exceptions: [] }).map((f) => f.dest);
		const duplicates = dests.filter((dest, i) => dests.indexOf(dest) !== i);
		expect(duplicates).toEqual([]);
	}
});

// Единственная канон-фикстура на диске: loadCanon — граница с файловой системой, остальные
// тесты получают Canon значением.
function canonFixture(): string {
	const dir = mkdtempSync(join(tmpdir(), 'stack-canon-'));
	mkdirSync(join(dir, 'files'), { recursive: true });
	writeFileSync(join(dir, 'files', 'editorconfig'), 'root = true\n');
	writeFileSync(join(dir, 'files', 'gitleaks-local.toml'), '[extend]\n');
	writeFileSync(
		join(dir, 'files', 'prototools'),
		'node = "26.8.1"\npnpm = "11.15.0"\n\n[plugins]\nx = "file://x.toml"\n',
	);
	writeFileSync(
		join(dir, 'files', 'contracts.prototools'),
		'node = "0.0.0-fixture"\npnpm = "0.0.0-fixture"\n',
	);
	writeFileSync(join(dir, 'files', 'moon-task.yml'), 'tasks: {}\n');
	writeFileSync(
		join(dir, 'manifest.json'),
		JSON.stringify({
			files: [
				{
					src: 'files/editorconfig',
					dest: '.editorconfig',
					appliesTo: ['node', 'contracts', 'infra'],
				},
				{
					src: 'files/gitleaks-local.toml',
					dest: '.gitleaks.toml',
					appliesTo: ['node', 'contracts', 'infra'],
					strategy: 'create-if-absent',
				},
				{ src: 'files/prototools', dest: '.prototools', appliesTo: ['node', 'infra'] },
				{ src: 'files/contracts.prototools', dest: '.prototools', appliesTo: ['contracts'] },
				{
					src: 'files/moon-task.yml',
					dest: '.moon/tasks/stack.yml',
					appliesTo: ['node'],
					group: 'moon-tasks',
				},
			],
		}),
	);
	writeFileSync(
		join(dir, 'catalogs.json'),
		JSON.stringify({ dev: { oxlint: '1.83.0', typescript: '7.0.2' }, libs: { react: '19.2.7' } }),
	);
	return dir;
}

const cfg = (over: Partial<StackConfig> = {}): StackConfig => ({
	profile: 'node',
	with: [],
	exceptions: [],
	...over,
});

test('loadCanon: файлы профиля с содержимым и стратегией; чужой профиль и чужая группа не приезжают', () => {
	expect(loadCanon(cfg(), canonFixture()).files).toEqual([
		{ dest: '.editorconfig', content: 'root = true\n' },
		{ dest: '.gitleaks.toml', content: '[extend]\n', strategy: 'create-if-absent' },
		{
			dest: '.prototools',
			content: 'node = "26.8.1"\npnpm = "11.15.0"\n\n[plugins]\nx = "file://x.toml"\n',
		},
	]);
});

test('loadCanon: файл группы приезжает только при with', () => {
	const dir = canonFixture();
	const dests = (c: StackConfig) => loadCanon(c, dir).files.map((f) => f.dest);
	expect(dests(cfg())).not.toContain('.moon/tasks/stack.yml');
	expect(dests(cfg({ with: ['moon-tasks'] }))).toContain('.moon/tasks/stack.yml');
});

test('loadCanon: каталоги — dev всегда, группа только при with', () => {
	const dir = canonFixture();
	const dev = { oxlint: '1.83.0', typescript: '7.0.2' };
	expect(loadCanon(cfg(), dir).catalogs).toEqual({ dev });
	const withGroups = loadCanon(cfg({ with: ['libs'] }), dir).catalogs;
	expect(Object.keys(withGroups)).toEqual(['dev', 'libs']);
	expect(withGroups).toEqual({ dev, libs: { react: '19.2.7' } });
});

test('loadCanon: неизвестная группа в with — StackConfigError с её именем и списком допустимых', () => {
	const dir = canonFixture();
	expect(() => loadCanon(cfg({ with: ['moon-task'] }), dir)).toThrow(StackConfigError);
	expect(() => loadCanon(cfg({ with: ['moon-task'] }), dir)).toThrow(
		'unknown group "moon-task" in "with", expected one of: libs, moon-tasks, renovate',
	);
	// Опечатка не в первой позиции тоже ловится.
	expect(() => loadCanon(cfg({ with: ['libs', 'moon-task'] }), dir)).toThrow(
		'unknown group "moon-task" in "with", expected one of: libs, moon-tasks, renovate',
	);
	// Устаревшая группа принимается и ничего не включает.
	expect(loadCanon(cfg({ with: ['renovate'] }), dir).files).toEqual(loadCanon(cfg(), dir).files);
});

test('loadCanon: пины — строковые значения верхнего уровня канон-.prototools своего профиля', () => {
	const dir = canonFixture();
	expect(loadCanon(cfg(), dir).pins).toEqual({ node: '26.8.1', pnpm: '11.15.0' });
	expect(loadCanon(cfg({ profile: 'contracts' }), dir).pins).toEqual({
		node: '0.0.0-fixture',
		pnpm: '0.0.0-fixture',
	});
});

test('loadCanon: прочие строковые пины верхнего уровня канон-.prototools попадают в pins', () => {
	const dir = canonFixture();
	writeFileSync(
		join(dir, 'files', 'prototools'),
		'node = "26.8.1"\npnpm = "11.15.0"\nbun = "1.0.0"\n',
	);
	expect(loadCanon(cfg(), dir).pins).toEqual({ node: '26.8.1', pnpm: '11.15.0', bun: '1.0.0' });
});

test('parsePins: таблицы и нестроковые значения — не пины', () => {
	expect(parsePins('node = "1.2.3"\nretries = 3\n\n[plugins]\nx = "file://x.toml"\n')).toEqual({
		node: '1.2.3',
	});
});

test('loadCanon: в каноне .prototools нет пина pnpm — ошибка', () => {
	const dir = canonFixture();
	writeFileSync(join(dir, 'files', 'prototools'), 'node = "26.8.1"\n');
	expect(() => loadCanon(cfg(), dir)).toThrow('canon .prototools has no pnpm pin');
});

test('loadCanon: в манифесте нет .prototools для профиля — ошибка', () => {
	const dir = mkdtempSync(join(tmpdir(), 'stack-canon-'));
	writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ files: [] }));
	writeFileSync(join(dir, 'catalogs.json'), '{}');
	expect(() => loadCanon(cfg(), dir)).toThrow(
		'canon manifest has no .prototools entry for profile node',
	);
});

test('loadCanon: в каноне .prototools нет пина node — ошибка', () => {
	const dir = mkdtempSync(join(tmpdir(), 'stack-canon-'));
	mkdirSync(join(dir, 'files'), { recursive: true });
	writeFileSync(join(dir, 'files', 'prototools'), 'pnpm = "11.15.0"\n');
	writeFileSync(
		join(dir, 'manifest.json'),
		JSON.stringify({
			files: [{ src: 'files/prototools', dest: '.prototools', appliesTo: ['node'] }],
		}),
	);
	writeFileSync(join(dir, 'catalogs.json'), '{}');
	expect(() => loadCanon(cfg(), dir)).toThrow('canon .prototools has no node pin');
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
	const manifest = loadManifest();
	const allGroups = [...new Set(manifest.map((f) => f.group).filter((g) => g != null))];
	for (const profile of PROFILES) {
		const entry = filesFor({ profile, with: allGroups, exceptions: [] }).find(
			(f) => f.dest === '.markdownlintignore',
		);
		expect(entry?.strategy).toBe('create-if-absent');
	}
});

// Renovate — единственный бот канона: dependabot.yml не засевается никому, а группа renovate
// осталась допустимым значением для старых .stack.jsonc и ничего не меняет.
test('filesFor: dependabot.yml не засевается; with renovate не меняет набор файлов', () => {
	for (const profile of PROFILES) {
		const plain = filesFor({ profile, with: [], exceptions: [] }).map((f) => f.dest);
		expect(plain).not.toContain('.github/dependabot.yml');
		const renovate = filesFor({ profile, with: ['renovate'], exceptions: [] }).map((f) => f.dest);
		expect(renovate).toEqual(plain);
	}
});

test('канон Renovate: workflow и засев конфига — в каждом профиле', () => {
	for (const profile of PROFILES) {
		const files = filesFor({ profile, with: [], exceptions: [] });
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
	const g = canonGroups();
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
	const g = canonGroups();
	expect([...readmeGroupRows().keys()].sort()).toEqual(
		[...g.files, ...g.catalogs, ...g.deprecated].sort(),
	);
});

// «Seeds» в README обещает засев: файл принадлежит репозиторию, sync его не перезаписывает.
test('README: группа «Seeds …» засевает все свои файлы, группа «Syncs …» синхронизирует хотя бы один дословно', () => {
	const manifest = loadManifest();
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
	const group = loadManifest().filter((f) => f.group === 'moon-tasks');
	for (const name of MOON_TASKS) {
		const entry = group.find((f) => f.dest === `.moon/tasks/${name}.yml`);
		expect(entry?.strategy ?? 'verbatim').toBe('verbatim');
		expect(entry?.appliesTo).toEqual(['node', 'contracts']);
	}
	expect(group.find((f) => f.dest === '.moon/tasks/stack.yml')?.strategy).toBe('create-if-absent');
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
