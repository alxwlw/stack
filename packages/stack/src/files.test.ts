import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

import type { StackConfig } from './config.ts';
import { checkFiles, syncFiles } from './files.ts';

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

test('verbatim-файл кладётся и перезаписывается', () => {
	const canon = canonFixture();
	const repo = mkdtempSync(join(tmpdir(), 'stack-repo-'));
	const first = syncFiles(repo, cfg(), canon);
	expect(first.find((c) => c.dest === '.editorconfig')?.action).toBe('written');
	expect(readFileSync(join(repo, '.editorconfig'), 'utf8')).toBe('root = true\n');
	writeFileSync(join(repo, '.editorconfig'), 'сломали\n');
	const second = syncFiles(repo, cfg(), canon);
	expect(second.find((c) => c.dest === '.editorconfig')?.action).toBe('written');
	expect(readFileSync(join(repo, '.editorconfig'), 'utf8')).toBe('root = true\n');
});

test('create-if-absent засевается один раз и больше не трогается', () => {
	const canon = canonFixture();
	const repo = mkdtempSync(join(tmpdir(), 'stack-repo-'));
	const first = syncFiles(repo, cfg(), canon);
	expect(first.find((c) => c.dest === '.gitleaks.toml')?.action).toBe('seeded');
	writeFileSync(join(repo, '.gitleaks.toml'), '[extend]\nlocal = 1\n');
	const changes = syncFiles(repo, cfg(), canon);
	expect(readFileSync(join(repo, '.gitleaks.toml'), 'utf8')).toContain('local = 1');
	expect(changes.find((c) => c.dest === '.gitleaks.toml')?.action).toBe('unchanged');
});

test('файл чужого профиля не приезжает', () => {
	const canon = canonFixture();
	const repo = mkdtempSync(join(tmpdir(), 'stack-repo-'));
	syncFiles(repo, cfg(), canon);
	expect(Bun.file(join(repo, '.prototools')).size).toBe(0);
});

test('файл группы приезжает только при with', () => {
	const canon = canonFixture();
	const a = mkdtempSync(join(tmpdir(), 'stack-repo-'));
	syncFiles(a, cfg(), canon);
	expect(Bun.file(join(a, '.moon/tasks/stack.yml')).size).toBe(0);
	const b = mkdtempSync(join(tmpdir(), 'stack-repo-'));
	syncFiles(b, cfg({ with: ['moon-tasks'] }), canon);
	expect(readFileSync(join(b, '.moon/tasks/stack.yml'), 'utf8')).toBe('tasks: {}\n');
});

test('sync идемпотентен: второй прогон ничего не пишет', () => {
	const canon = canonFixture();
	const repo = mkdtempSync(join(tmpdir(), 'stack-repo-'));
	syncFiles(repo, cfg(), canon);
	expect(syncFiles(repo, cfg(), canon).every((c) => c.action === 'unchanged')).toBe(true);
});

test('check находит расхождение и отсутствие', () => {
	const canon = canonFixture();
	const repo = mkdtempSync(join(tmpdir(), 'stack-repo-'));
	expect(checkFiles(repo, cfg(), canon).map((f) => f.code)).toContain('file-missing');
	syncFiles(repo, cfg(), canon);
	expect(checkFiles(repo, cfg(), canon)).toEqual([]);
	writeFileSync(join(repo, '.editorconfig'), 'сломали\n');
	const found = checkFiles(repo, cfg(), canon);
	expect(found).toHaveLength(1);
	expect(found[0]?.code).toBe('file-drift');
	expect(found[0]?.target).toBe('.editorconfig');
});

test('исключение гасит находку, но остаётся видимым', () => {
	const canon = canonFixture();
	const repo = mkdtempSync(join(tmpdir(), 'stack-repo-'));
	syncFiles(repo, cfg(), canon);
	writeFileSync(join(repo, '.editorconfig'), 'свой\n');
	const c = cfg({ exceptions: [{ file: '.editorconfig', reason: 'исторический отступ' }] });
	const found = checkFiles(repo, c, canon);
	expect(found).toHaveLength(1);
	expect(found[0]?.suppressedBy?.reason).toBe('исторический отступ');
});

test('исключение гасит file-missing, но остаётся видимым', () => {
	const canon = canonFixture();
	const repo = mkdtempSync(join(tmpdir(), 'stack-repo-'));
	const c = cfg({ exceptions: [{ file: '.editorconfig', reason: 'временно без файла' }] });
	const found = checkFiles(repo, c, canon);
	const missing = found.find((f) => f.target === '.editorconfig');
	expect(missing?.code).toBe('file-missing');
	expect(missing?.suppressedBy?.reason).toBe('временно без файла');
	const other = found.find((f) => f.target === '.gitleaks.toml');
	expect(other?.code).toBe('file-missing');
	expect(other?.suppressedBy).toBeUndefined();
});
