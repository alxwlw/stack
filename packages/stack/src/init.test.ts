import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

import { readStackConfig, StackConfigError } from './config.ts';
import { initConfig } from './init.ts';
import { OWNER_SOURCE, repoDir } from './testkit.ts';
import { acmeSource } from './testkit-sources.ts';

test('создаёт .stack.jsonc, который читается обратно', () => {
	const dir = repoDir({});
	const path = initConfig(dir, OWNER_SOURCE, { profile: 'node', with: ['libs'] });
	expect(readFileSync(path, 'utf8')).toContain('"$schema"');
	const cfg = readStackConfig(dir, OWNER_SOURCE.settings);
	expect(cfg.profile).toBe('node');
	expect(cfg.with).toEqual(['libs']);
});

// Task 13: plain JSON.stringify(…, null, '\t') always wraps a non-empty array across lines;
// oxfmt (printWidth 100) collapses one this short onto one line. A repo's first `stack init`
// used to fail its own just-seeded `oxfmt --check` before a single line of product code changed.
// Mutation: reverting jsonArrayLine's inline join back to a multi-line template turns this red.
test('.stack.jsonc: короткий "with" — одной строкой, как отформатировал бы oxfmt', () => {
	const dir = repoDir({});
	const path = initConfig(dir, OWNER_SOURCE, {
		profile: 'node',
		with: ['libs', 'moon-tasks', 'knip', 'depcruise', 'renovate'],
	});
	const text = readFileSync(path, 'utf8');
	expect(text).toContain('"with": ["libs", "moon-tasks", "knip", "depcruise", "renovate"],');
	expect(text).not.toMatch(/"with": \[\s*\n/);
});

test('не перезаписывает существующий файл', () => {
	const dir = repoDir({});
	initConfig(dir, OWNER_SOURCE, { profile: 'node' });
	expect(() => initConfig(dir, OWNER_SOURCE, { profile: 'infra' })).toThrow(StackConfigError);
});

test('init пишет файл с именем из настроек и $schema по имени пакета канона', () => {
	const dir = repoDir({});
	const path = initConfig(dir, acmeSource(), { profile: 'web', with: ['x'] });
	expect(path).toBe(join(dir, '.acme.jsonc'));
	expect(readFileSync(path, 'utf8')).toBe(
		'{\n\t"$schema": "./node_modules/@acme/canon/schema.json",\n\t"profile": "web",\n\t"with": ["x"],\n\t"exceptions": [],\n}\n',
	);
	expect(() => initConfig(dir, acmeSource(), { profile: 'web' })).toThrow(
		'.acme.jsonc already exists',
	);
});
