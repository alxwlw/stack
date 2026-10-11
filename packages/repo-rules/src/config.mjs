// @ts-check
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { RepoRulesError } from './git.mjs';
import { globToRegExp } from './glob.mjs';

export const CONFIG_FILE = '.repo-rules.json';

/** Rules that scan the whole repository (spec § 2). */
export const REPO_RULES = /** @type {const} */ ([
	'max-lines',
	'suppression-reason',
	'focused-skipped-tests',
	'number-or-default',
]);

/** @typedef {(typeof REPO_RULES)[number]} RepoRule */

/** `exclude` also takes the `diff` rule (spec § 5): it is not a whole-repo rule, so not in `REPO_RULES`. */
const EXCLUDE_KEYS = ['*', 'removed-assertions', ...REPO_RULES];

export const DEFAULT_MAX_LINES = 800;

/** Spec § 2, `max-lines` default exclusions. */
export const MAX_LINES_EXCLUDE = [
	'docs/**/plans/**',
	'**/pnpm-lock.yaml',
	'**/package-lock.json',
	'**/yarn.lock',
	'**/bun.lock',
	'**/*.lock',
	'**/*.json',
	'**/*.d.ts',
	'**/*.snap',
	'**/__snapshots__/**',
	'**/*.min.*',
	'**/*.map',
	'**/*.svg',
	'**/generated/**',
	'**/*.gen.*',
	'**/dist/**',
	'**/build/**',
	'**/coverage/**',
	'**/vendor/**',
	'**/third_party/**',
	'**/CHANGELOG.md',
	'**/migrations/**/*.sql',
];

/** Spec § 5, default `testGlobs`. */
export const DEFAULT_TEST_GLOBS = [
	'**/*.{test,spec}.*',
	'**/__tests__/**',
	'**/test/**',
	'**/tests/**',
	'**/*.t.sol',
	'**/test_*.py',
	'**/*_test.py',
];

/**
 * @typedef {object} Config
 * @property {number} maxLines
 * @property {Record<string, string[]>} exclude  key `*` or a rule name
 * @property {string[]} testGlobs
 */

/**
 * @param {unknown} v
 * @returns {v is string[]}
 */
const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

/**
 * Compile every glob once, so a malformed one is a config error naming its field.
 * @param {string[]} globs
 * @param {string} field
 * @returns {void}
 */
function checkGlobs(globs, field) {
	for (const g of globs) {
		try {
			globToRegExp(g);
		} catch (e) {
			throw new RepoRulesError(`${CONFIG_FILE}: ${field}: ${/** @type {Error} */ (e).message}`);
		}
	}
}

/**
 * Read `.repo-rules.json` (optional) and merge it over the defaults.
 * @param {string} root
 * @returns {Config}
 */
export function loadConfig(root) {
	/** @type {Config} */
	const cfg = { maxLines: DEFAULT_MAX_LINES, exclude: {}, testGlobs: DEFAULT_TEST_GLOBS };
	const path = join(root, CONFIG_FILE);
	if (!existsSync(path)) return cfg;
	let raw;
	try {
		raw = JSON.parse(readFileSync(path, 'utf8'));
	} catch (e) {
		throw new RepoRulesError(`${CONFIG_FILE}: not JSON (${/** @type {Error} */ (e).message})`);
	}
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new RepoRulesError(`${CONFIG_FILE}: top level is not an object`);
	}
	for (const key of Object.keys(raw)) {
		if (!['maxLines', 'exclude', 'testGlobs'].includes(key)) {
			throw new RepoRulesError(`${CONFIG_FILE}: unknown field «${key}»`);
		}
	}
	if ('maxLines' in raw) {
		if (!Number.isInteger(raw.maxLines) || raw.maxLines < 1) {
			throw new RepoRulesError(`${CONFIG_FILE}: maxLines must be a positive integer`);
		}
		cfg.maxLines = raw.maxLines;
	}
	if ('exclude' in raw) {
		const ex = raw.exclude;
		if (ex === null || typeof ex !== 'object' || Array.isArray(ex)) {
			throw new RepoRulesError(`${CONFIG_FILE}: exclude must map «*» or a rule name to globs`);
		}
		for (const [k, v] of Object.entries(ex)) {
			if (!EXCLUDE_KEYS.includes(k)) {
				throw new RepoRulesError(`${CONFIG_FILE}: exclude: unknown rule «${k}»`);
			}
			if (!isStringArray(v))
				throw new RepoRulesError(`${CONFIG_FILE}: exclude.${k} must be a list of globs`);
		}
		for (const [k, v] of Object.entries(ex)) checkGlobs(v, `exclude.${k}`);
		cfg.exclude = ex;
	}
	if ('testGlobs' in raw) {
		if (!isStringArray(raw.testGlobs))
			throw new RepoRulesError(`${CONFIG_FILE}: testGlobs must be a list of globs`);
		checkGlobs(raw.testGlobs, 'testGlobs');
		cfg.testGlobs = raw.testGlobs;
	}
	return cfg;
}
