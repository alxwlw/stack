// @ts-check
/** Language families and the comment/code split of one line (spec § 2). */

/** @typedef {'js' | 'sol' | 'py'} Family */

const JS_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|vue|svelte)$/;

/**
 * @param {string} path
 * @returns {Family | null}
 */
export function familyOf(path) {
	if (path.endsWith('.d.ts')) return null;
	if (JS_EXT.test(path)) return 'js';
	if (path.endsWith('.sol')) return 'sol';
	if (path.endsWith('.py')) return 'py';
	return null;
}

/**
 * Index where the line's comment starts, outside string literals; -1 when there is none.
 * A line that starts with `*` (block-comment continuation, JS/Sol) is a comment from 0.
 * Strings are tracked within the line only: `'`, `"`, and `` ` `` (not for Python) with `\` escapes.
 * @param {string} line
 * @param {Family} family
 * @returns {number}
 */
export function commentStart(line, family) {
	if (family !== 'py' && /^\s*\*/.test(line)) return line.search(/\*/);
	/** @type {string | null} */
	let quote = null;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (quote) {
			if (c === '\\') i++;
			else if (c === quote) quote = null;
			continue;
		}
		if (c === '"' || c === "'" || (c === '`' && family !== 'py')) {
			quote = c;
			continue;
		}
		if (family === 'py') {
			if (c === '#') return i;
		} else if (c === '/' && (line[i + 1] === '/' || line[i + 1] === '*')) {
			return i;
		}
	}
	return -1;
}

/**
 * At least three non-space characters.
 * @param {string | undefined} text
 * @returns {boolean}
 */
export function hasReason(text) {
	return (text ?? '').replace(/\*\/|-->|\}/g, '').replace(/\s/g, '').length >= 3;
}

/**
 * The reason after a ` -- ` separator, if any.
 * @param {string} text
 * @returns {string | undefined}
 */
export function dashReason(text) {
	const m = /(?:^|\s)--\s(.*)$/.exec(text);
	return m ? m[1] : undefined;
}
