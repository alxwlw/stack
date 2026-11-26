// Правило группы repo-rules: находки и пометки из исхода двух вызовов repo-rules. Чистые функции над
// значениями; сами вызовы и разбор — repo-rules.ts.

import type { Finding } from './findings.ts';
import type { RepoRulesOutcome, RepoRulesPart } from './repo-rules.ts';

const TRAILER_HINT =
	'repo-rules diff: intended? add a commit trailer "Tests-Removed: <reason>" in the range';

function partFindings(part: RepoRulesPart | { skipped: string }, target: string): Finding[] {
	if ('skipped' in part) return [];
	if ('unavailable' in part) {
		return [{ code: 'repo-rules-unavailable', target, message: part.unavailable }];
	}
	return [
		...part.violations.map((v): Finding => ({
			code: 'repo-rules-violation',
			target: v.line > 0 ? `${v.path}:${v.line}` : v.path,
			message: `${v.rule}: ${v.message}`,
		})),
		...part.stale.map((s): Finding => ({
			code: 'stale-repo-rules-baseline',
			target: s.path,
			message: `${s.rule}: recorded ${s.baseline}, now ${s.actual}; lower it with: stack repo-rules baseline`,
		})),
	];
}

export function checkRepoRules(outcome: RepoRulesOutcome | undefined): Finding[] {
	if (outcome === undefined) throw new Error('checkRepoRules: no repo-rules outcome');
	return [
		...partFindings(outcome.check, 'repo-rules check'),
		...partFindings(outcome.diff, 'repo-rules diff'),
	];
}

// Пометка — часть проверки, которая пропущена или о чём стоит знать; выход она не меняет.
export function repoRulesNotes(outcome: RepoRulesOutcome | undefined): string[] {
	if (outcome === undefined) return [];
	const notes: string[] = [];
	if (!('unavailable' in outcome.check)) {
		for (const n of outcome.check.notes) notes.push(`repo-rules check: ${n}`);
	}
	const diff = outcome.diff;
	if ('skipped' in diff) notes.push(`repo-rules diff: skipped (${diff.skipped})`);
	else if (!('unavailable' in diff)) {
		for (const n of diff.notes) notes.push(`repo-rules diff: ${n}`);
		if (diff.violations.length > 0) notes.push(TRAILER_HINT);
	}
	return notes;
}
