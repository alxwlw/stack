import { spawnSync } from 'node:child_process';

import type { GitHub, OpenPr } from './sync-pr.ts';

export type Exec = (
	cmd: string,
	args: readonly string[],
	opts: { cwd: string; input?: string },
) => { status: number | null; stdout: string; stderr: string; signal?: string | null };

// spawnSync с encoding utf8, cwd и input; бинаря нет (error) — status null, stderr = error.message.
// На ENOENT spawnSync оставляет stdout/stderr undefined — эта ветка возвращает строки.
export const spawnExec: Exec = (cmd, args, { cwd, input }) => {
	const r = spawnSync(cmd, [...args], { cwd, encoding: 'utf8', input });
	if (r.error) return { status: null, stdout: '', stderr: r.error.message };
	return { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr };
};

// Форма элемента `gh pr list --json number,url,headRefName,baseRefName,author`.
interface RawPr {
	number: number;
	url: string;
	headRefName: string;
	baseRefName: string;
	author: { login: string } | null;
}

// Боевой adapter порта GitHub: gh берёт GH_TOKEN из окружения сам и запускается в cwd репозитория —
// git работает там же, и репозиторий для gh должен быть тем же.
export function ghGitHub(cwd: string, exec: Exec = spawnExec): GitHub {
	function gh(args: readonly string[], input?: string): string {
		const r = exec('gh', args, { cwd, input });
		const name = `gh ${args[0]} ${args[1]}`;
		if (r.signal) throw new Error(`${name} killed by ${r.signal}: ${r.stderr.trim()}`);
		if (r.status !== 0) throw new Error(`${name} exited with ${r.status}: ${r.stderr.trim()}`);
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
				const url = lines.at(-1);
				if (!url) throw new Error('gh pr create printed no PR URL');
				return url;
			}),
		defaultBranch: () =>
			settle(() => {
				const name = gh([
					'repo',
					'view',
					'--json',
					'defaultBranchRef',
					'--jq',
					'.defaultBranchRef.name',
				]).trim();
				if (name === '') throw new Error('gh repo view returned no default branch');
				return name;
			}),
		// gh печатает логин GitHub App как `app/<slug>`; `[bot]` — форма из `git user.name` бота (sync-pr.ts:118).
		openPrs: () =>
			settle(() => {
				const stdout = gh([
					'pr',
					'list',
					'--state',
					'open',
					'--limit',
					'1000',
					'--json',
					'number,url,headRefName,baseRefName,author',
				]);
				const list: unknown = JSON.parse(stdout);
				if (!Array.isArray(list)) {
					throw new Error(`gh pr list returned no list: ${JSON.stringify(stdout)}`);
				}
				return (list as RawPr[]).map((p): OpenPr => {
					const login = p.author?.login ?? '';
					return {
						number: p.number,
						url: p.url,
						head: p.headRefName,
						base: p.baseRefName,
						author: login.startsWith('app/') ? `${login.slice('app/'.length)}[bot]` : login,
					};
				});
			}),
		closePr: (number, comment) =>
			settle(() => {
				gh(['pr', 'close', String(number), '--comment', comment]);
			}),
	};
}
