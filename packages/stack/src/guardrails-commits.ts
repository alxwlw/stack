import {
	failureReason,
	type GuardrailRun,
	type GuardrailViolation,
	type Unavailable,
} from './guardrails-port.ts';

export function mergeBaseArgv(base: string): string[] {
	return ['merge-base', base, 'HEAD'];
}

const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export function mergeBase(run: GuardrailRun, base: string): string | Unavailable {
	if (run.code !== 0) return { unavailable: `git merge-base ${base} HEAD: ${failureReason(run)}` };
	const sha = run.out.trim();
	if (!COMMIT.test(sha)) return { unavailable: `git merge-base ${base} HEAD printed no commit` };
	return sha;
}

export type CommitsPart =
	| { skipped: string }
	| Unavailable
	| { range: string; violations: GuardrailViolation[] };
