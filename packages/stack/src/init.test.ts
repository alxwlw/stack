import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

import { readStackConfig, StackConfigError } from './config.ts';
import { initConfig } from './init.ts';

test('создаёт .stack.jsonc, который читается обратно', () => {
	const dir = mkdtempSync(join(tmpdir(), 'stack-init-'));
	const path = initConfig(dir, { profile: 'node', with: ['libs'] });
	expect(readFileSync(path, 'utf8')).toContain('"$schema"');
	const cfg = readStackConfig(dir);
	expect(cfg.profile).toBe('node');
	expect(cfg.with).toEqual(['libs']);
});

// Task 13: plain JSON.stringify(…, null, '\t') always wraps a non-empty array across lines;
// oxfmt (printWidth 100) collapses one this short onto one line. A repo's first `stack init`
// used to fail its own just-seeded `oxfmt --check` before a single line of product code changed.
// Mutation: reverting jsonArrayLine's inline join back to a multi-line template turns this red.
test('.stack.jsonc: короткий "with" — одной строкой, как отформатировал бы oxfmt', () => {
	const dir = mkdtempSync(join(tmpdir(), 'stack-init-'));
	const path = initConfig(dir, {
		profile: 'node',
		with: ['libs', 'moon-tasks', 'knip', 'depcruise'],
	});
	const text = readFileSync(path, 'utf8');
	expect(text).toContain('"with": ["libs", "moon-tasks", "knip", "depcruise"],');
	expect(text).not.toMatch(/"with": \[\s*\n/);
});

test('не перезаписывает существующий файл', () => {
	const dir = mkdtempSync(join(tmpdir(), 'stack-init-'));
	initConfig(dir, { profile: 'node' });
	expect(() => initConfig(dir, { profile: 'infra' })).toThrow(StackConfigError);
});
