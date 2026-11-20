/**
 * Task 13 fix-round 2 (SHOULD-FIX): the only guard on `sortPackageJson: false` was the dogfood
 * byte-identity test across the four `.oxfmtrc.jsonc` copies — it catches DRIFT between copies,
 * not a wrong VALUE shared by all four (a reviewer flipping all four to `true` in lockstep would
 * pass it, 113 green). This test runs the real `oxfmt` binary against a fixture `package.json`
 * with deliberately shuffled key order, using canon's actual config, and asserts the order
 * survives `--write` — behavior, not text.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

import { PEERS_BASELINE } from './peers.ts';
import { canonFile } from './testkit.ts';

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
	writeFileSync(join(dir, '.oxfmtrc.jsonc'), canonFile('.oxfmtrc.jsonc'));
	const target = join(dir, 'package.json');
	writeFileSync(target, `${JSON.stringify(pkg, null, '\t')}\n`);
	const res = spawnSync(OXFMT_BIN, [target], { cwd: dir, encoding: 'utf8' });
	expect(res.status).toBe(0);
	return Object.keys(JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown>);
}

test('canon oxfmtrc: sortPackageJson:false — oxfmt --write не трогает порядок ключей package.json', () => {
	const keysAfter = formatWithCanonConfig(SHUFFLED_PACKAGE_JSON);
	expect(keysAfter).toEqual(Object.keys(SHUFFLED_PACKAGE_JSON));
	// Таймаут 30 с: тест запускает oxfmt, на CI-раннере это упирается в 5 с по умолчанию.
}, 30_000);

const REPO_RULES_BASELINE = '.repo-rules-baseline.json';
// Вид, в котором файлы пишет канон: repo-rules — два пробела, peers — табуляция и `by` по элементу на строку.
const RULES_TEXT = `${JSON.stringify({ version: 1, rules: { 'max-lines': { 'src/a.ts': 1 } } }, null, 2)}\n`;
const PEERS_TEXT = `${JSON.stringify(
	{ version: 1, peers: [{ name: 'react', by: ['a@1.0.0', 'b@2.0.0'] }] },
	null,
	'\t',
)}\n`;

test('canon oxfmtrc: baseline канона не форматируются, такой же файл под другим именем — да', () => {
	const dir = mkdtempSync(join(tmpdir(), 'stack-oxfmtrc-'));
	writeFileSync(join(dir, '.oxfmtrc.jsonc'), canonFile('.oxfmtrc.jsonc'));
	mkdirSync(join(dir, 'sub'));
	const ignored = [REPO_RULES_BASELINE, PEERS_BASELINE, `sub/${REPO_RULES_BASELINE}`];
	writeFileSync(join(dir, REPO_RULES_BASELINE), RULES_TEXT);
	writeFileSync(join(dir, `sub/${REPO_RULES_BASELINE}`), RULES_TEXT);
	writeFileSync(join(dir, PEERS_BASELINE), PEERS_TEXT);
	// Контроль: тот же текст под именами вне списка oxfmt считает неотформатированным.
	writeFileSync(join(dir, 'rules-control.json'), RULES_TEXT);
	writeFileSync(join(dir, 'peers-control.json'), PEERS_TEXT);

	const checked = spawnSync(OXFMT_BIN, ['--check', '.'], { cwd: dir, encoding: 'utf8' });
	const report = `${checked.stdout}${checked.stderr}`;
	expect(checked.status).toBe(1);
	expect(report).toContain('rules-control.json');
	expect(report).toContain('peers-control.json');
	expect(report).not.toContain('baseline');

	// Запись: контрольные файлы переписаны, baseline — байт в байт прежние.
	expect(spawnSync(OXFMT_BIN, ['.'], { cwd: dir, encoding: 'utf8' }).status).toBe(0);
	expect(readFileSync(join(dir, 'rules-control.json'), 'utf8')).not.toBe(RULES_TEXT);
	expect(readFileSync(join(dir, 'peers-control.json'), 'utf8')).not.toBe(PEERS_TEXT);
	for (const path of ignored) {
		const expected = path.endsWith(PEERS_BASELINE) ? PEERS_TEXT : RULES_TEXT;
		expect(readFileSync(join(dir, path), 'utf8')).toBe(expected);
	}
}, 30_000);

test('canon oxfmtrc: явный аргумент игнор не обходит', () => {
	const dir = mkdtempSync(join(tmpdir(), 'stack-oxfmtrc-'));
	writeFileSync(join(dir, '.oxfmtrc.jsonc'), canonFile('.oxfmtrc.jsonc'));
	writeFileSync(join(dir, REPO_RULES_BASELINE), RULES_TEXT);
	writeFileSync(join(dir, 'rules-control.json'), RULES_TEXT);
	const res = spawnSync(OXFMT_BIN, [REPO_RULES_BASELINE, 'rules-control.json'], {
		cwd: dir,
		encoding: 'utf8',
	});
	expect(res.status).toBe(0);
	expect(readFileSync(join(dir, REPO_RULES_BASELINE), 'utf8')).toBe(RULES_TEXT);
	expect(readFileSync(join(dir, 'rules-control.json'), 'utf8')).not.toBe(RULES_TEXT);
}, 30_000);
