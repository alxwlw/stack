import { main as repoRulesMain } from '@alxwlw/repo-rules';

import type { RepoRulesReader } from './repo-rules.ts';

// Боевой adapter порта repo-rules: main не бросает, вывод собирается в строки без записи в поток.
export const inProcessRepoRules: RepoRulesReader = (argv, env) => {
	const out: string[] = [];
	const err: string[] = [];
	const code = repoRulesMain(
		argv,
		env,
		(s) => void out.push(s),
		(s) => void err.push(s),
	);
	return { code, out: out.join('\n'), err: err.join('\n') };
};
