import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';
import JSON5 from 'json5';

import { canonBundles } from './testkit.ts';

const ROOT = join(import.meta.dir, '..', '..', '..');

// Renovate самого стека двигает пины канона. Пресет канона он подключать не должен: тот выключает
// proto и каталог dev — ровно то, что здесь нужно поднимать.
const ownRenovate = JSON5.parse(readFileSync(join(ROOT, 'renovate.json5'), 'utf8')) as {
	extends?: string[];
	proto?: { managerFilePatterns?: string[] };
	customManagers?: {
		customType?: string;
		managerFilePatterns?: string[];
		matchStrings?: string[];
	}[];
	ignorePaths?: string[];
	packageRules?: {
		groupName?: string;
		separateMajorMinor?: boolean;
		matchFileNames?: string[];
		matchPackageNames?: string[];
		enabled?: boolean;
		allowedVersions?: string;
	}[];
};

// Паттерн Renovate вида '/regex/' → проверка, что он попадает в существующий файл (ловит переименование).
function hits(pattern: string, file: string): boolean {
	const m = /^\/(.*)\/$/.exec(pattern);
	expect(m).not.toBeNull();
	return new RegExp(m?.[1] ?? '').test(file) && existsSync(join(ROOT, file));
}

test('свой renovate.json5: без пресета канона', () => {
	// Любая ссылка на репо стека в extends (с тегом или без) — это пресет канона.
	expect((ownRenovate.extends ?? []).some((e) => e.includes('alxwlw/stack'))).toBe(false);
});

test('свой renovate.json5: свои пакеты и ссылки на стек выключены одним правилом', () => {
	const rule = (ownRenovate.packageRules ?? []).find(
		(r) =>
			r.enabled === false &&
			(r.matchPackageNames ?? []).includes('@alxwlw/**') &&
			(r.matchPackageNames ?? []).includes('alxwlw/stack'),
	);
	expect(rule).toBeDefined();
	// Точный список: '!alxwlw/stack' в нём отменил бы отключение для ссылок на стек, а includes это пропустит.
	expect(rule?.matchPackageNames).toEqual(['@alxwlw/**', 'alxwlw/stack']);
	// match* внутри правила Renovate склеивает через И, exclude* вычитает: лишний matchManagers или
	// excludePackageNames сузил бы правило, и ссылки alxwlw/stack@v1 в github-actions остались бы включёнными.
	expect(Object.keys(rule ?? {}).filter((k) => /^(match|exclude)/.test(k))).toEqual([
		'matchPackageNames',
	]);
});

test('свой renovate.json5: proto видит канон-prototools, jsonata — catalogs.json', () => {
	expect(
		(ownRenovate.proto?.managerFilePatterns ?? []).some((p) =>
			hits(p, 'packages/stack/canon/files/prototools'),
		),
	).toBe(true);
	const jsonata = (ownRenovate.customManagers ?? []).find((c) => c.customType === 'jsonata');
	expect(
		(jsonata?.managerFilePatterns ?? []).some((p) => hits(p, 'packages/stack/canon/catalogs.json')),
	).toBe(true);
});

test('свой renovate.json5: канон и корень — одна группа canon pins', () => {
	const group = (ownRenovate.packageRules ?? []).find((r) => r.groupName === 'canon pins');
	for (const f of [
		'packages/stack/canon/files/prototools',
		'packages/stack/canon/catalogs.json',
		'.prototools',
		'pnpm-workspace.yaml',
		'package.json',
	]) {
		expect(existsSync(join(ROOT, f))).toBe(true);
		expect((group?.matchFileNames ?? []).some((g) => new Bun.Glob(g).match(f))).toBe(true);
	}
	// Лишний match*/exclude* сузил бы группу: часть файлов ушла бы из canon pins в отдельные PR.
	expect(Object.keys(group ?? {}).filter((k) => /^(match|exclude)/.test(k))).toEqual([
		'matchFileNames',
	]);
});

// Связка из canon/bundles.json бампается одной веткой: своё правило 'bundle <имя>' с тем же matchPackageNames.
// Правило стоит ниже canon pins: Renovate применяет совпавшие правила по порядку, поздний groupName перекрывает ранний.
describe('renovate.json5: правила связок canon/bundles.json', () => {
	const bundles = canonBundles();
	const rules = ownRenovate.packageRules ?? [];
	const canonIdx = rules.findIndex((r) => r.groupName === 'canon pins');

	test.each(Object.keys(bundles))(
		'bundle %s: одно правило, тот же matchPackageNames, ниже canon pins',
		(name) => {
			expect(canonIdx).toBeGreaterThanOrEqual(0);
			const idx = rules.flatMap((r, i) => (r.groupName === `bundle ${name}` ? [i] : []));
			// Своя группа, ни с кем не общая: общая слила бы мажор одной связки с другой.
			expect(idx).toHaveLength(1);
			const rule = rules[idx[0] ?? -1];
			expect(rule?.matchPackageNames).toStrictEqual(bundles[name]?.match);
			// Лишний match*/exclude* сузил бы правило: часть пакетов связки ушла бы из ветки.
			expect(Object.keys(rule ?? {}).filter((k) => /^(match|exclude)/.test(k))).toStrictEqual([
				'matchPackageNames',
			]);
			expect(rule?.separateMajorMinor).toBe(false);
			expect(idx[0]).toBeGreaterThan(canonIdx);
		},
	);

	test('правило группы по именам пакетов — правило связки из canon/bundles.json', () => {
		// Правило с groupName и matchPackageNames группирует пакеты в одну ветку — это связка, и её запись обязана быть.
		const orphans = rules
			.filter((r) => r.groupName !== undefined && r.matchPackageNames !== undefined)
			.map((r) => r.groupName)
			.filter((g) => !Object.keys(bundles).some((n) => g === `bundle ${n}`));
		expect(orphans).toStrictEqual([]);
	});
});

test('свой renovate.json5: фикстуры Renovate не трогает', () => {
	expect(ownRenovate.ignorePaths ?? []).toContain('fixtures/**');
	// ignorePaths заменяет, а не дополняет config:recommended — node_modules надо вернуть явно.
	expect(ownRenovate.ignorePaths ?? []).toContain('**/node_modules/**');
});

test('renovate.json5: typescript не поднимается на ночные сборки', () => {
	const rule = (ownRenovate.packageRules ?? []).find(
		(r) => JSON.stringify(r.matchPackageNames) === JSON.stringify(['typescript']),
	);
	expect(rule?.allowedVersions).toBeDefined();
	// allowedVersions вида '!/regex/': версия, подходящая под regex, отвергается.
	const m = /^!\/(.*)\/$/.exec(rule?.allowedVersions ?? '');
	expect(m).not.toBeNull();
	const night = new RegExp(m?.[1] ?? '');
	expect(night.test('7.1.0-dev.20261104.1')).toBe(true);
	for (const v of ['7.1.0-beta', '7.1.0-rc', '7.1.0', '7.1.1']) expect(night.test(v)).toBe(false);
});
