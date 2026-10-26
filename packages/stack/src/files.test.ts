import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

import { plan, planRepo, syncRepo } from './check.ts';
import { repoDir, testCanon, testRepo } from './testkit.ts';

const canon = testCanon({
	files: [
		{ dest: '.editorconfig', content: 'root = true\n' },
		{ dest: '.gitleaks.toml', content: '[extend]\n', strategy: 'create-if-absent' },
		{ dest: '.moon/tasks/stack.yml', content: 'tasks: {}\n' },
	],
});

// Применить план — то, что делает `stack sync`; возвращает applied из syncRepo, чтобы пинить строки fix.
function sync(repo: string) {
	return syncRepo(repo, canon, []).applied;
}

// Дрейф файлов канона: остальные правила плана на стенде молчат.
const fileDrift = (over: Record<string, string | null>, c = canon) =>
	plan(testRepo(c, over), c).filter((f) => f.code === 'file-drift' || f.code === 'file-missing');

test('verbatim-файл кладётся (включая вложенный путь) и перезаписывается', () => {
	const repo = repoDir({});
	const first = sync(repo);
	expect(first.map((d) => [d.code, d.fix])).toEqual([
		['file-missing', 'updated .editorconfig'],
		['file-missing', 'seeded .gitleaks.toml'],
		['file-missing', 'updated .moon/tasks/stack.yml'],
	]);
	expect(readFileSync(join(repo, '.editorconfig'), 'utf8')).toBe('root = true\n');
	expect(readFileSync(join(repo, '.moon/tasks/stack.yml'), 'utf8')).toBe('tasks: {}\n');
	writeFileSync(join(repo, '.editorconfig'), 'сломали\n');
	const second = sync(repo);
	expect(second.map((d) => [d.code, d.fix])).toEqual([['file-drift', 'updated .editorconfig']]);
	expect(readFileSync(join(repo, '.editorconfig'), 'utf8')).toBe('root = true\n');
});

test('create-if-absent засевается один раз и больше не трогается', () => {
	const repo = repoDir({});
	sync(repo);
	expect(readFileSync(join(repo, '.gitleaks.toml'), 'utf8')).toBe('[extend]\n');
	writeFileSync(join(repo, '.gitleaks.toml'), '[extend]\nlocal = 1\n');
	expect(sync(repo)).toEqual([]);
	expect(readFileSync(join(repo, '.gitleaks.toml'), 'utf8')).toContain('local = 1');
});

test('create-if-absent: чужое содержимое — не расхождение (по значению, без диска)', () => {
	expect(fileDrift({ '.gitleaks.toml': '[extend]\nlocal = 1\n' })).toEqual([]);
});

test('sync идемпотентен: после применения план пуст', () => {
	const repo = repoDir({});
	sync(repo);
	expect(planRepo(repo, canon)).toEqual([]);
});

test('план находит отсутствие и расхождение', () => {
	expect(fileDrift({ '.editorconfig': null }).map((f) => f.code)).toEqual(['file-missing']);
	expect(
		fileDrift({ '.editorconfig': 'сломали\n' }).map((f) => [f.code, f.target, f.message]),
	).toEqual([['file-drift', '.editorconfig', '.editorconfig differs from canon']]);
});

test('находка о файле несёт предмет для исключения: file = dest', () => {
	expect(fileDrift({ '.editorconfig': 'свой\n', '.gitleaks.toml': null })).toMatchObject([
		{ code: 'file-drift', file: '.editorconfig' },
		{ code: 'file-missing', file: '.gitleaks.toml' },
	]);
});

test('пустой репозиторий: по находке file-missing на каждый файл канона, в порядке канона', () => {
	expect(
		fileDrift({ '.editorconfig': null, '.gitleaks.toml': null, '.moon/tasks/stack.yml': null }).map(
			(f) => f.target,
		),
	).toEqual(['.editorconfig', '.gitleaks.toml', '.moon/tasks/stack.yml']);
});

// satisfiedBy: засев конфига, у которого несколько законных имён (Renovate ищет renovate.json,
// .github/renovate.json5 и т. д.), — любой существующий вариант закрывает засев.
const seedWithAlternatives = testCanon({
	files: [
		{
			dest: 'renovate.json5',
			content: '{}\n',
			strategy: 'create-if-absent',
			satisfiedBy: ['renovate.json', '.github/renovate.json5'],
		},
	],
});

test('create-if-absent с satisfiedBy: существующий альтернативный путь закрывает засев', () => {
	expect(
		fileDrift(
			{ 'renovate.json5': null, '.github/renovate.json5': '{ extends: [] }\n' },
			seedWithAlternatives,
		),
	).toEqual([]);
});

test('create-if-absent с satisfiedBy: ничего нет — засевается dest', () => {
	expect(
		fileDrift({ 'renovate.json5': null }, seedWithAlternatives).map((d) => [
			d.code,
			d.target,
			d.fix,
		]),
	).toEqual([['file-missing', 'renovate.json5', 'seeded renovate.json5']]);
	const repo = repoDir({});
	expect(syncRepo(repo, seedWithAlternatives, []).applied.map((d) => d.target)).toEqual([
		'renovate.json5',
	]);
	expect(readFileSync(join(repo, 'renovate.json5'), 'utf8')).toBe('{}\n');
	expect(planRepo(repo, seedWithAlternatives)).toEqual([]);
});

// satisfiedBy — свойство засева: у verbatim-записи канон владеет содержимым, и существующий
// «альтернативный» путь не должен выключать синхронизацию dest.
test('verbatim с satisfiedBy: существующий путь из satisfiedBy не отменяет план dest', () => {
	const verbatimWithAlternatives = testCanon({
		files: [{ dest: 'renovate.json5', content: '{}\n', satisfiedBy: ['renovate.json'] }],
	});
	expect(
		fileDrift({ 'renovate.json5': null, 'renovate.json': '{}\n' }, verbatimWithAlternatives).map(
			(d) => [d.code, d.target, d.fix],
		),
	).toEqual([['file-missing', 'renovate.json5', 'updated renovate.json5']]);
});

test('planRepo читает диск: удалённый засев — file-missing', () => {
	const repo = repoDir({});
	sync(repo);
	rmSync(join(repo, '.gitleaks.toml'));
	expect(planRepo(repo, canon).map((d) => d.target)).toEqual(['.gitleaks.toml']);
});
