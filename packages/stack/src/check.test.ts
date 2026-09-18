import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

import { checkRepo } from './check.ts';
import type { StackConfig } from './config.ts';

function canonFixture(): string {
	const dir = mkdtempSync(join(tmpdir(), 'stack-canon-'));
	mkdirSync(join(dir, 'files'), { recursive: true });
	writeFileSync(join(dir, 'files', 'editorconfig'), 'root = true\n');
	writeFileSync(
		join(dir, 'manifest.json'),
		JSON.stringify({
			files: [
				{
					src: 'files/editorconfig',
					dest: '.editorconfig',
					appliesTo: ['node', 'contracts', 'infra'],
				},
			],
		}),
	);
	writeFileSync(join(dir, 'catalogs.json'), JSON.stringify({ dev: { oxlint: '1.83.0' } }));
	return dir;
}

test('исключение, которое ни к чему не подошло, — находка stale-exception', () => {
	const repo = mkdtempSync(join(tmpdir(), 'stack-repo-'));
	writeFileSync(join(repo, 'package.json'), '{ "name": "r" }');
	const cfg: StackConfig = {
		profile: 'node',
		with: [],
		exceptions: [{ file: '.нет-такого', reason: 'протухло' }],
	};
	const codes = checkRepo(repo, cfg).map((f) => f.code);
	expect(codes).toContain('stale-exception');
});

test('исключение, подошедшее к находке, не мешает другому остаться протухшим', () => {
	const canon = canonFixture();
	const repo = mkdtempSync(join(tmpdir(), 'stack-repo-'));
	const cfg: StackConfig = {
		profile: 'node',
		with: [],
		exceptions: [
			{ file: '.editorconfig', reason: 'легитимный отступ' },
			{ file: '.нет-такого', reason: 'протухло' },
		],
	};
	const findings = checkRepo(repo, cfg, canon);
	const editorconfig = findings.find((f) => f.target === '.editorconfig');
	expect(editorconfig?.code).toBe('file-missing');
	expect(editorconfig?.suppressedBy?.reason).toBe('легитимный отступ');
	const stale = findings.filter((f) => f.code === 'stale-exception');
	expect(stale).toHaveLength(1);
	expect(stale[0]?.target).toBe('.нет-такого');
});

test('checkRepo агрегирует находки из разных источников: файл и каталог одновременно', () => {
	const canon = canonFixture();
	const repo = mkdtempSync(join(tmpdir(), 'stack-repo-'));
	writeFileSync(join(repo, '.editorconfig'), 'сломали\n');
	writeFileSync(
		join(repo, 'pnpm-workspace.yaml'),
		'packages:\n  - packages/*\n\ncatalogs:\n  dev:\n    oxlint: 1.70.0\n',
	);
	const cfg: StackConfig = { profile: 'node', with: [], exceptions: [] };
	const codes = checkRepo(repo, cfg, canon).map((f) => f.code);
	expect(codes).toContain('file-drift');
	expect(codes).toContain('catalog-drift');
});
