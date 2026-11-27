// База PR для групп правил: явный --base, иначе окружение GitHub Actions. Пропуск — не ошибка
// (код выхода не меняется), недоступная база PR-задачи — ошибка, а не «нет дрейфа».
export type PrBase = { base: string } | { skipped: string } | { unavailable: string };

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
