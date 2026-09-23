import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

import { loadCanon } from './canon.ts';
import { planCatalogs } from './catalogs.ts';
import { checkRepo, planRepo } from './check.ts';
import { readStackConfig, type StackConfig } from './config.ts';

const FIXTURES = join(import.meta.dir, '..', '..', '..', 'fixtures');

function copyFixture(profile: string): string {
	const dir = mkdtempSync(join(tmpdir(), `stack-${profile}-`));
	cpSync(join(FIXTURES, profile), dir, { recursive: true });
	return dir;
}

// Применить план — то, что делает `stack sync`.
function sync(dir: string, cfg: StackConfig): void {
	for (const d of planRepo(dir, loadCanon(cfg))) d.apply();
}

for (const profile of ['node', 'contracts', 'infra']) {
	test(`${profile}: sync идемпотентен, после него check зелёный`, () => {
		const dir = copyFixture(profile);
		const cfg = readStackConfig(dir);
		sync(dir, cfg);
		expect(planRepo(dir, loadCanon(cfg))).toEqual([]);
		// Правила deps.ts в план не входят: для них check зелёный по факту фикстуры, не по построению.
		expect(checkRepo(dir, loadCanon(cfg), cfg.exceptions).filter((f) => !f.suppressedBy)).toEqual(
			[],
		);
	});

	test(`${profile}: закоммиченная фикстура уже синхронизирована`, () => {
		const dir = copyFixture(profile);
		const cfg = readStackConfig(dir);
		expect(planRepo(dir, loadCanon(cfg))).toEqual([]);
	});
}

test('check краснеет на каждой категории нарушения', () => {
	const dir = copyFixture('node');
	const cfg = readStackConfig(dir);
	sync(dir, cfg);

	writeFileSync(join(dir, '.editorconfig'), 'сломали\n');
	expect(checkRepo(dir, loadCanon(cfg), cfg.exceptions).map((f) => f.code)).toContain('file-drift');

	const ws = readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8').replace(
		/oxlint: .*/,
		'oxlint: 1.0.0',
	);
	writeFileSync(join(dir, 'pnpm-workspace.yaml'), ws);
	expect(checkRepo(dir, loadCanon(cfg), cfg.exceptions).map((f) => f.code)).toContain(
		'catalog-drift',
	);

	writeFileSync(
		join(dir, 'packages/app/package.json'),
		'{ "name": "app", "devDependencies": { "oxlint": "1.70.0" } }',
	);
	expect(checkRepo(dir, loadCanon(cfg), cfg.exceptions).map((f) => f.code)).toContain(
		'inline-version',
	);

	writeFileSync(join(dir, 'package.json'), '{ "name": "f", "engines": { "node": "^24" } }');
	expect(checkRepo(dir, loadCanon(cfg), cfg.exceptions).map((f) => f.code)).toContain(
		'engines-node',
	);
});

// infra не имеет pnpm-workspace.yaml вовсе: planCatalogs должен вернуть [] потому что каталогов
// синхронизировать некуда — а не потому что профиль infra тихо пропущен внутри функции.
test('infra: без pnpm-workspace.yaml синхронизация каталогов — no-op на самом первом вызове', () => {
	const dir = copyFixture('infra');
	const cfg = readStackConfig(dir);
	expect(existsSync(join(dir, 'pnpm-workspace.yaml'))).toBe(false);
	expect(existsSync(join(dir, 'package.json'))).toBe(false);
	expect(planCatalogs(dir, loadCanon(cfg))).toEqual([]);
});

// Тот же профиль infra, но с pnpm-workspace.yaml — доказывает, что no-op выше вызван
// отсутствием файла, а не строкой "profile === 'infra'" где-то внутри planCatalogs.
test('infra: появился pnpm-workspace.yaml — синхронизация каталогов больше не no-op', () => {
	const dir = copyFixture('infra');
	const cfg = readStackConfig(dir);
	writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
	expect(planCatalogs(dir, loadCanon(cfg)).length).toBeGreaterThan(0);
});

// node несёт живое исключение на inline-version (packages/app/package.json держит "knip" не
// через catalog:) — доказываем, что suppressedBy проставляется и что находка не блокирует выход,
// не полагаясь при этом на checkRepo() ради текста причины (иначе тест пройдёт при любой причине).
test('node: исключение inline-version подавляет находку, а не прячет профиль от check', () => {
	const dir = copyFixture('node');
	const cfg = readStackConfig(dir);
	const findings = checkRepo(dir, loadCanon(cfg), cfg.exceptions);
	const knip = findings.find(
		(f) => f.code === 'inline-version' && f.target === 'packages/app/package.json:knip',
	);
	expect(knip?.suppressedBy?.reason).toBe(
		'плагин ещё не обновлён под knip 6.27, держим 6.20 до апстрим-фикса',
	);
	expect(findings.some((f) => f.code === 'stale-exception')).toBe(false);
	expect(findings.filter((f) => !f.suppressedBy)).toEqual([]);
});
