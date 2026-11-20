import {
	failureReason,
	type GuardrailRun,
	type GuardrailViolation,
	type Unavailable,
} from './guardrails-port.ts';

// База PR для скана коммитов: явный --base, иначе окружение GitHub Actions. Пропуск — не ошибка
// (код выхода не меняется), недоступная база PR-задачи — ошибка, а не «нет дрейфа».
export type PrBase = { base: string } | { skipped: string } | Unavailable;

export function prBase(base: string | undefined, env: NodeJS.ProcessEnv): PrBase {
	if (base !== undefined && base !== '') return { base };
	if (env.GITHUB_ACTIONS === 'true') {
		const event = env.GITHUB_EVENT_NAME;
		if (event !== 'pull_request' && event !== 'pull_request_target') {
			return { skipped: 'not a pull request' };
		}
		const ref = env.GITHUB_BASE_REF ?? '';
		if (ref === '') return { unavailable: 'GITHUB_BASE_REF is empty in a pull_request job' };
		return { base: `origin/${ref}` };
	}
	return { skipped: 'no --base outside GitHub Actions' };
}

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
