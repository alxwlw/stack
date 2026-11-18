import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadCanon } from './canon.ts';
import { syncOutput, syncRepo } from './check.ts';
import { readStackConfig, StackConfigError } from './config.ts';
import type { PeersReader } from './peers.ts';
import { peersBaseline } from './peers-baseline.ts';
import { type Registry, type WaitOptions, waitVisible } from './registry.ts';

export interface NewPr {
	head: string;
	base?: string;
	title: string;
	body: string;
}

export interface OpenPr {
	number: number;
	url: string;
	head: string; // headRefName
	base: string; // baseRefName
	author: string; // логин; у GitHub App — `<slug>[bot]`, у PR без автора — ''
}

// Порт GitHub. Боевой adapter — gh; тесты — литерал.
export interface GitHub {
	botUserId(slug: string): Promise<number>;
	createPr(pr: NewPr): Promise<string>; // URL созданного PR
	defaultBranch(): Promise<string>;
	openPrs(): Promise<OpenPr[]>; // все открытые PR репозитория
	closePr(number: number, comment: string): Promise<void>; // закрыть с комментарием; ветку не трогает
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

// Окружение дочернего процесса без GH_TOKEN: токен нужен только gh. git-хуки и скрипты зависимостей
// consumer'а исполняют чужой код и токена не получают (sync.yml даёт его одному шагу вызова, а команда не передаёт ни git, ни proto, ни pnpm, ни хуку).
export function withoutGhToken(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const rest = { ...env };
	delete rest.GH_TOKEN;
	return rest;
}

// Хуки consumer'а (их ставит `pnpm install`) не роняют и не блокируют sync-PR: результат проверяет CI
// consumer'а на PR. `-c` из командной строки сильнее `core.hooksPath` из `.git/config`, а `.git/hooks`
// при заданном hooksPath не читается вовсе.
function runGit(cwd: string, args: readonly string[]): GitResult {
	const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
		cwd,
		encoding: 'utf8',
		maxBuffer: 1 << 30,
		env: withoutGhToken(process.env),
	});
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

const SYNC_BRANCH = /^stack\/v(\d+\.\d+\.\d+)$/;

// PR бота из веток `stack/v<X.Y.Z>` строго старше version с той же базой; порядок входа сохраняется.
// Ветку проверяем первой: PR с чужой или битой веткой под правило не попадает, что бы ни лежало в других полях.
export function stalePrs(
	prs: readonly OpenPr[],
	opts: { version: string; base: string; bot: string },
): OpenPr[] {
	return prs.filter((pr) => {
		const m = SYNC_BRANCH.exec(pr.head);
		return (
			m !== null &&
			pr.author === opts.bot &&
			pr.base === opts.base &&
			Bun.semver.order(m[1] as string, opts.version) < 0
		);
	});
}

// Закрывает устаревшие PR по порядку: комментарий, затем удаление ветки. Первая ошибка останавливает.
// Ветку не трогаем, пока на ней открыт PR, который мы не закрываем (другая база).
async function closeStale(
	repoRoot: string,
	github: GitHub,
	print: Print,
	prs: readonly OpenPr[],
	stale: readonly OpenPr[],
	comment: string,
): Promise<0 | 1> {
	for (const pr of stale) {
		try {
			await github.closePr(pr.number, comment);
		} catch (error) {
			print('err', `sync-pr: closing PR ${pr.url} failed: ${message(error)}`);
			return 1;
		}
		const other = prs.find((p) => p.head === pr.head && !stale.some((s) => s.number === p.number));
		if (!other) {
			const r = runGit(repoRoot, ['push', 'origin', '--delete', pr.head]);
			if (!r.ok) {
				print('err', `sync-pr: git push --delete ${pr.head} failed: ${r.stderr}`);
				return 1;
			}
		}
		print(
			'out',
			other
				? `closed PR ${pr.url} (${pr.head} kept: ${other.url} is open on it)`
				: `closed PR ${pr.url} (${pr.head})`,
		);
	}
	return 0;
}

// Всё после установки и хука: список изменённых файлов, ветка по умолчанию, пользователь бота, ветка,
// commit, force-push, PR и закрытие PR старших версий.
export async function publishChanges(
	opts: PublishOptions,
	github: GitHub,
	print: Print,
): Promise<0 | 1> {
	const { repoRoot, version, appSlug } = opts;
	const branch = `stack/v${version}`;
	const title = `chore(stack): канон ${version}`;
	const bot = `${appSlug}[bot]`;

	let files: string[];
	try {
		files = changedFiles(repoRoot);
	} catch (error) {
		print('err', `sync-pr: git status failed: ${message(error)}`);
		return 1;
	}

	let base: string;
	try {
		base = opts.base || (await github.defaultBranch());
	} catch (error) {
		print('err', `sync-pr: default branch lookup failed: ${message(error)}`);
		return 1;
	}

	const listOpen = async (): Promise<OpenPr[] | undefined> => {
		try {
			return await github.openPrs();
		} catch (error) {
			print('err', `sync-pr: listing open PRs failed: ${message(error)}`);
			return undefined;
		}
	};

	if (files.length === 0) {
		print('out', 'canon already applied, nothing to commit');
		const prs = await listOpen();
		if (!prs) return 1;
		return closeStale(
			repoRoot,
			github,
			print,
			prs,
			stalePrs(prs, { version, base, bot }),
			`Канон ${version} уже в \`${base}\` — этот PR устарел.`,
		);
	}

	let id: number;
	try {
		id = await github.botUserId(appSlug);
	} catch (error) {
		print('err', `sync-pr: bot user lookup failed: ${message(error)}`);
		return 1;
	}

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

	const prs = await listOpen();
	if (!prs) return 1;
	let url = prs.find((p) => p.head === branch && p.base === base)?.url;
	if (url) {
		print('out', `updated PR ${url}`);
	} else {
		try {
			url = await github.createPr({ head: branch, base, title, body: prBody(version, files) });
		} catch (error) {
			print('err', `sync-pr: creating the PR failed: ${message(error)}`);
			return 1;
		}
		print('out', `opened PR ${url}`);
	}

	return closeStale(
		repoRoot,
		github,
		print,
		prs,
		stalePrs(prs, { version, base, bot }),
		`Заменён ${url} — канон ${version}.`,
	);
}

// Порт процессов: код выхода; вывод процесса идёт в лог job (боевой adapter наследует stdio).
export type RunProcess = (
	cmd: string,
	args: readonly string[],
	opts: { cwd: string; env?: Readonly<Record<string, string>> },
) => number;

export interface SyncPrOptions extends PublishOptions {
	install: boolean;
	wait: WaitOptions;
}

export interface SyncPrPorts {
	run: RunProcess;
	github: GitHub;
	registry: Registry;
	print: Print;
	peers: PeersReader;
}

// Как ATTEMPTS/INTERVAL шага ожидания в sync.yml.
export const SYNC_PR_WAIT: WaitOptions = { attempts: 12, intervalMs: 10_000 };

// Поле version из package.json пакета: он лежит рядом с src/, как canon/ (canonDir()).
export function ownVersion(): string {
	const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8')) as {
		version: string;
	};
	return pkg.version;
}

class StepFailed extends Error {}

// sync в процессе, ожидание реестра, установка, хук stack:post-sync, затем publishChanges.
export async function syncPr(opts: SyncPrOptions, ports: SyncPrPorts): Promise<0 | 1 | 2> {
	const { repoRoot, version } = opts;
	const { run, print } = ports;
	try {
		let canon: ReturnType<typeof loadCanon>;
		try {
			const cfg = readStackConfig(repoRoot);
			canon = loadCanon(cfg);
			const out = syncOutput(syncRepo(repoRoot, canon, cfg.exceptions));
			for (const line of out.stderr) print('err', line);
			for (const line of out.stdout) print('out', line);
		} catch (error) {
			if (error instanceof StackConfigError) {
				print('err', error.message);
				return 2;
			}
			throw error;
		}

		const pkgPath = join(repoRoot, 'package.json');
		if (!existsSync(pkgPath)) return await publishChanges(opts, ports.github, print);

		let hook = false;
		try {
			const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
				scripts?: Record<string, unknown>;
			} | null;
			const script = pkg?.scripts?.['stack:post-sync'];
			hook = typeof script === 'string' && script !== '';
		} catch (error) {
			print('err', `sync-pr: package.json does not parse: ${message(error)}`);
			return 1;
		}

		if (opts.install) {
			const wanted = Object.entries(canon.catalogs.dev ?? {})
				.filter(([name]) => name.startsWith('@alxwlw/'))
				.map(([name, v]) => ({ name, version: v }));
			await waitVisible(wanted, ports.registry, opts.wait);
		}

		const step = (cmd: string, args: string[], env?: Record<string, string>): void => {
			const code = run(cmd, args, env ? { cwd: repoRoot, env } : { cwd: repoRoot });
			if (code !== 0) throw new StepFailed(`\`${cmd} ${args.join(' ')}\` exited with ${code}`);
		};
		step('proto', ['install']);
		if (opts.install) step('pnpm', ['install', '--no-frozen-lockfile']);
		if (hook) step('pnpm', ['run', 'stack:post-sync'], { VERSION: version });

		// Новый лок мог исправить записи baseline группы peers: они уходят в тот же коммит, иначе CI
		// sync-PR краснел бы на stale-peer-baseline. Новые записи не добавляются, а код не меняет итог:
		// и новые записи, и сбой pnpm покажет stack check в CI sync-PR. Группу проверяет peersBaseline.
		const peers = peersBaseline(repoRoot, canon, 'drop-fixed', ports.peers);
		for (const line of peers.out) print('out', line);
		for (const line of peers.err) print('err', `sync-pr: peers baseline: ${line}`);

		return await publishChanges(opts, ports.github, print);
	} catch (error) {
		print('err', `sync-pr: ${message(error)}`);
		return 1;
	}
}
