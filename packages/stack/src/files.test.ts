import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

import type { StackConfig } from './config.ts';
import { planFiles } from './files.ts';

function canonFixture(): string {
	const dir = mkdtempSync(join(tmpdir(), 'stack-canon-'));
	mkdirSync(join(dir, 'files'), { recursive: true });
	writeFileSync(join(dir, 'files', 'editorconfig'), 'root = true\n');
	writeFileSync(join(dir, 'files', 'gitleaks-local.toml'), '[extend]\n');
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
	return dir;
}

const cfg = (over: Partial<StackConfig> = {}): StackConfig => ({
	profile: 'node',
	with: [],
	exceptions: [],
	...over,
});

// Применить план — то, что делает `stack sync`; возвращает план, чтобы пинить его строки fix.
function sync(repo: string, c: StackConfig, canon: string) {
	const plan = planFiles(repo, c, canon);
	for (const d of plan) d.apply();
	return plan;
}

test('verbatim-файл кладётся и перезаписывается', () => {
	const canon = canonFixture();
	const repo = mkdtempSync(join(tmpdir(), 'stack-repo-'));
	const first = sync(repo, cfg(), canon);
	expect(first.map((d) => [d.code, d.fix])).toContainEqual([
		'file-missing',
		'updated .editorconfig',
	]);
	expect(readFileSync(join(repo, '.editorconfig'), 'utf8')).toBe('root = true\n');
	writeFileSync(join(repo, '.editorconfig'), 'сломали\n');
	const second = sync(repo, cfg(), canon);
	expect(second.map((d) => [d.code, d.fix])).toEqual([['file-drift', 'updated .editorconfig']]);
	expect(readFileSync(join(repo, '.editorconfig'), 'utf8')).toBe('root = true\n');
});

test('create-if-absent засевается один раз и больше не трогается', () => {
	const canon = canonFixture();
	const repo = mkdtempSync(join(tmpdir(), 'stack-repo-'));
	const first = sync(repo, cfg(), canon);
	expect(first.map((d) => [d.code, d.fix])).toContainEqual([
		'file-missing',
		'seeded .gitleaks.toml',
	]);
	writeFileSync(join(repo, '.gitleaks.toml'), '[extend]\nlocal = 1\n');
	expect(sync(repo, cfg(), canon)).toEqual([]);
	expect(readFileSync(join(repo, '.gitleaks.toml'), 'utf8')).toContain('local = 1');
});

test('файл чужого профиля не приезжает', () => {
	const canon = canonFixture();
	const repo = mkdtempSync(join(tmpdir(), 'stack-repo-'));
	sync(repo, cfg(), canon);
	expect(Bun.file(join(repo, '.prototools')).size).toBe(0);
});

test('файл группы приезжает только при with', () => {
	const canon = canonFixture();
	const a = mkdtempSync(join(tmpdir(), 'stack-repo-'));
	sync(a, cfg(), canon);
	expect(Bun.file(join(a, '.moon/tasks/stack.yml')).size).toBe(0);
	const b = mkdtempSync(join(tmpdir(), 'stack-repo-'));
	sync(b, cfg({ with: ['moon-tasks'] }), canon);
	expect(readFileSync(join(b, '.moon/tasks/stack.yml'), 'utf8')).toBe('tasks: {}\n');
});

test('sync идемпотентен: после применения план пуст', () => {
	const canon = canonFixture();
	const repo = mkdtempSync(join(tmpdir(), 'stack-repo-'));
	sync(repo, cfg(), canon);
	expect(planFiles(repo, cfg(), canon)).toEqual([]);
});

test('план находит отсутствие и расхождение', () => {
	const canon = canonFixture();
	const repo = mkdtempSync(join(tmpdir(), 'stack-repo-'));
	expect(planFiles(repo, cfg(), canon).map((f) => f.code)).toContain('file-missing');
	sync(repo, cfg(), canon);
	writeFileSync(join(repo, '.editorconfig'), 'сломали\n');
	expect(planFiles(repo, cfg(), canon).map((f) => [f.code, f.target, f.message])).toEqual([
		['file-drift', '.editorconfig', '.editorconfig differs from canon'],
	]);
});

test('находка о файле несёт адрес для исключения: file = dest', () => {
	const canon = canonFixture();
	const repo = mkdtempSync(join(tmpdir(), 'stack-repo-'));
	sync(repo, cfg(), canon);
	writeFileSync(join(repo, '.editorconfig'), 'свой\n');
	rmSync(join(repo, '.gitleaks.toml'));
	const found = planFiles(repo, cfg(), canon);
	expect(found.map((f) => [f.code, f.address])).toEqual([
		['file-drift', { file: '.editorconfig' }],
		['file-missing', { file: '.gitleaks.toml' }],
	]);
});
