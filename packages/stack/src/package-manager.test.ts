import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

import type { Canon } from './canon.ts';
import { planPackageManager } from './package-manager.ts';

const canon: Canon = { files: [], catalogs: {}, nodePin: '26.8.1', pnpmPin: '11.15.0' };

function repoWith(packageJson: string): string {
	const dir = mkdtempSync(join(tmpdir(), 'stack-pm-'));
	writeFileSync(join(dir, 'package.json'), packageJson);
	return dir;
}

function packageManagerOf(dir: string): unknown {
	return (
		JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { packageManager?: unknown }
	).packageManager;
}

test('packageManager на другой версии pnpm — дрейф, apply ставит пин канона', () => {
	const dir = repoWith('{ "name": "r", "packageManager": "pnpm@11.1.2" }\n');
	const plan = planPackageManager(dir, canon);
	expect(plan.map((d) => [d.code, d.target, d.address])).toEqual([
		['package-manager', 'package.json:packageManager', { file: '.prototools' }],
	]);
	plan[0]?.apply();
	expect(packageManagerOf(dir)).toBe('pnpm@11.15.0');
	expect(planPackageManager(dir, canon)).toEqual([]);
});

test('суффикс +sha512 у той же версии — не дрейф', () => {
	const dir = repoWith('{ "packageManager": "pnpm@11.15.0+sha512.abc123" }');
	expect(planPackageManager(dir, canon)).toEqual([]);
});

test('поля нет, другой менеджер пакетов, нет package.json — правило молчит', () => {
	expect(planPackageManager(repoWith('{ "name": "r" }'), canon)).toEqual([]);
	expect(planPackageManager(repoWith('{ "packageManager": "bun@1.4.2" }'), canon)).toEqual([]);
	expect(planPackageManager(mkdtempSync(join(tmpdir(), 'stack-pm-')), canon)).toEqual([]);
});

test('нечитаемый package.json — правило молчит (unreadable-file отдаёт checkEnginesNode)', () => {
	expect(planPackageManager(repoWith('{ nope'), canon)).toEqual([]);
});

test('apply меняет одну строку: 4-пробельные отступы и порядок ключей сохранены', () => {
	const before =
		'{\n    "name": "r",\n    "packageManager": "pnpm@11.1.2",\n    "private": true\n}\n';
	const dir = repoWith(before);
	planPackageManager(dir, canon)[0]?.apply();
	expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(
		before.replace('pnpm@11.1.2', 'pnpm@11.15.0'),
	);
});
