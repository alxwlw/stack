import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'bun:test';
import { parse as parseJsonc } from 'jsonc-parser';

import { canonDir, filesFor, loadCanon, loadCatalogs, loadManifest } from './canon.ts';
import { PROFILES, type StackConfig } from './config.ts';
import { RENOVATE_CONFIGS } from './deps.ts';

// Ruling 33: filesFor() только фильтрует список канон-файлов — оно не замечает, если два
// файла манифеста целят в один и тот же dest внутри одного профиля. planFiles() в этом случае
// планирует оба, apply() пишет оба (побеждает последний в списке), и следующий план вечно видит
// дрейф по проигравшей записи. Гвард включает все with-группы разом, чтобы поймать дубликат,
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
	writeFileSync(join(dir, 'files', 'prototools'), 'node = "26.8.1"\npnpm = "11.15.0"\n');
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
		{ dest: '.prototools', content: 'node = "26.8.1"\npnpm = "11.15.0"\n' },
	]);
});

test('loadCanon: файл группы приезжает только при with', () => {
	const dir = canonFixture();
	const dests = (c: StackConfig) => loadCanon(c, dir).files.map((f) => f.dest);
	expect(dests(cfg())).not.toContain('.moon/tasks/stack.yml');
	expect(dests(cfg({ with: ['moon-tasks'] }))).toContain('.moon/tasks/stack.yml');
});

test('loadCanon: каталоги — dev всегда, группа только при with, неизвестная группа игнорируется', () => {
	const dir = canonFixture();
	const dev = { oxlint: '1.83.0', typescript: '7.0.2' };
	expect(loadCanon(cfg(), dir).catalogs).toEqual({ dev });
	const withGroups = loadCanon(cfg({ with: ['libs', 'nope'] }), dir).catalogs;
	// toEqual не различает { nope: undefined } и отсутствие ключа — ключи проверяем явно.
	expect(Object.keys(withGroups)).toEqual(['dev', 'libs']);
	expect(withGroups).toEqual({ dev, libs: { react: '19.2.7' } });
});

test('loadCanon: пин node берётся из канон-.prototools своего профиля', () => {
	const dir = canonFixture();
	expect(loadCanon(cfg(), dir).nodePin).toBe('26.8.1');
	expect(loadCanon(cfg({ profile: 'contracts' }), dir).nodePin).toBe('0.0.0-fixture');
});

test('loadCanon: пин pnpm берётся из канон-.prototools своего профиля', () => {
	const dir = canonFixture();
	expect(loadCanon(cfg(), dir).pnpmPin).toBe('11.15.0');
	expect(loadCanon(cfg({ profile: 'contracts' }), dir).pnpmPin).toBe('0.0.0-fixture');
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

test('канон markdownlint: игноры планов и спек superpowers на месте', () => {
	const cfg = parseJsonc(
		readFileSync(join(canonDir(), 'files', 'markdownlint-cli2.jsonc'), 'utf8'),
	) as { ignores?: string[] };
	expect(cfg.ignores).toEqual(
		expect.arrayContaining(['docs/superpowers/plans/**', 'docs/superpowers/specs/**']),
	);
});

test('канон markdownlint: опция gitignore указывает на .markdownlintignore', () => {
	const cfg = parseJsonc(
		readFileSync(join(canonDir(), 'files', 'markdownlint-cli2.jsonc'), 'utf8'),
	) as { gitignore?: string };
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
	const seed = readFileSync(join(canonDir(), 'files', 'renovate.template.json5'), 'utf8');
	expect(seed).toContain("'github>alxwlw/stack//renovate/canon.json5#v1'");
	expect(seed).toContain("'config:recommended'");
});

test('loadCanon: bot — renovate с группой, dependabot без неё', () => {
	expect(loadCanon({ profile: 'node', with: ['renovate'], exceptions: [] }).bot).toBe('renovate');
	expect(loadCanon({ profile: 'node', with: [], exceptions: [] }).bot).toBe('dependabot');
});

// `init` пишет `$schema` в .stack.jsonc, редактор валидирует против него: enum групп в schema.json
// должен покрывать все group из манифеста, каталоги кроме dev и устаревшие группы.
test('schema.json: enum групп with = группы манифеста ∪ каталоги (кроме dev) ∪ устаревшие', () => {
	const manifest = loadManifest();
	const manifestGroups = new Set<string>();
	for (const file of manifest) {
		if (file.group) manifestGroups.add(file.group);
	}
	const catalogs = loadCatalogs();
	const catalogGroups = Object.keys(catalogs).filter((g) => g !== 'dev');
	const deprecatedGroups = ['renovate']; // принимается ради старых .stack.jsonc, ничего не делает
	const expectedGroups = Array.from(
		new Set([...manifestGroups, ...catalogGroups, ...deprecatedGroups]),
	).sort();

	const schema = JSON.parse(readFileSync(join(canonDir(), '..', 'schema.json'), 'utf8')) as {
		properties?: { with?: { items?: { enum?: string[] } } };
	};
	const schemaEnum = schema.properties?.with?.items?.enum;
	expect(schemaEnum).toBeDefined();
	expect((schemaEnum ?? []).sort()).toEqual(expectedGroups);
});
