import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'bun:test';
import { parse as parseYaml } from 'yaml';

import { canonGroups, loadCanon } from './canon.ts';
import { planCatalogs } from './catalogs.ts';
import { checkRepo, syncRepo, type SyncResult } from './check.ts';
import { readStackConfig, type StackConfig } from './config.ts';

const FIXTURES = join(import.meta.dir, '..', '..', '..', 'fixtures');

function copyFixture(profile: string): string {
	const dir = mkdtempSync(join(tmpdir(), `stack-${profile}-`));
	cpSync(join(FIXTURES, profile), dir, { recursive: true });
	return dir;
}

// Применить план с учётом исключений — то, что делает `stack sync`.
function sync(dir: string, cfg: StackConfig): SyncResult {
	return syncRepo(dir, loadCanon(cfg), cfg.exceptions);
}

// Фикстура в `fixtures/` — только семя; всё остальное приносит sync, как у потребителя.
function syncedFixture(profile: 'node' | 'contracts' | 'infra'): { dir: string; cfg: StackConfig } {
	const dir = copyFixture(profile);
	const cfg = readStackConfig(dir);
	sync(dir, cfg);
	return { dir, cfg };
}

test('fixtures/ хранит только семя: ни одного файла, совпадающего с канон-файлом своего профиля', () => {
	for (const profile of ['node', 'contracts', 'infra'] as const) {
		const dir = join(FIXTURES, profile);
		const cfg = readStackConfig(dir);
		const copies = loadCanon(cfg)
			.files.filter(
				(f) =>
					existsSync(join(dir, f.dest)) && readFileSync(join(dir, f.dest), 'utf8') === f.content,
			)
			.map((f) => `${profile}/${f.dest}`);
		expect(copies).toEqual([]);
		// Каталоги приносит sync: в семени их нет.
		const ws = join(dir, 'pnpm-workspace.yaml');
		if (existsSync(ws)) {
			expect(
				(parseYaml(readFileSync(ws, 'utf8')) as { catalogs?: unknown }).catalogs,
			).toBeUndefined();
		}
	}
});

test('фикстуры вместе включают каждую не устаревшую группу канона', () => {
	const g = canonGroups();
	const used = new Set(
		['node', 'contracts', 'infra'].flatMap((p) => readStackConfig(join(FIXTURES, p)).with),
	);
	expect([...g.files, ...g.catalogs].filter((x) => !used.has(x))).toEqual([]);
});

for (const profile of ['node', 'contracts', 'infra'] as const) {
	test(`${profile}: sync идемпотентен, после него check зелёный`, () => {
		const { dir, cfg } = syncedFixture(profile);
		// Не planRepo: у node живое исключение держит запись каталога, и план после sync не пуст.
		expect(sync(dir, cfg).applied).toEqual([]);
		// Правила deps.ts в план не входят: для них check зелёный по факту фикстуры, не по построению.
		expect(checkRepo(dir, loadCanon(cfg), cfg.exceptions).filter((f) => !f.suppressedBy)).toEqual(
			[],
		);
	});
}

test('check краснеет на каждой категории нарушения', () => {
	const { dir, cfg } = syncedFixture('node');

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

	writeFileSync(join(dir, 'package.json'), '{ "name": "f", "packageManager": "pnpm@11.1.2" }');
	expect(checkRepo(dir, loadCanon(cfg), cfg.exceptions).map((f) => f.code)).toContain(
		'package-manager',
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
	const { dir, cfg } = syncedFixture('node');
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

test('свой .markdownlintignore с другим содержимым — не находка (create-if-absent)', () => {
	const { dir, cfg } = syncedFixture('node');
	writeFileSync(join(dir, '.markdownlintignore'), '# свои игноры репозитория\nvendor\n');
	expect(sync(dir, cfg).applied).toEqual([]);
});

test('node: moon-tasks — свежий репо получает файлы задач, правка файла задач — дрейф, stack.yml — нет', () => {
	const { dir, cfg } = syncedFixture('node');
	rmSync(join(dir, '.moon', 'tasks'), { recursive: true, force: true });
	sync(dir, cfg);
	for (const name of ['typescript', 'oxlint', 'oxfmt', 'bun-test', 'stack']) {
		expect(existsSync(join(dir, '.moon', 'tasks', `${name}.yml`))).toBe(true);
	}
	expect(sync(dir, cfg).applied).toEqual([]);
	// stack.yml — засев: правка потребителя не дрейф.
	writeFileSync(join(dir, '.moon', 'tasks', 'stack.yml'), 'tasks: {}\n');
	expect(sync(dir, cfg).applied).toEqual([]);
	// Файл задач — verbatim: правка — дрейф, который sync вернёт.
	writeFileSync(join(dir, '.moon', 'tasks', 'oxlint.yml'), 'tasks: {}\n');
	expect(sync(dir, cfg).applied.map((d) => [d.code, d.target])).toEqual([
		['file-drift', '.moon/tasks/oxlint.yml'],
	]);
});
