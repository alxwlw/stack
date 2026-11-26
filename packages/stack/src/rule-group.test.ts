import { expect, test } from 'bun:test';

import type { Finding } from './findings.ts';
import { type GroupContext, type GroupReport, runGroups } from './rule-group.ts';
import { testCanon, testRepo } from './testkit.ts';

type Say = (word: string) => string;

const finding = (name: string): Finding => ({
	code: 'unreadable-file',
	target: name,
	message: name,
});
const table = {
	a: (_ctx: GroupContext, say: Say) => ({ findings: [finding('a')], notes: [say('a')] }),
	b: (_ctx: GroupContext, say: Say) => ({ findings: [finding('b')], notes: [say('b'), 'b2'] }),
	loud: (_ctx: GroupContext, _port: Say): GroupReport => {
		throw new Error('boom');
	},
};
const ctx: GroupContext = {
	repoRoot: '/r',
	repo: testRepo(testCanon()),
	env: {},
	prBase: { skipped: 'no --base outside GitHub Actions' },
};
const echo: Say = (word) => `note ${word}`;
const untouched: Say = () => {
	throw new Error('порт выключенной группы не должен вызываться');
};

test('идут только включённые группы; порт выключенной не зовётся', () => {
	expect(runGroups(table, ['a'], ctx, { a: echo, b: untouched })).toStrictEqual({
		findings: [finding('a')],
		notes: ['note a'],
	});
});

test('порядок — порядок включённых имён, находки и пометки склеены', () => {
	expect(runGroups(table, ['b', 'a'], ctx, { a: echo, b: echo })).toStrictEqual({
		findings: [finding('b'), finding('a')],
		notes: ['note b', 'b2', 'note a'],
	});
});

test('группа получает тот же контекст и свой порт', () => {
	const seen: [GroupContext, Say][] = [];
	const spy = {
		a: (c: GroupContext, p: Say): GroupReport => {
			seen.push([c, p]);
			return { findings: [], notes: [] };
		},
	};
	runGroups(spy, ['a'], ctx, { a: echo });
	expect(seen).toHaveLength(1);
	expect(seen[0]?.[0]).toBe(ctx);
	expect(seen[0]?.[1]).toBe(echo);
});

test.each([
	['ключа нет', {}],
	['ключ со значением undefined', { a: undefined }],
])('включена, а порта нет (%s) — Error', (_name, ports) => {
	expect(() => runGroups(table, ['a'], ctx, ports)).toThrow(
		new Error('rule group "a" is enabled but has no port'),
	);
});

test('исключение группы летит наружу, а не становится «находок нет»', () => {
	expect(() => runGroups(table, ['a', 'loud'], ctx, { a: echo, loud: echo })).toThrow(
		new Error('boom'),
	);
});

test('включённых нет — пустой отчёт', () => {
	expect(runGroups(table, [], ctx, {})).toStrictEqual({ findings: [], notes: [] });
});
