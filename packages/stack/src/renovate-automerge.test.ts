import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'bun:test';
import JSON5 from 'json5';

// Пресет автослива живёт в корне репо рядом с каноном и подключается как
// github>alxwlw/stack//renovate/automerge.json5#v1 (строку берут тесты шаблона и своего конфига).
const ROOT = join(import.meta.dir, '..', '..', '..');
const AUTOMERGE_PRESET = 'github>alxwlw/stack//renovate/automerge.json5#v1';

type Rule = Record<string, unknown> & {
	automerge?: boolean;
	matchUpdateTypes?: string[];
	minimumReleaseAge?: string;
	minimumReleaseAgeBehaviour?: string;
};

const source = readFileSync(join(ROOT, 'renovate', 'automerge.json5'), 'utf8');
const preset = JSON5.parse(source) as Record<string, unknown> & {
	packageRules?: Rule[];
};
const rules = preset.packageRules ?? [];

test('automerge: верхний уровень — вливает Renovate, статус выдержки выключен, решений потребителя нет', () => {
	expect(Object.keys(preset).sort()).toStrictEqual([
		'$schema',
		'automergeType',
		'packageRules',
		'platformAutomerge',
		'statusCheckNames',
	]);
	// шапка файла называет строку подключения, которой пользуются потребители
	expect(source).toContain(`'${AUTOMERGE_PRESET}'`);
	expect(preset.platformAutomerge).toBe(false);
	expect(preset.automergeType).toBe('pr');
	expect(preset.statusCheckNames).toStrictEqual({ minimumReleaseAge: null });
});

test('automerge: правила целиком', () => {
	const aged = { minimumReleaseAge: '3 days', minimumReleaseAgeBehaviour: 'timestamp-optional' };
	expect(rules).toStrictEqual([
		{
			description: expect.any(String),
			matchUpdateTypes: ['patch'],
			automerge: true,
			...aged,
			rebaseWhen: 'conflicted',
		},
		{
			description: expect.any(String),
			matchDepTypes: ['devDependencies'],
			matchUpdateTypes: ['minor'],
			matchCurrentVersion: '!/^v?0\\./',
			automerge: true,
			...aged,
			rebaseWhen: 'conflicted',
		},
		{
			description: expect.any(String),
			matchManagers: ['github-actions'],
			matchUpdateTypes: ['minor'],
			matchCurrentVersion: '!/^v?0\\./',
			automerge: true,
			...aged,
			rebaseWhen: 'conflicted',
		},
		{
			description: expect.any(String),
			matchUpdateTypes: ['lockFileMaintenance'],
			automerge: true,
			rebaseWhen: 'conflicted',
		},
	]);
});

test('automerge: ни одно правило не вливает major', () => {
	const merging = rules.filter((r) => r.automerge === true);
	expect(merging.length).toBeGreaterThan(0);
	for (const r of merging) {
		expect(r.matchUpdateTypes?.length ?? 0).toBeGreaterThan(0);
		expect(r.matchUpdateTypes).not.toContain('major');
	}
});

test('automerge: правила не переопределяют способ вливания и проверки', () => {
	const forbidden = [
		'platformAutomerge',
		'automergeType',
		'ignoreTests',
		'groupName',
		'schedule',
		'enabled',
	];
	for (const r of rules) {
		expect(Object.keys(r).filter((k) => forbidden.includes(k))).toStrictEqual([]);
	}
});

test('automerge: выдержка — только с timestamp-optional', () => {
	let checked = 0;
	for (const r of rules) {
		if (r.minimumReleaseAge === undefined) continue;
		checked++;
		expect(r.minimumReleaseAgeBehaviour).toBe('timestamp-optional');
	}
	expect(checked).toBeGreaterThan(0);
});
