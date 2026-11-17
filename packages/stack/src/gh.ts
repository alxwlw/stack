import { spawnSync } from 'node:child_process';

import type { GitHub } from './sync-pr.ts';

export type Exec = (
	cmd: string,
	args: readonly string[],
	input?: string,
) => { status: number | null; stdout: string; stderr: string };

// spawnSync с encoding utf8 и input; бинаря нет (error) — status null, stderr = error.message.
export const spawnExec: Exec = (cmd, args, input) => {
	const r = spawnSync(cmd, [...args], { encoding: 'utf8', input });
	if (r.error) return { status: null, stdout: '', stderr: r.error.message };
	return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

// Боевой adapter порта GitHub: gh берёт GH_TOKEN из окружения сам.
export function ghGitHub(exec: Exec = spawnExec): GitHub {
	function gh(args: readonly string[], input?: string): string {
		const r = exec('gh', args, input);
		if (r.status !== 0) {
			throw new Error(`gh ${args[0]} ${args[1]} exited with ${r.status}: ${r.stderr.trim()}`);
		}
		return r.stdout;
	}
	// Синхронный spawn внутри Promise: throw становится отказом, а не исключением вызова.
	const settle = <T>(f: () => T): Promise<T> => new Promise((resolve) => resolve(f()));
	return {
		botUserId: (slug) =>
			settle(() => {
				const stdout = gh(['api', `/users/${slug}[bot]`, '--jq', '.id']);
				const id = Number(stdout.trim());
				if (!Number.isInteger(id) || id <= 0) {
					throw new Error(`gh api returned no user id for ${slug}[bot]: ${JSON.stringify(stdout)}`);
				}
				return id;
			}),
		openPr: (head) =>
			settle(() => {
				const url = gh([
					'pr',
					'list',
					'--head',
					head,
					'--state',
					'open',
					'--json',
					'url',
					'--jq',
					'.[0].url // ""',
				]).trim();
				return url === '' ? undefined : url;
			}),
		createPr: (pr) =>
			settle(() => {
				const args = [
					'pr',
					'create',
					'--title',
					pr.title,
					'--body-file',
					'-',
					'--head',
					pr.head,
					...(pr.base ? ['--base', pr.base] : []),
				];
				const lines = gh(args, pr.body)
					.split('\n')
					.filter((l) => l.trim() !== '');
				return lines.at(-1) ?? '';
			}),
	};
}
