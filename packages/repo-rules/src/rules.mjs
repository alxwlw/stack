// @ts-check
/** The whole-repo rules of spec § 2. Each returns the 1-based lines it flags. */
import { commentStart, dashReason, hasReason } from './source.mjs';

/** @typedef {import('./source.mjs').Family} Family */
/** @typedef {{ line: number, message: string }} Hit */

// A directive counts only right after the comment opener, as eslint/oxlint/tsc/solhint require.
const OPENER = String.raw`^(?:\/\/+|\/\*+|\*|\{\/\*)\s*`;
const LINT_DISABLE = new RegExp(
	`${OPENER}((?:eslint|oxlint)-disable(?:-next-line|-line)?)\\b(.*)$`,
);
const SOL_DISABLE = new RegExp(`${OPENER}(solhint-disable(?:-next-line|-line)?)\\b(.*)$`);
const BIOME = new RegExp(`${OPENER}(biome-ignore)\\b(.*)$`);
const TS_DIRECTIVE = new RegExp(`${OPENER}(@ts-(?:expect-error|ignore))\\b(.*)$`);
const PY_NOQA = /#\s*(noqa)(?::\s*[A-Z]+\d+(?:\s*,\s*[A-Z]+\d+)*)?(.*)$/;
const PY_TYPE_IGNORE = /#\s*(type:\s*ignore)(?:\[[^\]]*\])?(.*)$/;

/**
 * `suppression-reason` (DP-024).
 * @param {string[]} lines
 * @param {Family} family
 * @returns {Hit[]}
 */
export function suppressionReason(lines, family) {
	/** @type {Hit[]} */
	const hits = [];
	lines.forEach((raw, i) => {
		const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
		const c = commentStart(line, family);
		if (c < 0) return;
		const comment = line.slice(c);
		/** @type {[string, boolean] | null} */
		let found = null;
		if (family === 'py') {
			const m = PY_NOQA.exec(comment) ?? PY_TYPE_IGNORE.exec(comment);
			if (m)
				found = [
					/** @type {string} */ (m[1]).replace(/\s+/g, ' '),
					hasReason(dashReason(m[2] ?? '')),
				];
		} else {
			const lint = (family === 'sol' ? SOL_DISABLE : LINT_DISABLE).exec(comment);
			if (lint) found = [/** @type {string} */ (lint[1]), hasReason(dashReason(lint[2] ?? ''))];
			const biome = family === 'js' ? BIOME.exec(comment) : null;
			if (biome) {
				const colon = (biome[2] ?? '').indexOf(':');
				found = ['biome-ignore', colon >= 0 && hasReason((biome[2] ?? '').slice(colon + 1))];
			}
			const ts = family === 'js' ? TS_DIRECTIVE.exec(comment) : null;
			if (ts) found = [/** @type {string} */ (ts[1]), hasReason(ts[2])];
		}
		if (found && !found[1]) hits.push({ line: i + 1, message: `${found[0]} without a reason` });
	});
	return hits;
}

const TEST_NAMES = '(?:describe|it|test|suite|context|bench)';
const ONLY = new RegExp(`\\b${TEST_NAMES}\\.only(?:\\.each)?\\s*[(\`]`);
const SKIP = new RegExp(
	`\\b${TEST_NAMES}\\.(skip|todo)(?:\\.each)?\\s*[(\`]|\\b(xit|xdescribe|xtest)\\s*\\(`,
);

/**
 * `focused-skipped-tests` (DP-014, static part). JS/TS test files only.
 * @param {string[]} lines
 * @returns {Hit[]}
 */
export function focusedSkippedTests(lines) {
	/** @type {Hit[]} */
	const hits = [];
	lines.forEach((raw, i) => {
		const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
		const c = commentStart(line, 'js');
		const code = c < 0 ? line : line.slice(0, c);
		if (ONLY.test(code)) {
			hits.push({ line: i + 1, message: '.only in a test file' });
			return;
		}
		const m = SKIP.exec(code);
		if (!m) return;
		// `test.skip(cond, reason)` (Playwright) is a conditional skip, like `skipIf`: the first
		// argument is neither empty nor a title literal. An argument list that starts on the
		// next line is read from there.
		let arg = code.slice((m.index ?? 0) + m[0].length).trimStart();
		if (arg === '' && i + 1 < lines.length) arg = /** @type {string} */ (lines[i + 1]).trimStart();
		if (m[1] === 'skip' && !m[0].includes('.each') && arg !== '' && !/^[)'"`]/.test(arg)) return;
		const own = c < 0 ? '' : line.slice(c);
		const prev = i > 0 ? /** @type {string} */ (lines[i - 1]).replace(/\r$/, '') : '';
		const prevIsComment = /^\s*(?:\/\/|\/\*|\*)/.test(prev);
		if (hasReason(dashReason(own)) || (prevIsComment && hasReason(dashReason(prev)))) return;
		hits.push({ line: i + 1, message: `${m[1] ? `.${m[1]}` : m[2]} without a reason` });
	});
	return hits;
}

const NUMBER_CALL = /(?<![\w$.])(?:Number(?:\.parse(?:Int|Float))?|parseInt|parseFloat)\s*\(/g;
const LITERAL =
	/^\s*\|\|\s*(?:-?(?:0[xXbBoO][\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[^`]*`|null\b|undefined\b)/;

/**
 * Index of the `)` closing the `(` at `open`, strings respected; -1 when it is not on this line.
 * @param {string} line
 * @param {number} open
 * @returns {number}
 */
function closingParen(line, open) {
	let depth = 0;
	/** @type {string | null} */
	let quote = null;
	for (let i = open; i < line.length; i++) {
		const c = line[i];
		if (quote) {
			if (c === '\\') i++;
			else if (c === quote) quote = null;
		} else if (c === '"' || c === "'" || c === '`') quote = c;
		else if (c === '(') depth++;
		else if (c === ')' && --depth === 0) return i;
	}
	return -1;
}

/**
 * `number-or-default` (DP-037, narrow pattern). JS/TS non-test files.
 * @param {string[]} lines
 * @returns {Hit[]}
 */
export function numberOrDefault(lines) {
	/** @type {Hit[]} */
	const hits = [];
	lines.forEach((raw, i) => {
		const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
		const c = commentStart(line, 'js');
		const code = c < 0 ? line : line.slice(0, c);
		for (const m of code.matchAll(NUMBER_CALL)) {
			const close = closingParen(code, (m.index ?? 0) + m[0].length - 1);
			if (close < 0) continue;
			const lit = LITERAL.exec(code.slice(close + 1));
			// `|| 0` conflates nothing: NaN and a real 0 both become 0.
			if (lit && !/\|\|\s*-?0(?:\.0+)?$/.test(lit[0])) {
				hits.push({
					line: i + 1,
					message: `${m[0].replace(/\s*\($/, '')}(…) || <literal> treats 0/NaN as missing`,
				});
			}
		}
	});
	return hits;
}
