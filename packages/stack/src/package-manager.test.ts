import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

import { check, plan, planRepo, syncRepo } from './check.ts';
import { repoDir, testCanon, testRepo } from './testkit.ts';

// Пин pnpm у testCanon (10.99.0) не равен реальному пину канона: иначе зашитая в package-manager.ts
// константа осталась бы незамеченной. Ожидания ниже зависят от него — задаём явно.
const canon = testCanon({ pins: { node: '26.8.1', pnpm: '10.99.0' } });

// Дрейф packageManager репозитория, у которого package.json — packageJson (null — файла нет).
const drift = (packageJson: string | null) =>
	plan(testRepo(canon, { 'package.json': packageJson }), canon).filter(
		(f) => f.code === 'package-manager',
	);

function packageManagerOf(dir: string): unknown {
	return (
		JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { packageManager?: unknown }
	).packageManager;
}

test('packageManager на другой версии pnpm — дрейф, sync ставит пин канона', () => {
	const json = '{ "name": "r", "packageManager": "pnpm@11.1.2" }\n';
	expect(
		drift(json).map((d) => [
			d.code,
			d.target,
			// Предметных полей нет: адрес .prototools даёт таблица в exceptions.ts.
			['file', 'catalog', 'name'].filter((k) => k in d),
		]),
	).toEqual([['package-manager', 'package.json:packageManager', []]]);
	const dir = repoDir({ 'package.json': json });
	expect(syncRepo(dir, canon, []).applied.map((d) => [d.code, d.fix])).toEqual([
		['package-manager', 'package.json packageManager: pnpm@11.1.2 → pnpm@10.99.0'],
	]);
	expect(packageManagerOf(dir)).toBe('pnpm@10.99.0');
	expect(planRepo(dir, canon)).toEqual([]);
});

test('суффикс +sha512 у той же версии — не дрейф', () => {
	expect(drift('{ "packageManager": "pnpm@10.99.0+sha512.abc123" }')).toEqual([]);
});

test('поля нет, другой менеджер пакетов, нет package.json — правило молчит', () => {
	expect(drift('{ "name": "r" }')).toEqual([]);
	expect(drift('{ "packageManager": "bun@1.4.2" }')).toEqual([]);
	expect(drift(null)).toEqual([]);
});

test('нечитаемый package.json — правило молчит, находка одна: unreadable-file из загрузчика', () => {
	const repo = testRepo(canon, { 'package.json': '{ nope' });
	expect(plan(repo, canon)).toEqual([]);
	expect(check(repo, canon, []).map((f) => [f.code, f.target])).toEqual([
		['unreadable-file', 'package.json'],
	]);
});

test('sync меняет одну строку: 4-пробельные отступы и порядок ключей сохранены', () => {
	const before =
		'{\n    "name": "r",\n    "packageManager": "pnpm@11.1.2",\n    "private": true\n}\n';
	const dir = repoDir({ 'package.json': before });
	syncRepo(dir, canon, []);
	expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(
		before.replace('pnpm@11.1.2', 'pnpm@10.99.0'),
	);
});
