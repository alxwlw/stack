import { expect, test } from 'bun:test';

import { checkDeprecatedGroups, checkGroups, checkRules } from './rule-settings.ts';

test('groups: имена из RULE_GROUPS в порядке настроек, пустой список законен', () => {
	expect(checkGroups(['repo-rules', 'peers'])).toStrictEqual(['repo-rules', 'peers']);
	expect(checkGroups([])).toStrictEqual([]);
});

test.each([
	['x', '"groups" must be an array of rule group names'],
	[[1], '"groups" must be an array of rule group names'],
	[
		['peer'],
		'"groups" has unknown rule group "peer", expected one of: guardrails, peers, repo-rules',
	],
	[['peers', 'peers'], '"groups" lists "peers" twice'],
])('groups %j — ошибка пакета канона', (raw, text) => {
	expect(() => checkGroups(raw)).toThrow(`canon settings: ${text}`);
});

test('deprecatedGroups: имя → причина, пустой объект законен', () => {
	expect(checkDeprecatedGroups({ renovate: 'why' }, ['peers'])).toStrictEqual({ renovate: 'why' });
	expect(checkDeprecatedGroups({}, [])).toStrictEqual({});
});

test.each([
	[[], '"deprecatedGroups" must be an object of group name → reason'],
	[{ renovate: '' }, '"deprecatedGroups.renovate" must be a non-empty string'],
	[{ renovate: 1 }, '"deprecatedGroups.renovate" must be a non-empty string'],
	[{ peers: 'x' }, '"deprecatedGroups" names "peers", which the canon also offers'],
])('deprecatedGroups %j — ошибка пакета канона', (raw, text) => {
	expect(() => checkDeprecatedGroups(raw, ['peers'])).toThrow(`canon settings: ${text}`);
});

test('rules: включённые правила с параметрами как есть, пустой объект законен', () => {
	const raw = { 'inline-version': {}, 'renovate-preset': { preset: 'github>acme/canon#v3' } };
	expect(checkRules(raw)).toStrictEqual(raw);
	expect(checkRules({})).toStrictEqual({});
});

test.each([
	[[], '"rules" must be an object'],
	[
		{ 'inline-versions': {} },
		'"rules" has unknown rule "inline-versions", expected one of: canon-not-extended, dependabot-config, engines-node, inline-version, moon-default-branch, moon-toolchain-version, moon-v1-toolchain, package-manager, release-age-exclude, renovate-preset, toolchain-pin',
	],
	[{ 'inline-version': true }, '"rules.inline-version" must be an object'],
	[{ 'inline-version': null }, '"rules.inline-version" must be an object'],
	[{ 'inline-version': [] }, '"rules.inline-version" must be an object'],
	[{ 'inline-version': { x: 1 } }, '"rules.inline-version" has unknown key "x"'],
	[{ 'renovate-preset': {} }, '"rules.renovate-preset.preset" must be a non-empty string'],
	[
		{ 'renovate-preset': { preset: '' } },
		'"rules.renovate-preset.preset" must be a non-empty string',
	],
	[{ 'renovate-preset': { preset: 'p', x: 1 } }, '"rules.renovate-preset" has unknown key "x"'],
])('rules %j — ошибка пакета канона', (raw, text) => {
	expect(() => checkRules(raw)).toThrow(`canon settings: ${text}`);
});

const seeds = (raw: unknown) => checkRules({ 'canon-not-extended': { seeds: raw } });
const AT = '"rules.canon-not-extended.seeds"';

test('seeds: gitleaks и json-extends как есть', () => {
	const raw = {
		'.gitleaks.toml': { kind: 'gitleaks' },
		'.oxlintrc.json': { kind: 'json-extends', package: '@acme/lint', message: 'extend @acme/lint' },
	} as const;
	expect(seeds(raw)).toStrictEqual({ 'canon-not-extended': { seeds: raw } });
});

test.each([
	[{}, `${AT} must be a non-empty object of dest → seed`],
	[[], `${AT} must be a non-empty object of dest → seed`],
	[{ a: 'gitleaks' }, `${AT} entry "a" must be an object`],
	[{ a: { kind: 'toml' } }, `${AT} entry "a" has "kind" outside: gitleaks, json-extends`],
	[{ a: { kind: 'gitleaks', package: 'x' } }, `${AT} entry "a" has unknown key "package"`],
	[
		{ a: { kind: 'json-extends', package: '@acme/lint/', message: 'm' } },
		`${AT} entry "a" has "package" that is not a package name: "@acme/lint/"`,
	],
	[
		{ a: { kind: 'json-extends', package: '', message: 'm' } },
		`${AT} entry "a" has "package" that is not a package name: ""`,
	],
	[
		{ a: { kind: 'json-extends', package: '@acme/my lint', message: 'm' } },
		`${AT} entry "a" has "package" that is not a package name: "@acme/my lint"`,
	],
	[
		{ a: { kind: 'json-extends', package: '@acme/lint' } },
		`${AT} entry "a" needs a non-empty "message"`,
	],
	[
		{ a: { kind: 'json-extends', package: '@acme/lint', message: 'm', x: 1 } },
		`${AT} entry "a" has unknown key "x"`,
	],
])('seeds %j — ошибка пакета канона', (raw, text) => {
	expect(() => seeds(raw)).toThrow(`canon settings: ${text}`);
});

test('canon-not-extended без seeds или с лишним ключом — ошибка пакета канона', () => {
	expect(() => checkRules({ 'canon-not-extended': {} })).toThrow(
		`canon settings: ${AT} must be a non-empty object of dest → seed`,
	);
	expect(() => checkRules({ 'canon-not-extended': { seeds: {}, x: 1 } })).toThrow(
		'canon settings: "rules.canon-not-extended" has unknown key "x"',
	);
});
