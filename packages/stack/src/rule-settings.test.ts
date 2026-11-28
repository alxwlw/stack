import { expect, test } from 'bun:test';

import { checkDeprecatedGroups, checkGroups } from './rule-settings.ts';

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
