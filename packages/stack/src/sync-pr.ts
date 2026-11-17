import { spawnSync } from 'node:child_process';

export interface NewPr {
	head: string;
	base?: string;
	title: string;
	body: string;
}

// Порт GitHub. Боевой adapter — gh; тесты — литерал.
export interface GitHub {
	botUserId(slug: string): Promise<number>;
	openPr(head: string): Promise<string | undefined>; // URL открытого PR с этой веткой
	createPr(pr: NewPr): Promise<string>; // URL созданного PR
}

export type Print = (stream: 'out' | 'err', line: string) => void;

export interface PublishOptions {
	repoRoot: string;
	version: string;
	base?: string;
	appSlug: string;
}

export function prBody(version: string, files: readonly string[]): string {
	return `Канон \`@alxwlw/stack@${version}\` применён к репозиторию.\n\nИзменённые файлы:\n${files.map((f) => `- ${f}\n`).join('')}\nРелиз: https://github.com/alxwlw/stack/releases/tag/v${version}\n`;
}

interface GitResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

function runGit(cwd: string, args: readonly string[]): GitResult {
	const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 30 });
	const stderr = r.error ? r.error.message : r.stderr;
	return { ok: r.status === 0 && !r.error, stdout: r.stdout, stderr: stderr.trimEnd() };
}

// Записи `XY путь` через NUL; при R/C следом идёт исходный путь. Игнорируемые файлы git не выводит.
function changedFiles(repoRoot: string): string[] {
	const r = runGit(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
	if (!r.ok) throw new Error(r.stderr);
	const fields = r.stdout.split('\0');
	const files: string[] = [];
	for (let i = 0; i < fields.length; i++) {
		const entry = fields[i] as string;
		if (entry === '') continue;
		files.push(entry.slice(3));
		if (/[RC]/.test(entry.slice(0, 2))) {
			const from = fields[++i];
			if (from) files.push(from);
		}
	}
	return [...new Set(files)];
}

const message = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

// Шаги sync.yml:113-173 после установки и хука: список файлов, пользователь бота, ветка, commit, force-push, PR.
export async function publishChanges(
	opts: PublishOptions,
	github: GitHub,
	print: Print,
): Promise<0 | 1> {
	const { repoRoot, version, appSlug } = opts;
	const branch = `stack/v${version}`;
	const title = `chore(stack): канон ${version}`;

	let files: string[];
	try {
		files = changedFiles(repoRoot);
	} catch (error) {
		print('err', `sync-pr: git status failed: ${message(error)}`);
		return 1;
	}
	if (files.length === 0) {
		print('out', 'canon already applied, nothing to commit');
		return 0;
	}

	let id: number;
	try {
		id = await github.botUserId(appSlug);
	} catch (error) {
		print('err', `sync-pr: bot user lookup failed: ${message(error)}`);
		return 1;
	}

	const bot = `${appSlug}[bot]`;
	const steps: [string, string[]][] = [
		['checkout', ['checkout', '-B', branch]],
		['add', ['add', '-A']],
		[
			'commit',
			[
				'-c',
				`user.name=${bot}`,
				'-c',
				`user.email=${id}+${bot}@users.noreply.github.com`,
				'commit',
				'-m',
				title,
			],
		],
		['push', ['push', '--force', 'origin', branch]],
	];
	for (const [name, args] of steps) {
		const r = runGit(repoRoot, args);
		if (!r.ok) {
			print('err', `sync-pr: git ${name} failed: ${r.stderr}`);
			return 1;
		}
	}
	print('out', `pushed ${branch}`);

	let url: string | undefined;
	try {
		url = await github.openPr(branch);
	} catch (error) {
		print('err', `sync-pr: finding the open PR failed: ${message(error)}`);
		return 1;
	}
	if (url) {
		print('out', `updated PR ${url}`);
		return 0;
	}

	try {
		const pr: NewPr = { head: branch, title, body: prBody(version, files) };
		if (opts.base) pr.base = opts.base;
		url = await github.createPr(pr);
	} catch (error) {
		print('err', `sync-pr: creating the PR failed: ${message(error)}`);
		return 1;
	}
	print('out', `opened PR ${url}`);
	return 0;
}
