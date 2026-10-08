import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'bun:test';
import JSON5 from 'json5';

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

test('пресет: выключает каталог dev, packageManager и engines', () => {
	for (const t of ['pnpm.catalog.dev', 'packageManager', 'engines']) {
		expect(disabled((r) => r.matchDepTypes?.includes(t) === true)).toBe(true);
	}
});

test('пресет: выключает менеджер proto — пины .prototools двигает stack sync', () => {
	expect(disabled((r) => r.matchManagers?.includes('proto') === true)).toBe(true);
});

// ignorePaths и extends в Renovate не сливаются, а заменяются: пресет с ignorePaths снял бы у
// потребителя node_modules/** и прочее из config:recommended.
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
		for (const key of Object.keys(r)) expect(allowed.has(key)).toBe(true);
	}
});
