// Источники канона для тестов: настройки, манифест и литерал CanonSource. Из testkit.ts ничего не берёт.
import type { CanonSource } from './canon.ts';
import type { CanonSettings } from './canon-settings.ts';
import type { StackManifest } from './own-packages.ts';
import { RULE_NAMES, type RuleName, type RuleSettings } from './rule-settings.ts';

// Пресет владельца: на нём строятся и TEST_SETTINGS, и репозитории testkit.ts.
export const TEST_RENOVATE_PRESET = 'github>alxwlw/stack//renovate/canon.json5#v1';

// Имена как у канона владельца: иначе пришлось бы править сотни ожиданий (на другие имена тесты движка переводит фаза 4).
export const TEST_SETTINGS: CanonSettings = {
	profiles: ['node', 'contracts', 'infra'],
	configFile: '.stack.jsonc',
	command: 'stack',
	ownPackages: ['@alxwlw/'],
	syncPr: {
		title: 'chore(stack): canon {version}',
		body: 'Canon {version} applied.\n{files}',
		closeComment: 'Superseded by {url} ({version}).',
		upToDateComment: 'Canon {version} is already in {base}.',
	},
	groups: ['peers', 'repo-rules', 'guardrails'],
	deprecatedGroups: { renovate: "Renovate is the canon's dependency bot for every profile." },
	rules: {
		'release-age-exclude': {},
		'package-manager': {},
		'inline-version': {},
		'engines-node': {},
		'renovate-preset': { preset: TEST_RENOVATE_PRESET },
		'dependabot-config': {},
		'canon-not-extended': {},
		'moon-toolchain-version': {},
		'moon-v1-toolchain': {},
		'moon-default-branch': {},
		'toolchain-pin': {},
	},
};

// Выборка из TEST_SETTINGS.rules: только названные правила / все, кроме названных.
export function rulesOnly(...names: RuleName[]): RuleSettings {
	return Object.fromEntries(
		RULE_NAMES.filter((n) => names.includes(n)).map((n) => [n, TEST_SETTINGS.rules[n]]),
	);
}
export function rulesWithout(...names: RuleName[]): RuleSettings {
	return rulesOnly(...RULE_NAMES.filter((n) => !names.includes(n)));
}

// Чужой канон: доказывает, что настройки действуют.
export const ACME_SETTINGS: CanonSettings = {
	profiles: ['web', 'chain'],
	configFile: '.acme.jsonc',
	command: 'acme',
	ownPackages: ['@acme/', 'acme-engine'],
	syncPr: {
		title: 'chore: acme canon {version}',
		body: 'Canon {version} applied.\n{files}',
		closeComment: 'Superseded by {url} ({version}).',
		upToDateComment: 'Canon {version} is already in {base}.',
	},
	groups: ['repo-rules'],
	deprecatedGroups: {},
	rules: {
		'inline-version': {},
		'dependabot-config': {},
		'moon-v1-toolchain': {},
		// Правила, на которых тесты проверяют, что тексты и имена идут из настроек чужого канона.
		'release-age-exclude': {},
		'renovate-preset': { preset: 'github>acme/canon//renovate/canon.json5#v3' },
		'canon-not-extended': {},
	},
};

export const ACME_MANIFEST: StackManifest = {
	name: '@acme/canon',
	version: '3.0.0',
	dependencies: { '@acme/utils': '3.0.0', 'left-pad': '^1.3.0' },
};

export function testSource(over: Partial<CanonSource> = {}): CanonSource {
	return {
		settings: TEST_SETTINGS,
		entries: [
			{
				src: 'files/prototools',
				dest: '.prototools',
				appliesTo: ['node', 'contracts', 'infra'],
				content: 'node = "25.4.1"\npnpm = "10.99.0"\n',
			},
		],
		catalogs: { dev: {} },
		groups: { files: [], catalogs: [] },
		manifest: { name: '@alxwlw/stack', version: '0.0.0' },
		...over,
	};
}

// Чужой канон целиком: настройки и манифест acme, одна запись .prototools для web и chain.
export function acmeSource(over: Partial<CanonSource> = {}): CanonSource {
	return {
		settings: ACME_SETTINGS,
		entries: [
			{
				src: 'files/prototools',
				dest: '.prototools',
				appliesTo: ['web', 'chain'],
				content: 'node = "25.4.1"\npnpm = "10.99.0"\n',
			},
		],
		catalogs: { dev: {} },
		groups: { files: [], catalogs: [] },
		manifest: ACME_MANIFEST,
		...over,
	};
}
