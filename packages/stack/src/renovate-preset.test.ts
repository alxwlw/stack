import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'bun:test';
import JSON5 from 'json5';

import { parsePins, readCanonSource } from './canon.ts';

// Пресет Renovate живёт в корне репо, а не в npm-пакете: потребитель подключает его как
// github>alxwlw/stack//renovate/canon.json5#v1, Renovate читает файл с GitHub по тегу.
const ROOT = join(import.meta.dir, '..', '..', '..');

interface Rule {
	description?: string;
	matchPackageNames?: string[];
	matchDepNames?: string[];
	matchDepTypes?: string[];
	matchManagers?: string[];
	matchDatasources?: string[];
	minimumReleaseAge?: string;
	enabled?: boolean;
}

const preset = JSON5.parse(readFileSync(join(ROOT, 'renovate', 'canon.json5'), 'utf8')) as {
	packageRules?: Rule[];
	extends?: unknown;
	ignorePaths?: unknown;
	statusCheckNames?: unknown;
};
const rules = preset.packageRules ?? [];
const matchKeys = (r: Rule): string[] => Object.keys(r).filter((k) => k.startsWith('match'));
// Renovate соединяет matcher'ы одного правила через AND. Прежние правила покрывают своё целиком,
// только пока в них один match*: второй сузил бы правило до пересечения и молча снял покрытие.
const disabled = (pred: (r: Rule) => boolean): boolean =>
	rules.some((r) => r.enabled === false && matchKeys(r).length === 1 && pred(r));

test('пресет: выключает пакеты канона и ссылки на workflow/action стека', () => {
	expect(disabled((r) => r.matchPackageNames?.includes('@alxwlw/**') === true)).toBe(true);
	// github-actions даёт ссылке alxwlw/stack/.github/workflows/check.yml@v1 packageName alxwlw/stack.
	expect(disabled((r) => r.matchPackageNames?.includes('alxwlw/stack') === true)).toBe(true);
});

test('пресет: выключает packageManager и engines', () => {
	for (const t of ['packageManager', 'engines']) {
		expect(disabled((r) => r.matchDepTypes?.includes(t) === true)).toBe(true);
	}
});

// stack sync пишет в pnpm-workspace.yaml каждую группу канона, выбранную потребителем (dev всегда,
// остальные через with), поэтому выключен должен быть каталог каждой группы из catalogs.json.
test('пресет: выключает pnpm.catalog.<группа> для каждой группы каталогов канона', () => {
	const groups = Object.keys(readCanonSource().catalogs);
	expect(groups).toContain('dev');
	for (const g of groups) {
		expect(disabled((r) => r.matchDepTypes?.includes(`pnpm.catalog.${g}`) === true)).toBe(true);
	}
});

test('пресет: выключает менеджер proto — пины .prototools двигает stack sync', () => {
	expect(disabled((r) => r.matchManagers?.includes('proto') === true)).toBe(true);
});

// ignorePaths в Renovate заменяет, а не дополняет значение config:recommended: пресет с ним снял
// бы у потребителя node_modules/** и прочее. extends пресету не нужен: он не должен тянуть
// потребителю чужие пресеты.
test('пресет: не задаёт extends и ignorePaths — они остаются за потребителем', () => {
	expect(preset.extends).toBeUndefined();
	expect(preset.ignorePaths).toBeUndefined();
});

// Одного match* для копий пинов нет: имя node несут и engines, и .nvmrc, и образ в container:, а
// matchManagers: ['dockerfile'] в одиночку выключил бы все образы. Пара сужает правило намеренно.
test('пресет: выключает образы node и oven/bun в Dockerfile — и только их', () => {
	expect(rules.find((r) => r.matchManagers?.includes('dockerfile'))).toStrictEqual({
		description: expect.any(String),
		matchManagers: ['dockerfile'],
		matchPackageNames: ['node', 'oven/bun'],
		enabled: false,
	});
});

// uses-with — depType версии во входе with у action; тем же типом идут python-version, moon-version
// и десятки других, поэтому правило называет три имени: node, bun и moonrepo/proto (proto-version).
test('пресет: выключает версии node, bun и proto во входах with — и только их', () => {
	expect(rules.find((r) => r.matchDepTypes?.includes('uses-with'))).toStrictEqual({
		description: expect.any(String),
		matchDepTypes: ['uses-with'],
		matchDepNames: ['node', 'bun', 'moonrepo/proto'],
		enabled: false,
	});
});

// Выдержку npm диктует pnpm канона: с явным minimumReleaseAge он не ставит версию моложе суток, а Renovate
// без правила предложил бы её сразу, и лок не обновился бы. Это единственное правило не про `enabled: false`.
const isAgeRule = (r: Rule): boolean => r.minimumReleaseAge !== undefined;

test('пресет: npm — выдержка сутки, как minimumReleaseAge pnpm', () => {
	expect(rules.filter(isAgeRule)).toHaveLength(1);
	expect(rules.find(isAgeRule)).toStrictEqual({
		description: expect.any(String),
		matchDatasources: ['npm'],
		minimumReleaseAge: '1 day',
	});
});

test('пресет: выдержка опирается на pnpm 12+ канона', () => {
	const pnpm = parsePins(
		readFileSync(join(ROOT, 'packages', 'stack', 'canon', 'files', 'prototools'), 'utf8'),
	).pnpm;
	expect(pnpm).toBeDefined();
	expect(Number.parseInt(pnpm ?? '', 10)).toBeGreaterThanOrEqual(12);
});

// Статус renovate/stability-days выключен с PAT-эры: у PAT не было права на commit statuses, 403 бросал прогон.
test('пресет: статус выдержки выключен', () => {
	expect(preset.statusCheckNames).toStrictEqual({ minimumReleaseAge: null });
});

test('пресет: каждое правило, кроме выдержки, только выключает — других решений за потребителя он не принимает', () => {
	const allowed = new Set([
		'description',
		'matchPackageNames',
		'matchDepNames',
		'matchDepTypes',
		'matchManagers',
		'enabled',
	]);
	expect(rules.length).toBeGreaterThan(0);
	const disabling = rules.filter((r) => !isAgeRule(r));
	expect(disabling.length).toBe(rules.length - 1);
	for (const r of disabling) {
		expect(r.enabled).toBe(false);
		for (const key of Object.keys(r)) expect(allowed.has(key)).toBe(true);
	}
	const counts = disabling.map((r) => matchKeys(r).length);
	for (const n of counts) {
		expect(n).toBeGreaterThanOrEqual(1);
		expect(n).toBeLessThanOrEqual(2);
	}
	// Два match* — только у правил о копиях пинов (тесты выше называют их целиком).
	expect(counts.filter((n) => n === 2)).toHaveLength(2);
});

// '!имя' в match*-списке отменяет совпадение: includes(...) в тестах выше его пропускает, а правило
// молча перестаёт выключать пакет.
test('пресет: в match*-списках нет отрицаний (значений с «!»)', () => {
	let checked = 0;
	for (const r of rules) {
		for (const [key, value] of Object.entries(r)) {
			if (!key.startsWith('match')) continue;
			expect(Array.isArray(value)).toBe(true);
			for (const v of value as string[]) {
				expect(v.startsWith('!')).toBe(false);
				checked += 1;
			}
		}
	}
	// Непустой обход: иначе тест молчал бы при пустом пресете.
	expect(checked).toBeGreaterThan(0);
});
