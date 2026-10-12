// @ts-check
/** Run the § 2 rules over every tracked file. */
import { MAX_LINES_EXCLUDE } from './config.mjs';
import { countLines, readText, trackedFiles } from './git.mjs';
import { matcher } from './glob.mjs';
import { focusedSkippedTests, numberOrDefault, suppressionReason } from './rules.mjs';
import { familyOf } from './source.mjs';

/** @typedef {import('./config.mjs').Config} Config */
/** @typedef {import('./config.mjs').RepoRule} RepoRule */
/** @typedef {{ rule: RepoRule, path: string, line: number, message: string }} Violation */

/**
 * @typedef {object} ScanResult
 * @property {Violation[]} hits                          every flagged place
 * @property {Record<RepoRule, Record<string, number>>} actual  rule → path → value (line count for max-lines, else hits)
 */

/**
 * @param {string} root
 * @param {Config} cfg
 * @returns {ScanResult}
 */
export function scan(root, cfg) {
	const anyExcluded = matcher(cfg.exclude['*'] ?? []);
	/** @type {(rule: RepoRule) => (path: string) => boolean} */
	const excludedFor = (rule) => {
		const own = matcher([
			...(rule === 'max-lines' ? MAX_LINES_EXCLUDE : []),
			...(cfg.exclude[rule] ?? []),
		]);
		return (path) => anyExcluded(path) || own(path);
	};
	const ex = {
		'max-lines': excludedFor('max-lines'),
		'suppression-reason': excludedFor('suppression-reason'),
		'focused-skipped-tests': excludedFor('focused-skipped-tests'),
		'number-or-default': excludedFor('number-or-default'),
	};
	const isTest = matcher(cfg.testGlobs);
	/** @type {ScanResult} */
	const res = {
		hits: [],
		actual: {
			'max-lines': {},
			'suppression-reason': {},
			'focused-skipped-tests': {},
			'number-or-default': {},
		},
	};
	/**
	 * @param {RepoRule} rule
	 * @param {string} path
	 * @param {{ line: number, message: string }[]} hits
	 */
	const add = (rule, path, hits) => {
		if (!hits.length) return;
		res.actual[rule][path] = hits.length;
		for (const h of hits) res.hits.push({ rule, path, ...h });
	};
	for (const path of trackedFiles(root)) {
		const family = familyOf(path);
		const wantLines = !ex['max-lines'](path);
		if (!wantLines && !family) continue;
		const text = readText(root, path);
		if (text === null) continue;
		if (wantLines) {
			const n = countLines(text);
			if (n > cfg.maxLines) {
				res.actual['max-lines'][path] = n;
				res.hits.push({
					rule: 'max-lines',
					path,
					line: cfg.maxLines + 1,
					message: `${n} lines (limit ${cfg.maxLines})`,
				});
			}
		}
		if (!family) continue;
		const lines = text.split('\n');
		if (!ex['suppression-reason'](path))
			add('suppression-reason', path, suppressionReason(lines, family));
		if (family !== 'js') continue;
		const test = isTest(path);
		if (test && !ex['focused-skipped-tests'](path))
			add('focused-skipped-tests', path, focusedSkippedTests(lines));
		if (!test && !ex['number-or-default'](path))
			add('number-or-default', path, numberOrDefault(lines));
	}
	return res;
}
