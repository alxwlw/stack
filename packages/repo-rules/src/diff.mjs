// @ts-check
/** `removed-assertions` (DP-014, spec § 4). */
import { git, RepoRulesError } from './git.mjs';
import { matcher } from './glob.mjs';
import { commentStart, familyOf, hasReason } from './source.mjs';

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
 * The code of a diff line: its comments cut out (DP-030). A `/* … *\/` closed on the same line is
 * whitespace and the code after it stays; `//`, an unclosed `/*`, a leading `*` and Python `#` cut to the end.
 * @param {string} text
 * @param {import('./source.mjs').Family} family
 * @returns {string}
 */
function codeOf(text, family) {
	let code = '';
	let rest = text;
	// After the first span the rest is no line start: the `;` keeps a `*` there from reading as a continuation.
	let pad = '';
	for (;;) {
		const c = commentStart(pad + rest, family);
		if (c < 0) return code + rest;
		const cut = c - pad.length;
		const end = !rest.startsWith('/*', cut) ? -1 : rest.indexOf('*/', cut + 2);
		if (end < 0) return code + rest.slice(0, cut);
		code += `${rest.slice(0, cut)} `;
		rest = rest.slice(end + 2);
		pad = ';';
	}
}

/**
 * Assertions in the code part of a diff line: a commented-out `// expect(…)` is not one (DP-030).
 * @param {string} text
 * @param {Side} side
 */
function countIn(text, side) {
	return [...(side.family ? codeOf(text, side.family) : text).matchAll(side.re)].length;
}

/** @type {Record<string, string>} */
const C_ESCAPES = { a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r' };

/**
 * A name as git prints it on a header line: C-quoted (`"…"`, `\` escapes) when it holds a control
 * character, `"` or `\`; a `---`/`+++` name with a space is followed by a TAB.
 * @param {string} text
 * @returns {string}
 */
function gitPath(text) {
	const t = text.endsWith('\t') ? text.slice(0, -1) : text;
	if (!t.startsWith('"')) return t;
	return t
		.slice(1, -1)
		.replace(/\\([0-7]{3}|.)/g, (_, /** @type {string} */ esc) =>
			esc.length === 3 ? String.fromCharCode(Number.parseInt(esc, 8)) : (C_ESCAPES[esc] ?? esc),
		);
}

/** @typedef {{ re: RegExp, family: import('./source.mjs').Family | null }} Side */

/**
 * The counting rule of one side of a pair, by that side's own path; null when it is no test.
 * @param {string | null} path
 * @param {boolean} tested
 * @returns {Side | null}
 */
function sideOf(path, tested) {
	const re = path !== null && tested ? assertionPattern(path) : null;
	return re && path !== null ? { re, family: familyOf(path) } : null;
}

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
	/** @type {Side | null} */
	let del = null;
	/** @type {Side | null} */
	let ins = null;
	let inHunk = false;
	for (const line of diff.split('\n')) {
		if (line.startsWith('diff --git ')) {
			cur = { from: null, to: null, removed: 0, added: 0 };
			pairs.push(cur);
			del = ins = null;
			inHunk = false;
			continue;
		}
		if (!cur) continue;
		if (!inHunk) {
			// `a/` and `b/` are set explicitly in `removedAssertions`, whatever `diff.noprefix` says.
			if (line.startsWith('--- '))
				cur.from = line === '--- /dev/null' ? null : gitPath(line.slice(4)).slice(2);
			else if (line.startsWith('+++ ')) {
				cur.to = line === '+++ /dev/null' ? null : gitPath(line.slice(4)).slice(2);
			} else if (line.startsWith('rename from ')) cur.from = gitPath(line.slice(12));
			else if (line.startsWith('rename to ')) cur.to = gitPath(line.slice(10));
			else if (line.startsWith('@@')) {
				inHunk = true;
				// Each side is read in its own language: a rename may change it, e.g. a Python test ported to TypeScript.
				const tested =
					(cur.from !== null && isTest(cur.from)) || (cur.to !== null && isTest(cur.to));
				del = sideOf(cur.from, tested);
				ins = sideOf(cur.to, tested);
			}
			continue;
		}
		if (line.startsWith('@@')) continue;
		if (line.startsWith('-') && del) cur.removed += countIn(line.slice(1), del);
		else if (line.startsWith('+') && ins) cur.added += countIn(line.slice(1), ins);
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
	const diff = git(root, [
		'diff',
		'-M',
		'--unified=0',
		'--no-color',
		'--src-prefix=a/',
		'--dst-prefix=b/',
		'--no-ext-diff',
		'--no-textconv',
		mb,
		'HEAD',
	]);
	const excluded = matcher([
		...(cfg.exclude['*'] ?? []),
		...(cfg.exclude['removed-assertions'] ?? []),
	]);
	const pairs = countPairs(diff, matcher(cfg.testGlobs)).filter(
		(p) => ![p.from, p.to].every((path) => path === null || excluded(path)),
	);
	const reasons = git(root, [
		'log',
		// `log.showSignature` would print «Good signature» lines on stdout: not a trailer.
		'--no-show-signature',
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
