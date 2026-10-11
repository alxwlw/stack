// @ts-check
/** The CLI as a function: `run(argv, env, out)` → exit code (spec § 1). */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import {
	BASELINE_FILE,
	compare,
	emptyCounts,
	growth,
	loadBaseline,
	writeBaseline,
} from './baseline.mjs';
import { loadConfig, REPO_RULES } from './config.mjs';
import { removedAssertions } from './diff.mjs';
import { repoRoot, RepoRulesError } from './git.mjs';
import { scan } from './scan.mjs';

const USAGE = `usage: repo-rules [-C <dir>] check [--json]
       repo-rules [-C <dir>] diff [--base <ref>] [--json]
       repo-rules [-C <dir>] baseline [--init] [--allow-grow]`;

/** @param {string[]} argv */
function parseOptions(argv) {
	return parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			C: { type: 'string', short: 'C' },
			json: { type: 'boolean' },
			base: { type: 'string' },
			init: { type: 'boolean' },
			'allow-grow': { type: 'boolean' },
			help: { type: 'boolean', short: 'h' },
			version: { type: 'boolean' },
		},
	});
}

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @param {(s: string) => void} out  stdout line
 * @param {(s: string) => void} err  stderr line: the usage after a wrong command line
 * @returns {number} exit code
 */
export function run(argv, env, out, err) {
	/** @type {ReturnType<typeof parseOptions>} */
	let parsed;
	try {
		parsed = parseOptions(argv);
	} catch (e) {
		throw new RepoRulesError(`${/** @type {Error} */ (e).message}\n${USAGE}`);
	}
	const { values, positionals } = parsed;
	if (values.version) {
		const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
		out(pkg.version);
		return 0;
	}
	const cmd = positionals[0];
	if (values.help) {
		out(USAGE);
		return 0;
	}
	if (!cmd || !['check', 'diff', 'baseline'].includes(cmd)) {
		err(USAGE);
		return 2;
	}
	const root = repoRoot(values.C ?? process.cwd());
	const cfg = loadConfig(root);

	if (cmd === 'check') {
		const res = scan(root, cfg);
		const baseline = loadBaseline(root) ?? emptyCounts();
		const cmp = compare(res.actual, res.hits, baseline);
		if (values.json) {
			out(JSON.stringify({ violations: cmp.violations, stale: cmp.stale, notes: [] }, null, 2));
		} else {
			for (const v of cmp.violations) out(`${v.path}:${v.line}  ${v.rule}  ${v.message}`);
			for (const s of cmp.stale) {
				out(
					`${s.path}  ${s.rule}  baseline ${s.baseline}, now ${s.actual} — исключения устарели: repo-rules baseline`,
				);
			}
			out(
				`repo-rules: ${cmp.violations.length} violation(s), ${cmp.stale.length} stale, ${REPO_RULES.length} rule(s) checked`,
			);
		}
		return cmp.violations.length || cmp.stale.length ? 1 : 0;
	}

	if (cmd === 'diff') {
		const res = removedAssertions(root, cfg, values.base, env);
		const notes = [
			...(res.skipped ? ['skipped (not a pull request)'] : []),
			...res.reasons.map((r) => `Tests-Removed: ${r}`),
		];
		const violations = res.violations.map((v) => ({
			rule: 'removed-assertions',
			path: v.path,
			line: 0,
			message: `−${v.removed} / +${v.added} assertions`,
		}));
		if (values.json) out(JSON.stringify({ violations, stale: [], notes }, null, 2));
		else {
			for (const v of violations) out(`${v.path}  removed-assertions  ${v.message}`);
			for (const n of notes) out(`note  ${n}`);
			if (violations.length) {
				out('hint  intended? add a commit trailer «Tests-Removed: <reason>» in the range');
			}
			out(
				res.skipped
					? 'repo-rules diff: skipped (not a pull request)'
					: `repo-rules diff: ${violations.length} violation(s)`,
			);
		}
		return violations.length ? 1 : 0;
	}

	// Last command: `baseline`.
	const prev = loadBaseline(root);
	if (values.init && prev) throw new RepoRulesError(`${BASELINE_FILE} already exists`);
	if (!values.init && !prev)
		throw new RepoRulesError(`no ${BASELINE_FILE}: run repo-rules baseline --init`);
	const next = scan(root, cfg).actual;
	const up = prev ? growth(prev, next) : [];
	if (up.length && !values['allow-grow']) {
		for (const g of up) out(`${g.path}  ${g.rule}  ${g.from} → ${g.to}`);
		out(`repo-rules baseline: ${up.length} entr(ies) would grow — fix them or pass --allow-grow`);
		return 1;
	}
	writeBaseline(root, next);
	const total = REPO_RULES.reduce((n, r) => n + Object.keys(next[r]).length, 0);
	out(`repo-rules baseline: wrote ${BASELINE_FILE} (${total} entr(ies))`);
	return 0;
}
