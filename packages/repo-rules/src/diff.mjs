// @ts-check
/** `removed-assertions` (DP-014, spec § 4). */
import { git, RepoRulesError } from './git.mjs';
import { matcher } from './glob.mjs';
import { hasReason } from './source.mjs';

/** @typedef {import('./config.mjs').Config} Config */

const JS_ASSERT = /\bexpect\s*\(|\bassert\s*\(|\bassert\.\w+\s*\(/g;
const SOL_ASSERT = /\bassert[A-Z]\w*\s*\(/g;
const PY_ASSERT = /^\s*assert\b|\bself\.assert[A-Z]\w*\s*\(/g;

/**
 * @param {string} path
 * @returns {RegExp | null}
 */
function assertionPattern(path) {
	if (/\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(path)) return JS_ASSERT;
	if (path.endsWith('.sol')) return SOL_ASSERT;
	if (path.endsWith('.py')) return PY_ASSERT;
	return null;
}

/**
 * @param {string} text
 * @param {RegExp} re
 */
const countIn = (text, re) => [...text.matchAll(re)].length;

/**
 * @typedef {object} PairCount
 * @property {string | null} from
 * @property {string | null} to
 * @property {number} removed
 * @property {number} added
 */

/**
 * Parse `git diff -M --unified=0` into per-pair assertion counts for test files.
 * @param {string} diff
 * @param {(path: string) => boolean} isTest
 * @returns {PairCount[]}
 */
export function countPairs(diff, isTest) {
	/** @type {PairCount[]} */
	const pairs = [];
	/** @type {PairCount | null} */
	let cur = null;
	/** @type {RegExp | null} */
	let re = null;
	let inHunk = false;
	for (const line of diff.split('\n')) {
		if (line.startsWith('diff --git ')) {
			cur = { from: null, to: null, removed: 0, added: 0 };
			pairs.push(cur);
			re = null;
			inHunk = false;
			continue;
		}
		if (!cur) continue;
		if (!inHunk) {
			if (line.startsWith('--- ')) cur.from = line === '--- /dev/null' ? null : line.slice(6);
			else if (line.startsWith('+++ ')) {
				cur.to = line === '+++ /dev/null' ? null : line.slice(6);
				const p = cur.to ?? cur.from;
				const tested =
					(cur.from !== null && isTest(cur.from)) || (cur.to !== null && isTest(cur.to));
				re = p !== null && tested ? assertionPattern(p) : null;
			} else if (line.startsWith('rename from ')) cur.from = line.slice(12);
			else if (line.startsWith('rename to ')) cur.to = line.slice(10);
			else if (line.startsWith('@@')) inHunk = true;
			continue;
		}
		if (line.startsWith('@@')) continue;
		if (!re) continue;
		if (line.startsWith('-')) cur.removed += countIn(line.slice(1), re);
		else if (line.startsWith('+')) cur.added += countIn(line.slice(1), re);
	}
	return pairs.filter((p) => p.removed > 0 || p.added > 0);
}

/**
 * @typedef {object} DiffResult
 * @property {{ path: string, removed: number, added: number }[]} violations
 * @property {string[]} reasons  `Tests-Removed` trailers of the range
 * @property {boolean} skipped
 */

/**
 * @param {string} root
 * @param {Config} cfg
 * @param {string | undefined} base
 * @param {NodeJS.ProcessEnv} env
 * @returns {DiffResult}
 */
export function removedAssertions(root, cfg, base, env) {
	if (!base) {
		const actions = env.GITHUB_ACTIONS === 'true';
		const pr =
			env.GITHUB_EVENT_NAME === 'pull_request' || env.GITHUB_EVENT_NAME === 'pull_request_target';
		if (actions && !pr) return { violations: [], reasons: [], skipped: true };
		// In a pull_request job the base is known: the same command line works in every repo's CI.
		if (actions && env.GITHUB_BASE_REF) base = `origin/${env.GITHUB_BASE_REF}`;
		else throw new RepoRulesError('diff needs --base <ref>');
	}
	const mb = git(root, ['merge-base', base, 'HEAD']).trim();
	const diff = git(root, ['diff', '-M', '--unified=0', '--no-color', '--no-ext-diff', mb, 'HEAD']);
	const pairs = countPairs(diff, matcher(cfg.testGlobs));
	const reasons = git(root, [
		'log',
		'--format=%(trailers:key=Tests-Removed,valueonly,separator=%x00)',
		`${mb}..HEAD`,
	])
		.split(/\0|\n/)
		.map((s) => s.trim())
		.filter((s) => hasReason(s));
	return { violations: reasons.length ? [] : judge(pairs), reasons, skipped: false };
}

/**
 * Modified and renamed pairs are judged one by one. Deleted test files are judged together
 * against the new test files of the range: a module moved under a new name (too changed for
 * rename detection) shows up as one deletion plus one addition.
 * @param {PairCount[]} pairs
 * @returns {{ path: string, removed: number, added: number }[]}
 */
export function judge(pairs) {
	/** @type {{ path: string, removed: number, added: number }[]} */
	const out = [];
	for (const p of pairs) {
		if (p.from !== null && p.to !== null && p.removed > p.added) {
			out.push({
				path: p.from === p.to ? p.from : `${p.from} → ${p.to}`,
				removed: p.removed,
				added: p.added,
			});
		}
	}
	const deleted = pairs.filter((p) => p.to === null);
	const removed = deleted.reduce((n, p) => n + p.removed, 0);
	const added = pairs.filter((p) => p.from === null).reduce((n, p) => n + p.added, 0);
	if (removed > added) {
		for (const p of deleted) out.push({ path: `${p.from} (deleted)`, removed: p.removed, added });
	}
	return out;
}
