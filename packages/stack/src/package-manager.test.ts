import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

import { syncRepo } from './check.ts';
import { planPackageManager } from './package-manager.ts';
import { testCanon } from './testkit.ts';

// Пин pnpm у testCanon (10.99.0) не равен реальному пину канона: иначе зашитая в package-manager.ts
// константа осталась бы незамеченной. Ожидания ниже зависят от него — задаём явно.
const canon = testCanon({ pins: { node: '26.8.1', pnpm: '10.99.0' } });

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

test('packageManager на другой версии pnpm — дрейф, sync ставит пин канона', () => {
	const dir = repoWith('{ "name": "r", "packageManager": "pnpm@11.1.2" }\n');
	const plan = planPackageManager(dir, canon);
	expect(
		plan.map((d) => [
			d.code,
			d.target,
			// Предметных полей нет: адрес .prototools даёт таблица в exceptions.ts.
			['file', 'catalog', 'name'].filter((k) => k in d),
		]),
	).toEqual([['package-manager', 'package.json:packageManager', []]]);
	expect(syncRepo(dir, canon, []).applied.map((d) => [d.code, d.fix])).toEqual([
		['package-manager', 'package.json packageManager: pnpm@11.1.2 → pnpm@10.99.0'],
	]);
	expect(packageManagerOf(dir)).toBe('pnpm@10.99.0');
	expect(planPackageManager(dir, canon)).toEqual([]);
});

test('суффикс +sha512 у той же версии — не дрейф', () => {
	const dir = repoWith('{ "packageManager": "pnpm@10.99.0+sha512.abc123" }');
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

test('sync меняет одну строку: 4-пробельные отступы и порядок ключей сохранены', () => {
	const before =
		'{\n    "name": "r",\n    "packageManager": "pnpm@11.1.2",\n    "private": true\n}\n';
	const dir = repoWith(before);
	syncRepo(dir, canon, []);
	expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(
		before.replace('pnpm@11.1.2', 'pnpm@10.99.0'),
	);
});
