/**
 * Task 13 fix-round 2 (SHOULD-FIX): the only guard on `sortPackageJson: false` was the dogfood
 * byte-identity test across the four `.oxfmtrc.jsonc` copies — it catches DRIFT between copies,
 * not a wrong VALUE shared by all four (a reviewer flipping all four to `true` in lockstep would
 * pass it, 113 green). This test runs the real `oxfmt` binary against a fixture `package.json`
 * with deliberately shuffled key order, using canon's actual config, and asserts the order
 * survives `--write` — behavior, not text.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

import { canonDir } from './canon.ts';

const ROOT = join(import.meta.dir, '..', '..', '..');
const OXFMT_BIN = join(ROOT, 'node_modules', '.bin', 'oxfmt');

// Deliberately NOT alphabetical and NOT the conventional name/version/description/type order —
// any sane sort would move at least one of these.
const SHUFFLED_PACKAGE_JSON = {
	version: '1.0.0',
	dependencies: { zod: '1.0.0' },
	name: 'z-fixture',
	type: 'module',
};

function formatWithCanonConfig(pkg: Record<string, unknown>): string[] {
	const dir = mkdtempSync(join(tmpdir(), 'stack-oxfmtrc-'));
	writeFileSync(
		join(dir, '.oxfmtrc.jsonc'),
		readFileSync(join(canonDir(), 'files', 'oxfmtrc.jsonc')),
	);
	const target = join(dir, 'package.json');
	writeFileSync(target, `${JSON.stringify(pkg, null, '\t')}\n`);
	const res = spawnSync(OXFMT_BIN, [target], { cwd: dir, encoding: 'utf8' });
	expect(res.status).toBe(0);
	return Object.keys(JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown>);
}

test('canon oxfmtrc: sortPackageJson:false — oxfmt --write не трогает порядок ключей package.json', () => {
	const keysAfter = formatWithCanonConfig(SHUFFLED_PACKAGE_JSON);
	expect(keysAfter).toEqual(Object.keys(SHUFFLED_PACKAGE_JSON));
});
