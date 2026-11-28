import type { Drift, Finding } from './findings.ts';
import type { Repo } from './repo.ts';

// Без vcs.defaultBranch moon сравнивает с master: на PR базу даёт событие и проверки зелёные, а на push
// в ветку по умолчанию CI падает. Ветка и пояснение к ней — параметры правила в настройках канона.
const target = (file: string) => `${file}:vcs.defaultBranch`;

const isMap = (v: unknown): v is Record<string, unknown> =>
	v !== null && typeof v === 'object' && !Array.isArray(v);

// Только существующий файл и только когда vcs — словарь или его нет: на узел-не-словарь setIn бросает.
export function planMoonDefaultBranch(repo: Repo, branch: string): Drift[] {
	const top = repo.moonWorkspace;
	const file = repo.moonWorkspacePath;
	if (top === undefined || file === undefined) return [];
	const vcs = top.vcs;
	if (vcs !== undefined && !isMap(vcs)) return [];
	const current = isMap(vcs) ? vcs.defaultBranch : undefined;
	if (typeof current === 'string' && current !== '') return [];
	const from = current === undefined ? '—' : JSON.stringify(current);
	return [
		{
			code: 'moon-default-branch',
			target: target(file),
			file,
			message: `vcs.defaultBranch is not set — moon falls back to "master", and CI on a push to ${branch} dies with "ambiguous argument 'master'"`,
			fix: `${file} vcs.defaultBranch: ${from} → ${branch}`,
			change: {
				file,
				kind: 'yaml-set',
				path: ['vcs', 'defaultBranch'],
				value: branch,
			},
		},
	];
}

// vcs не словарь (`vcs:` без значения, `vcs: git`): правки нет, только отчёт.
export function checkMoonDefaultBranch(repo: Repo, branch: string, reason: string): Finding[] {
	const top = repo.moonWorkspace;
	const file = repo.moonWorkspacePath;
	if (top === undefined || file === undefined || !('vcs' in top) || isMap(top.vcs)) return [];
	return [
		{
			code: 'moon-default-branch',
			target: target(file),
			file,
			message: `vcs is not a map — set vcs.defaultBranch (${branch}, ${reason}) by hand`,
		},
	];
}
