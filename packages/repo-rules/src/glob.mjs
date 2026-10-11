// @ts-check
/**
 * Minimal glob → RegExp for repo-relative POSIX paths: `**`, `*`, `?`, `{a,b}`.
 * Node 20 has neither `path.matchesGlob` nor `fs.globSync`, so the package carries its own.
 */

/**
 * @param {string} glob
 * @returns {RegExp}
 */
export function globToRegExp(glob) {
	let re = '';
	let i = 0;
	/** @type {number} */
	let braces = 0;
	while (i < glob.length) {
		const c = glob[i];
		if (c === '*') {
			if (glob[i + 1] === '*') {
				const atStart = i === 0 || glob[i - 1] === '/';
				const slashAfter = glob[i + 2] === '/';
				if (atStart && slashAfter) {
					re += '(?:.*/)?';
					i += 3;
					continue;
				}
				if (atStart && i + 2 === glob.length) {
					re += '.*';
					i += 2;
					continue;
				}
				re += '.*';
				i += 2;
				continue;
			}
			re += '[^/]*';
		} else if (c === '?') {
			re += '[^/]';
		} else if (c === '{') {
			re += '(?:';
			braces += 1;
		} else if (c === '}' && braces > 0) {
			re += ')';
			braces -= 1;
		} else if (c === ',' && braces > 0) {
			re += '|';
		} else {
			re += /** @type {string} */ (c).replace(/[.+^$()|[\]\\]/g, '\\$&');
		}
		i += 1;
	}
	return new RegExp(`^${re}$`);
}

/**
 * @param {string[]} globs
 * @returns {(path: string) => boolean}
 */
export function matcher(globs) {
	const res = globs.map(globToRegExp);
	return (path) => res.some((r) => r.test(path));
}
