import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLI = join(dirname(fileURLToPath(import.meta.url)), 'cli.mjs');

const made: string[] = [];

/** Remove every repository `repo()` created; call from `afterAll`. */
export function cleanup(): void {
	for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
}

export interface Repo {
	root: string;
	git(...args: string[]): string;
	write(files: Record<string, string>): void;
	commit(message: string, ...extra: string[]): void;
}

/** A fresh git repository on `main` with `files` committed. */
export function repo(files: Record<string, string> = {}): Repo {
	const root = mkdtempSync(join(tmpdir(), 'repo-rules-'));
	made.push(root);
	const git = (...args: string[]): string =>
		execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
	git('init', '-q', '-b', 'main');
	git('config', 'user.email', 't@t');
	git('config', 'user.name', 't');
	const write = (more: Record<string, string>): void => {
		for (const [path, text] of Object.entries(more)) {
			mkdirSync(dirname(join(root, path)), { recursive: true });
			writeFileSync(join(root, path), text);
		}
	};
	const commit = (message: string, ...extra: string[]): void => {
		git('add', '-A');
		git('commit', '-q', '--allow-empty', '-m', message, ...extra.flatMap((m) => ['-m', m]));
	};
	write(files);
	commit('base');
	return { root, git, write, commit };
}

/** `n` numbered lines, each ending in `\n`. */
export const lines = (n: number): string => Array.from({ length: n }, (_, i) => `l${i}\n`).join('');

/** Run the real bin with node; returns code and both streams. */
export function cli(
	args: string[],
	env: Record<string, string> = {},
): { code: number; stdout: string; stderr: string } {
	const r = spawnSync('node', [CLI, ...args], {
		encoding: 'utf8',
		env: { ...process.env, GITHUB_ACTIONS: '', GITHUB_EVENT_NAME: '', ...env },
	});
	return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}
