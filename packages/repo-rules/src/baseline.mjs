// @ts-check
/** `.repo-rules-baseline.json` (spec § 3). */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_RULES } from './config.mjs';
import { RepoRulesError } from './git.mjs';

export const BASELINE_FILE = '.repo-rules-baseline.json';

/** @typedef {import('./config.mjs').RepoRule} RepoRule */
/** @typedef {Record<RepoRule, Record<string, number>>} Counts */
/** @typedef {import('./scan.mjs').Violation} Violation */

/** @returns {Counts} */
export const emptyCounts = () => ({
	'max-lines': {},
	'suppression-reason': {},
	'focused-skipped-tests': {},
	'number-or-default': {},
});

/**
 * @param {string} root
 * @returns {Counts | null} null when the file does not exist
 */
export function loadBaseline(root) {
	const path = join(root, BASELINE_FILE);
	if (!existsSync(path)) return null;
	let raw;
	try {
		raw = JSON.parse(readFileSync(path, 'utf8'));
	} catch (e) {
		throw new RepoRulesError(`${BASELINE_FILE}: not JSON (${/** @type {Error} */ (e).message})`);
	}
	if (raw === null || typeof raw !== 'object' || raw.version !== 1) {
		throw new RepoRulesError(`${BASELINE_FILE}: version must be 1`);
	}
	for (const key of Object.keys(raw)) {
		if (key !== 'version' && key !== 'rules')
			throw new RepoRulesError(`${BASELINE_FILE}: unknown field «${key}»`);
	}
	const rules = raw.rules ?? {};
	if (typeof rules !== 'object' || Array.isArray(rules))
		throw new RepoRulesError(`${BASELINE_FILE}: rules must be an object`);
	const counts = emptyCounts();
	for (const [rule, files] of Object.entries(rules)) {
		if (!REPO_RULES.includes(/** @type {RepoRule} */ (rule))) {
			throw new RepoRulesError(`${BASELINE_FILE}: unknown rule «${rule}»`);
		}
		if (files === null || typeof files !== 'object' || Array.isArray(files)) {
			throw new RepoRulesError(`${BASELINE_FILE}: rules.${rule} must map paths to counts`);
		}
		for (const [path, n] of Object.entries(files)) {
			if (!Number.isInteger(n) || n < 1) {
				throw new RepoRulesError(
					`${BASELINE_FILE}: rules.${rule}["${path}"] must be a positive integer`,
				);
			}
			counts[/** @type {RepoRule} */ (rule)][path] = n;
		}
	}
	return counts;
}

/**
 * @typedef {object} Comparison
 * @property {Violation[]} violations  places in files over their baseline
 * @property {{ rule: RepoRule, path: string, baseline: number, actual: number }[]} stale
 */

/**
 * @param {Counts} actual
 * @param {Violation[]} hits
 * @param {Counts} baseline
 * @returns {Comparison}
 */
export function compare(actual, hits, baseline) {
	/** @type {Comparison} */
	const out = { violations: [], stale: [] };
	for (const rule of REPO_RULES) {
		for (const [path, n] of Object.entries(actual[rule])) {
			const b = baseline[rule][path];
			if (b === undefined || n > b) {
				for (const h of hits) {
					if (h.rule === rule && h.path === path) {
						out.violations.push(
							b === undefined ? h : { ...h, message: `${h.message} (baseline ${b})` },
						);
					}
				}
			}
		}
		for (const [path, b] of Object.entries(baseline[rule])) {
			const n = actual[rule][path] ?? 0;
			if (n < b) out.stale.push({ rule, path, baseline: b, actual: n });
		}
	}
	return out;
}

/**
 * Entries that would rise or appear if `next` replaced `prev`.
 * @param {Counts} prev
 * @param {Counts} next
 * @returns {{ rule: RepoRule, path: string, from: number, to: number }[]}
 */
export function growth(prev, next) {
	/** @type {{ rule: RepoRule, path: string, from: number, to: number }[]} */
	const up = [];
	for (const rule of REPO_RULES) {
		for (const [path, n] of Object.entries(next[rule])) {
			const b = prev[rule][path] ?? 0;
			if (n > b) up.push({ rule, path, from: b, to: n });
		}
	}
	return up;
}

/**
 * Keys sorted, the existing file's indentation kept (tab or two spaces), trailing newline.
 * @param {string} root
 * @param {Counts} counts
 */
export function writeBaseline(root, counts) {
	const path = join(root, BASELINE_FILE);
	let indent = '  ';
	if (existsSync(path) && /^\t/m.test(readFileSync(path, 'utf8'))) indent = '\t';
	/** @type {Record<string, Record<string, number>>} */
	const rules = {};
	for (const rule of REPO_RULES) {
		const files = Object.keys(counts[rule]).sort();
		if (!files.length) continue;
		rules[rule] = Object.fromEntries(
			files.map((f) => [f, /** @type {number} */ (counts[rule][f])]),
		);
	}
	writeFileSync(path, `${JSON.stringify({ version: 1, rules }, null, indent)}\n`);
}
