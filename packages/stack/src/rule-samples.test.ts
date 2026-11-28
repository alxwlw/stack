import { expect, test } from 'bun:test';

import type { Canon } from './canon.ts';
import { checkRepo, RULE_MODULES, syncRepo } from './check.ts';
import type { RuleTable } from './rule.ts';
import { RULE_NAMES, type RuleName, type RuleSettings } from './rule-settings.ts';
import { repoDir, testCanon } from './testkit.ts';
import { rulesOnly, rulesWithout, TEST_SETTINGS } from './testkit-sources.ts';

interface Sample {
	/** Файлы репозитория, на которых правило даёт находку. */
	files: Record<string, string>;
	/** Поля канона сверх testCanon(), без которых правило молчит (каталоги, свои пакеты). */
	canon?: Partial<Omit<Canon, 'settings'>>;
}

const WORKSPACE_DEV = (catalog: string) =>
	`packages:\n  - packages/*\n\ncatalogs:\n  dev:\n${catalog}`;

// Record<RuleName, …>: имя правила без образца не компилируется.
const SAMPLES: Record<RuleName, Sample> = {
	'release-age-exclude': {
		files: {
			'pnpm-workspace.yaml': `${WORKSPACE_DEV("    '@alxwlw/stack': 1.10.0\n")}minimumReleaseAge: 1440\nminimumReleaseAgeExclude:\n  - foo@1.0.0\n`,
		},
		canon: { catalogs: { dev: { '@alxwlw/stack': '1.10.0' } } },
	},
	'package-manager': {
		files: { 'package.json': '{ "name": "r", "packageManager": "pnpm@11.1.2" }\n' },
	},
	'inline-version': {
		files: {
			'pnpm-workspace.yaml': WORKSPACE_DEV('    oxlint: 1.83.0\n'),
			'packages/a/package.json': '{ "name": "a", "devDependencies": { "oxlint": "1.70.0" } }',
		},
		canon: { catalogs: { dev: { oxlint: '1.83.0' } } },
	},
	'engines-node': { files: { 'package.json': '{ "engines": { "node": "^24" } }' } },
	'renovate-preset': { files: {} },
	'dependabot-config': { files: { '.github/dependabot.yml': 'version: 2\n' } },
	'canon-not-extended': {
		files: { '.oxlintrc.json': '{}' },
		canon: { files: [{ dest: '.oxlintrc.json', content: '{}', strategy: 'create-if-absent' }] },
	},
	'moon-toolchain-version': {
		files: { '.moon/toolchains.yml': "pnpm:\n  version: '9.0.0'\nnode: {}\n" },
	},
	'moon-v1-toolchain': { files: { '.moon/toolchain.yml': 'node: {}\n' } },
	'moon-default-branch': {
		files: { '.moon/workspace.yml': "projects:\n  app: 'apps/app'\n" },
	},
	'toolchain-pin': {
		files: { 'apps/api/Dockerfile': 'FROM node:26.11.1-alpine AS base\n' },
		canon: { pins: { node: '26.13.1', pnpm: '12.21.0' } },
	},
};

function run(name: RuleName, rules: RuleSettings) {
	const s = SAMPLES[name];
	const canon = testCanon({ ...s.canon, settings: { ...TEST_SETTINGS, rules } });
	return { dir: repoDir(s.files), canon };
}

test.each(RULE_NAMES)('%s: включено одно — находки есть, и все с кодом правила', (name) => {
	const { dir, canon } = run(name, rulesOnly(name));
	const codes = checkRepo(dir, canon, []).findings.map((f) => f.code);
	expect(codes.length).toBeGreaterThan(0);
	expect(codes.filter((c) => c !== name)).toStrictEqual([]);
});

test.each(RULE_NAMES)('%s: выключено — находок с его кодом нет', (name) => {
	const { dir, canon } = run(name, rulesWithout(name));
	expect(checkRepo(dir, canon, []).findings.map((f) => f.code)).not.toContain(name);
});

// `satisfies` оставляет у записей свои типы: у записи без плана нет ключа `plan`, отсюда `in`.
const PLANNED = RULE_NAMES.filter((n) => 'plan' in RULE_MODULES[n]);

test('правила с планом — release-age-exclude, package-manager, moon-default-branch, toolchain-pin', () => {
	expect(PLANNED).toStrictEqual([
		'release-age-exclude',
		'package-manager',
		'moon-default-branch',
		'toolchain-pin',
	]);
});

test.each(PLANNED)('%s: выключено — sync не применяет его правку, включено — применяет', (name) => {
	const off = run(name, rulesWithout(name));
	expect(syncRepo(off.dir, off.canon, []).applied.map((d) => d.code)).not.toContain(name);
	const on = run(name, rulesOnly(name));
	expect(syncRepo(on.dir, on.canon, []).applied.map((d) => d.code)).toContain(name);
});

// Тест пустой: его «утверждение» — то, что файл проходит `tsc --build`.
test('имя правила без образца и без записи в таблице не компилируется', () => {
	const { 'toolchain-pin': _sample, ...rest } = SAMPLES;
	// @ts-expect-error — в образцах нет toolchain-pin
	const samples: Record<RuleName, Sample> = rest;
	const { 'toolchain-pin': _module, ...restModules } = RULE_MODULES;
	// @ts-expect-error — в таблице нет toolchain-pin
	const modules: RuleTable = restModules;
	expect([Object.keys(samples).length, Object.keys(modules).length]).toStrictEqual([10, 10]);
});
