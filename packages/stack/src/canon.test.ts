import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

import { filesFor, loadCanon, loadManifest } from './canon.ts';
import { PROFILES, type StackConfig } from './config.ts';

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
	writeFileSync(join(dir, 'files', 'contracts.prototools'), 'node = "0.0.0-fixture"\n');
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
