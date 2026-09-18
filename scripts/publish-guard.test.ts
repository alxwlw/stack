/**
 * Task 13 fix-round 2 (Ruling 44/46): a gate, not a reminder. Global Constraints already said
 * "no private repo/org names in the public history" and it didn't stop the class from landing
 * three commits after its own cleanup (react.jsonc, react-new-rules.tsx). This test greps the
 * actual publish surface — every git-tracked file except the two directories that get stripped
 * before Task 14's orphan-history publish (`docs/plans/`, `docs/specs/` — internal SDD only) —
 * for the org and consumer-repo names that must never appear in what ships.
 *
 * Scope is deliberately broader than "the three package.json `files` arrays": it also covers
 * `fixtures/**`, `.github/**` and every root config, because those are public the moment this
 * repo gets a remote (Task 14), not only the npm tarballs. `git ls-files` already gives exactly
 * that surface (tracked, respects .gitignore) minus the two excluded prefixes.
 *
 * Banned list is names that IDENTIFY (an org, or a consumer repo/plugin) — not ordinary English
 * words. `monorepo`/`framework`/`gcs` were tried and reverted (Ruling 46): they read fine in
 * canon's own docs and would make this gate permanently red or force stilted prose for no
 * safety gain (the owning org name is already banned on its own).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { expect, test } from 'bun:test';

const ROOT = join(import.meta.dir, '..');
const SELF = relative(ROOT, import.meta.path);

// Excluded because they're internal SDD documents, deleted before the orphan-history publish
// (spec §8 step 1) — not part of what ships, ever.
const EXCLUDED_PREFIXES = ['docs/plans/', 'docs/specs/'];

// Identifiers only: an org name, or a consumer repo/plugin name. Not ordinary vocabulary
// (Ruling 46 — `monorepo`/`framework`/`gcs` were removed for exactly that reason).
const BANNED_NAMES = [
	'liqcx',
	'liqu-fi',
	'yevaops',
	'ops-platform',
	'dev-agent',
	'combat-log',
	'combat-strength',
	'orbat',
	'kwenta',
	'synthetix',
];

function bannedPattern(): RegExp {
	const alts = BANNED_NAMES.map((w) => w.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&'));
	return new RegExp(`\\b(?:${alts.join('|')})\\b`, 'gi');
}

function trackedFiles(): string[] {
	const out = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
	return out
		.split('\n')
		.filter((f) => f.length > 0)
		.filter((f) => !EXCLUDED_PREFIXES.some((p) => f.startsWith(p)))
		.filter((f) => f !== SELF); // this file's own banned-list data, not a leak
}

test('публикуемая поверхность (git-tracked, минус docs/plans и docs/specs) не содержит имён приватных организаций/репозиториев потребителей', () => {
	const pattern = bannedPattern();
	const hits: string[] = [];
	for (const file of trackedFiles()) {
		let text: string;
		try {
			text = readFileSync(join(ROOT, file), 'utf8');
		} catch {
			continue; // binary or unreadable — not a text leak
		}
		const lines = text.split('\n');
		for (let i = 0; i < lines.length; i++) {
			pattern.lastIndex = 0;
			const m = pattern.exec(lines[i] ?? '');
			if (m) hits.push(`${file}:${i + 1}: "${m[0]}" — ${lines[i]?.trim()}`);
		}
	}
	expect(hits).toEqual([]);
});
