import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { type Profile, STACK_CONFIG_FILE, StackConfigError } from './config.ts';

// oxfmt (canon .oxfmtrc.jsonc, printWidth 100) collapses a short JSON array onto one line;
// plain `JSON.stringify(…, null, '\t')` never does. Without this, the file `stack init` just
// created fails the very `oxfmt --check` gate canon seeds in the same `sync` — a repo's first
// `moon run :format` after adopting the canon goes red on canon's own seed, before a single line
// of product code changed. ponytail: hand-collapsed for this fixed 4-field shape, only holds
// while `with` stays short enough to fit printWidth (today's known groups all do); a group list
// long enough to wrap would need real oxfmt-style width math, not string-length arithmetic.
function jsonArrayLine(items: readonly string[]): string {
	return `[${items.map((s) => JSON.stringify(s)).join(', ')}]`;
}

export function initConfig(repoRoot: string, opts: { profile: Profile; with?: string[] }): string {
	const path = join(repoRoot, STACK_CONFIG_FILE);
	if (existsSync(path)) throw new StackConfigError(`${STACK_CONFIG_FILE} already exists`);
	const body =
		'{\n' +
		'\t"$schema": "./node_modules/@alxwlw/stack/schema.json",\n' +
		`\t"profile": ${JSON.stringify(opts.profile)},\n` +
		`\t"with": ${jsonArrayLine(opts.with ?? [])},\n` +
		'\t"exceptions": [],\n' +
		'}\n';
	writeFileSync(path, body);
	return path;
}
