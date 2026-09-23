import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

import type { Canon } from './canon.ts';
import { planFiles } from './files.ts';

const canon: Canon = {
	files: [
		{ dest: '.editorconfig', content: 'root = true\n' },
		{ dest: '.gitleaks.toml', content: '[extend]\n', strategy: 'create-if-absent' },
		{ dest: '.moon/tasks/stack.yml', content: 'tasks: {}\n' },
	],
	catalogs: {},
	nodePin: '26.8.1',
};

// Применить план — то, что делает `stack sync`; возвращает план, чтобы пинить его строки fix.
function sync(repo: string) {
	const plan = planFiles(repo, canon);
	for (const d of plan) d.apply();
	return plan;
}

test('verbatim-файл кладётся (включая вложенный путь) и перезаписывается', () => {
	const repo = mkdtempSync(join(tmpdir(), 'stack-repo-'));
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
	const repo = mkdtempSync(join(tmpdir(), 'stack-repo-'));
	sync(repo);
	expect(readFileSync(join(repo, '.gitleaks.toml'), 'utf8')).toBe('[extend]\n');
	writeFileSync(join(repo, '.gitleaks.toml'), '[extend]\nlocal = 1\n');
	expect(sync(repo)).toEqual([]);
	expect(readFileSync(join(repo, '.gitleaks.toml'), 'utf8')).toContain('local = 1');
});

test('sync идемпотентен: после применения план пуст', () => {
	const repo = mkdtempSync(join(tmpdir(), 'stack-repo-'));
	sync(repo);
	expect(planFiles(repo, canon)).toEqual([]);
});

test('план находит отсутствие и расхождение', () => {
	const repo = mkdtempSync(join(tmpdir(), 'stack-repo-'));
	expect(planFiles(repo, canon).map((f) => f.code)).toContain('file-missing');
	sync(repo);
	writeFileSync(join(repo, '.editorconfig'), 'сломали\n');
	expect(planFiles(repo, canon).map((f) => [f.code, f.target, f.message])).toEqual([
		['file-drift', '.editorconfig', '.editorconfig differs from canon'],
	]);
});

test('находка о файле несёт адрес для исключения: file = dest', () => {
	const repo = mkdtempSync(join(tmpdir(), 'stack-repo-'));
	sync(repo);
	writeFileSync(join(repo, '.editorconfig'), 'свой\n');
	rmSync(join(repo, '.gitleaks.toml'));
	expect(planFiles(repo, canon).map((f) => [f.code, f.address])).toEqual([
		['file-drift', { file: '.editorconfig' }],
		['file-missing', { file: '.gitleaks.toml' }],
	]);
});
