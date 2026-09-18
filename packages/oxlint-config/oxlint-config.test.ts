/**
 * Preset regression suite: runs the REAL oxlint CLI against `fixtures/` with
 * each shipped preset and asserts the exact diagnostics — including a
 * consumer-simulation config that extends the nest preset from another
 * directory (the `node_modules` consumption shape).
 *
 * Run: `bun test packages/oxlint-config` (or `moon run oxlint-config:test`).
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

const PKG = import.meta.dir;
const OXLINT_BIN = join(PKG, 'node_modules', '.bin', 'oxlint');
const FIXTURES = join(PKG, 'fixtures');

interface Diagnostic {
	message: string;
	code: string;
	severity: string;
	filename: string;
}

function run(config: string, files: string[], extraArgs: string[] = []): Diagnostic[] {
	const res = spawnSync(
		OXLINT_BIN,
		['--config', join(PKG, config), '--format', 'json', ...extraArgs, ...files],
		{ encoding: 'utf8', cwd: PKG },
	);
	// exit 1 = diagnostics found (expected); >1 = crash / config parse error.
	// Контекст в сообщении — не украшение: перемежающийся провал этого файла однажды не удалось
	// разобрать именно потому, что `JSON.parse` падал голым SyntaxError без вывода процесса.
	const ctx = `status=${res.status} signal=${res.signal}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`;
	expect(res.status, ctx).not.toBeNull();
	expect(res.status as number, ctx).toBeLessThanOrEqual(1);
	let parsed: { diagnostics: Diagnostic[] };
	try {
		parsed = JSON.parse(res.stdout) as { diagnostics: Diagnostic[] };
	} catch (err) {
		throw new Error(`oxlint не отдал JSON: ${err instanceof Error ? err.message : err}\n${ctx}`);
	}
	return parsed.diagnostics;
}

test('nest preset flags the defaulted ctor param without @Optional', () => {
	const hits = run('nest.jsonc', [join(FIXTURES, 'nest-di.ts')]);
	const di = hits.filter((d) => d.code === 'stack(require-nest-di-decorator)');
	expect(di).toHaveLength(1);
	expect(di[0]?.message).toContain('"inner"');
	expect(di[0]?.message).toContain('BadService');
});

test('node preset enforces the canon naming convention (case-transform parity)', () => {
	const hits = run('node.jsonc', [join(FIXTURES, 'naming.ts')]);
	const naming = hits.filter((d) => d.code === 'stack(naming-convention)');
	const messages = naming.map((h) => h.message).sort();
	expect(messages).toHaveLength(3);
	expect(messages.some((m) => m.includes("'badFunctionName_x'"))).toBe(true);
	expect(messages.some((m) => m.includes("'badIface'"))).toBe(true);
	expect(messages.some((m) => m.includes("'NestedPascal'"))).toBe(true);
});

test('node preset spares naming in out-of-program files (disableTypeChecked parity)', () => {
	const hits = run('node.jsonc', [join(FIXTURES, 'naming.config.ts')]);
	expect(hits.filter((d) => d.code === 'stack(naming-convention)')).toHaveLength(0);
});

test('base preset spares require() in .cjs shims', () => {
	const hits = run('base.jsonc', [join(FIXTURES, 'local-shim.cjs')]);
	expect(hits.filter((d) => d.code.includes('no-require-imports'))).toHaveLength(0);
});

test('base preset validates TSDoc via stack/tsdoc-syntax', () => {
	const hits = run('base.jsonc', [join(FIXTURES, 'tsdoc.ts')]);
	const tsdoc = hits.filter((d) => d.code === 'stack(tsdoc-syntax)');
	const messages = tsdoc.map((h) => h.message);
	expect(messages.some((m) => m.includes('tsdoc-param-tag-with-invalid-type'))).toBe(true);
	expect(messages.some((m) => m.includes('tsdoc-undefined-tag'))).toBe(true);
});

test('base preset sorts imports via the simple-import-sort jsPlugin shim', () => {
	const hits = run('base.jsonc', [join(FIXTURES, 'sort.ts')]);
	const sort = hits.filter((d) => d.code === 'simple-import-sort(imports)');
	expect(sort).toHaveLength(1);
});

test('react preset carries rules-of-hooks', () => {
	const hits = run('react.jsonc', [join(FIXTURES, 'react-hooks.tsx')]);
	const hooks = hits.filter((d) => d.code.includes('rules-of-hooks'));
	expect(hooks).toHaveLength(1);
});

// Task 13 fix-round 1: oxlint enables react/refs + react/set-state-in-effect by default the
// moment the `react` plugin is on — react.jsonc turns both off explicitly (dated comment there).
// Mutation: deleting the two "off" lines from react.jsonc turns this red (both rules fire again).
test('react preset silences react/refs and react/set-state-in-effect (temporary, dated off)', () => {
	const hits = run('react.jsonc', [join(FIXTURES, 'react-new-rules.tsx')]);
	expect(hits.filter((d) => d.code === 'react(refs)')).toHaveLength(0);
	expect(hits.filter((d) => d.code === 'react(set-state-in-effect)')).toHaveLength(0);
});

test('type-aware layer fires under --type-aware and is silent without it', () => {
	const withTa = run('base.jsonc', [join(FIXTURES, 'type-aware.ts')], ['--type-aware']);
	const floating = withTa.filter((d) => d.code === 'typescript(no-floating-promises)');
	expect(floating).toHaveLength(1);

	// Without the flag the rule is silently skipped — documented sharp edge:
	// consumers MUST keep --type-aware in their lint task.
	const withoutTa = run('base.jsonc', [join(FIXTURES, 'type-aware.ts')]);
	expect(withoutTa.filter((d) => d.code === 'typescript(no-floating-promises)')).toHaveLength(0);
});

test('consumer-style extends from another directory resolves presets + jsPlugins', () => {
	const hits = run(join('fixtures', 'consumer', '.oxlintrc.consumer.jsonc'), [
		join(FIXTURES, 'nest-di.ts'),
		join(FIXTURES, 'naming.ts'),
	]);
	// Full nest chain must be live through the cross-directory extends:
	// require-nest-di-decorator (nest) + naming-convention (node).
	expect(hits.filter((d) => d.code === 'stack(require-nest-di-decorator)')).toHaveLength(1);
	expect(hits.filter((d) => d.code === 'stack(naming-convention)').length).toBeGreaterThanOrEqual(
		3,
	);
});
