import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'bun:test';
import JSON5 from 'json5';

import { loadCatalogs } from './canon.ts';

// Пресет Renovate живёт в корне репо, а не в npm-пакете: потребитель подключает его как
// github>alxwlw/stack//renovate/canon.json5#v1, Renovate читает файл с GitHub по тегу.
const ROOT = join(import.meta.dir, '..', '..', '..');

interface Rule {
	description?: string;
	matchPackageNames?: string[];
	matchDepTypes?: string[];
	matchManagers?: string[];
	enabled?: boolean;
}

const preset = JSON5.parse(readFileSync(join(ROOT, 'renovate', 'canon.json5'), 'utf8')) as {
	packageRules?: Rule[];
	extends?: unknown;
	ignorePaths?: unknown;
};
const rules = preset.packageRules ?? [];
const disabled = (pred: (r: Rule) => boolean): boolean =>
	rules.some((r) => r.enabled === false && pred(r));

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
	const groups = Object.keys(loadCatalogs());
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

test('пресет: каждое правило только выключает — других решений за потребителя он не принимает', () => {
	const allowed = new Set([
		'description',
		'matchPackageNames',
		'matchDepTypes',
		'matchManagers',
		'enabled',
	]);
	expect(rules.length).toBeGreaterThan(0);
	for (const r of rules) {
		expect(r.enabled).toBe(false);
		// Renovate соединяет matcher'ы одного правила через AND: второй match* сузил бы правило до
		// пересечения и молча снял бы покрытие, поэтому ровно один match* на правило.
		expect(Object.keys(r).filter((k) => k.startsWith('match'))).toHaveLength(1);
		for (const key of Object.keys(r)) expect(allowed.has(key)).toBe(true);
	}
});
