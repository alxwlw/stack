import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { parse as parseYaml, stringify } from 'yaml';

import {
	assertKnownGroups,
	type Canon,
	canonDir,
	canonFor,
	loadCanon,
	readCanonSource,
} from './canon.ts';
import { checkRepo, syncRepo } from './check.ts';
import { type CommandPorts, type ExitCode, runCommand } from './command.ts';
import { type Profile, readStackConfig } from './config.ts';
import { STACK_RENOVATE_PRESET } from './deps.ts';
import { type GuardrailRun, type GuardrailRunner, spawnRunner } from './guardrails-port.ts';
import { initConfig } from './init.ts';
import { checkOutput, type Line, syncOutput } from './output.ts';
import { ownPackages } from './own-packages.ts';
import type { PeersReader, PeersRun } from './peers.ts';
import { peersBaseline, type PeersBaselineMode } from './peers-baseline.ts';
import { pnpmPeers } from './peers-port.ts';
import type { Served } from './registry.ts';
import { type Read, RENOVATE_CONFIGS, type Repo, repoFromSnapshot } from './repo.ts';
import type { RepoRulesReader, RepoRulesRun } from './repo-rules.ts';
import { inProcessRepoRules } from './repo-rules-port.ts';
import type { GroupContext } from './rule-group.ts';
import {
	type GitHub,
	type NewPr,
	type OpenPr,
	publishChanges,
	type PublishOptions,
	type RunProcess,
	syncPr,
	type SyncPrOptions,
} from './sync-pr.ts';

// Тест со своим TMPDIR: перечисление временных каталогов видит только каталоги этого теста, а не
// соседние процессы на том же хосте (раннеры CI делят /tmp). Каталог удаляется, TMPDIR возвращается.
export function withPrivateTmpdir<T>(fn: (dir: string) => T): T {
	const saved = process.env.TMPDIR;
	const dir = mkdtempSync(join(tmpdir(), 'stack-private-tmp-'));
	process.env.TMPDIR = dir;
	try {
		return fn(dir);
	} finally {
		if (saved === undefined) Reflect.deleteProperty(process.env, 'TMPDIR');
		else process.env.TMPDIR = saved;
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Окружение для боевых adapter в тестах: окружение процесса без GITHUB_*, сверху — over. Читает
 *  окружение в момент вызова: звать в тесте или beforeAll (после isolateGitConfig), не на верхнем уровне. */
export function testEnv(over: Record<string, string> = {}): NodeJS.ProcessEnv {
	const base = Object.entries(process.env).filter(([key]) => !key.startsWith('GITHUB_'));
	return { ...Object.fromEntries(base), ...over };
}

/** Каталог с исполняемыми sh-скриптами и PATH, где он первый. */
export function fakeBin(scripts: Record<string, string>): { path: string; env: { PATH: string } } {
	const path = mkdtempSync(join(tmpdir(), 'stack-bin-'));
	for (const [name, body] of Object.entries(scripts)) {
		writeFileSync(join(path, name), `#!/bin/sh\n${body}\n`);
		chmodSync(join(path, name), 0o755);
	}
	return { path, env: { PATH: `${path}:${process.env.PATH ?? ''}` } };
}

// Корень репозитория стека: тесты запускают proto и moon из него.
export const ROOT = join(import.meta.dir, '..', '..', '..');

// Не канон-файл: схема конфигурации лежит рядом с пакетом, а не в canon/.
export const SCHEMA_PATH = join(import.meta.dir, '..', 'schema.json');

// Канон для тестов правил. Пины нарочно не равны реальным пинам канона: иначе константа,
// зашитая в правило, осталась бы незамеченной (engines-node в deps.ts, packageManager в package-manager.ts).
export function testCanon(over: Partial<Canon> = {}): Canon {
	return {
		files: [],
		catalogs: {},
		pins: { node: '25.4.1', pnpm: '10.99.0' },
		rules: [],
		ownPackages: ownPackages(over.catalogs?.dev, { version: '0.0.0' }),
		...over,
	};
}

// Рукописный pnpm-lock.yaml для настоящего `pnpm peers check --lockfile-only`: вымышленный decl@1.0.0
// объявляет peer ^2.0.0, а стоит peer@1.0.0 — одна запись bad. Пакетов нет ни в одном реестре, и pnpm
// читает только лок, поэтому тест идёт офлайн.
export const UNMET_PEER_LOCK = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      decl:
        specifier: 1.0.0
        version: 1.0.0(peer@1.0.0)
      peer:
        specifier: 1.0.0
        version: 1.0.0

packages:

  decl@1.0.0:
    resolution: {integrity: sha512-AAAA}
    peerDependencies:
      peer: ^2.0.0

  peer@1.0.0:
    resolution: {integrity: sha512-BBBB}

snapshots:

  decl@1.0.0(peer@1.0.0):
    dependencies:
      peer: 1.0.0

  peer@1.0.0: {}
`;

// Содержимое канон-файла по его dest, как его видит loadCanon: все группы включены. Тесты, сверяющие
// канон с корнем репозитория или с самим собой, берут файл здесь, а не по пути в canon/files.
export function canonFile(dest: string, profile: Profile = 'node'): string {
	const source = readCanonSource();
	const g = source.groups;
	const canon = canonFor(source, { profile, with: [...g.files, ...g.catalogs], exceptions: [] });
	const file = canon.files.find((f) => f.dest === dest);
	if (!file) throw new Error(`no canon file ${dest} for profile ${profile}`);
	return file.content;
}

// Связка (Bundle в GLOSSARY): запись canon/bundles.json.
export type Bundle = { match: string[]; required: string[]; sameVersion: string[][] };

const BUNDLE_KEYS = ['match', 'required', 'sameVersion'];
const isStrings = (v: unknown): v is string[] =>
	Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string' && s !== '');

// Читатель формы bundles.json: опечатка в ключе записи иначе молча сделала бы сверку пустой.
// Шаблоны читает Bun.Glob, поэтому синтаксис Renovate, который он читает иначе, отклоняется.
export function parseBundles(text: string, file: string): Record<string, Bundle> {
	const data: unknown = JSON.parse(text);
	if (typeof data !== 'object' || data === null || Array.isArray(data)) {
		throw new Error(`${file}: верх — не объект «имя → запись»`);
	}
	const names = Object.keys(data);
	if (names.length === 0) throw new Error(`${file}: ни одной записи`);
	const out: Record<string, Bundle> = {};
	for (const name of names) {
		const at = `${file}: ${name}`;
		// out[name] с именем __proto__ задаёт прототип out, и запись молча выпала бы из всех сверок.
		if (name === '__proto__') throw new Error(`${at}: имя записи занято прототипом объекта`);
		const entry: unknown = (data as Record<string, unknown>)[name];
		if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
			throw new Error(`${at}: запись — не объект`);
		}
		const rec = entry as Record<string, unknown>;
		for (const key of Object.keys(rec)) {
			if (!BUNDLE_KEYS.includes(key)) throw new Error(`${at}: лишний ключ ${key}`);
		}
		for (const key of BUNDLE_KEYS) {
			if (!(key in rec)) throw new Error(`${at}: нет ключа ${key}`);
		}
		if (!isStrings(rec.match)) throw new Error(`${at}: match — непустой массив непустых строк`);
		if (!isStrings(rec.required)) {
			throw new Error(`${at}: required — непустой массив непустых строк`);
		}
		const groups = rec.sameVersion;
		if (!Array.isArray(groups) || groups.length === 0 || !groups.every(isStrings)) {
			throw new Error(`${at}: sameVersion — непустой массив непустых массивов непустых строк`);
		}
		for (const p of [...rec.match, ...groups.flat()]) {
			if (p.startsWith('!') || p.startsWith('/')) {
				throw new Error(
					`${at}: шаблон ${p} — отрицание или regex Renovate, Bun.Glob читает их иначе`,
				);
			}
		}
		for (const n of rec.required) {
			if (/[*?[\]{}!]/.test(n)) throw new Error(`${at}: required ${n} — точное имя, а не шаблон`);
		}
		out[name] = { match: rec.match, required: rec.required, sameVersion: groups };
	}
	return out;
}

// Связки читают только тесты, в Canon они не попадают (решение 11 индекса).
export function canonBundles(): Record<string, Bundle> {
	return parseBundles(readFileSync(join(canonDir(), 'bundles.json'), 'utf8'), 'canon/bundles.json');
}

export function matchesAny(patterns: readonly string[], name: string): boolean {
	return patterns.some((p) => new Bun.Glob(p).match(name));
}

// Репозиторий, согласованный с каноном: файлы канона, pnpm-workspace.yaml с его каталогами,
// package.json с packageManager на пине, renovate.json5 с пресетом. Правила, которых тест не касается, молчат.
// Если канон сам кладёт конфиг Renovate (любое из имён RENOVATE_CONFIGS), своего не добавляется:
// у репозитория один конфиг, и содержимое берётся из канона.
export function canonRepoFiles(canon: Canon): Map<string, string> {
	const files = new Map<string, string>();
	for (const f of canon.files) files.set(f.dest, f.content);
	files.set(
		'pnpm-workspace.yaml',
		stringify({ packages: ['packages/*'], catalogs: canon.catalogs }),
	);
	files.set(
		'package.json',
		JSON.stringify({ name: 'repo', packageManager: `pnpm@${canon.pins.pnpm}` }),
	);
	if (!canon.files.some((f) => RENOVATE_CONFIGS.includes(f.dest))) {
		files.set('renovate.json5', `{ extends: ['${STACK_RENOVATE_PRESET}'] }\n`);
	}
	return files;
}

// Ошибка чтения, как её отдаёт fs: сообщение `<код>: <текст>`, поле code.
export function ioError(code: string, message: string): Error {
	return Object.assign(new Error(`${code}: ${message}`), { code });
}

// canonRepoFiles + правки теста: строка — текст файла, Read кладётся как есть, null удаляет файл.
export function testRepo(canon: Canon, over: Record<string, string | Read | null> = {}): Repo {
	const snapshot = new Map<string, Read>();
	for (const [path, text] of canonRepoFiles(canon)) snapshot.set(path, { text });
	for (const [path, value] of Object.entries(over)) {
		if (value === null) snapshot.delete(path);
		else snapshot.set(path, typeof value === 'string' ? { text: value } : value);
	}
	return repoFromSnapshot(snapshot);
}

// Контекст группы правил для тестов: корень '/r', пустое окружение, база PR пропущена.
export function groupContext(repo: Repo, over: Partial<GroupContext> = {}): GroupContext {
	return {
		repoRoot: '/r',
		repo,
		env: {},
		prBase: { skipped: 'no --base outside GitHub Actions' },
		...over,
	};
}

// Ответ repo-rules: код выхода и отчёт, сериализованный в stdout.
export const repoRulesRun = (code: number, report: unknown): RepoRulesRun => ({
	code,
	out: JSON.stringify(report),
	err: '',
});

// Порт pnpm: записывает каталог каждого вызова и отдаёт заданный запуск.
export function fakePeersReader(run: PeersRun): { read: PeersReader; calls: string[] } {
	const calls: string[] = [];
	return {
		read: (root) => {
			calls.push(root);
			return run;
		},
		calls,
	};
}

// Порт repo-rules: записывает argv и окружение каждого вызова, отвечает по очереди; лишний вызов бросает.
export function fakeRepoRulesReader(...runs: RepoRulesRun[]): {
	read: RepoRulesReader;
	calls: { argv: string[]; env: NodeJS.ProcessEnv }[];
} {
	const calls: { argv: string[]; env: NodeJS.ProcessEnv }[] = [];
	return {
		read: (argv, env) => {
			calls.push({ argv, env });
			const run = runs[calls.length - 1];
			if (run === undefined) throw new Error('лишний вызов порта repo-rules');
			return run;
		},
		calls,
	};
}

// Порт guardrails: ключ таблицы — «cmd argv…»; вызов вне таблицы бросает.
export function fakeGuardrailRunner(table: Record<string, GuardrailRun>): {
	run: GuardrailRunner;
	calls: [string, string[]][];
} {
	const calls: [string, string[]][] = [];
	return {
		run: (cmd, argv) => {
			calls.push([cmd, argv]);
			const hit = table[[cmd, ...argv].join(' ')];
			if (hit === undefined) throw new Error(`unexpected call: ${cmd} ${argv.join(' ')}`);
			return hit;
		},
		calls,
	};
}

// Единственный сборщик каталога на диске: ключ — путь от корня, вложенные каталоги создаются.
export function repoDir(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), 'stack-repo-'));
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), content);
	}
	return dir;
}

// git без портов: тесты гоняют настоящий бинарь. stdout; ненулевой код — throw со stderr.
export function git(dir: string, ...args: string[]): string {
	const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
	if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
	return r.stdout;
}

// Запуск закреплённого бинаря. ctx — status, signal, stdout и stderr для второго аргумента expect.
export type ToolRun = { status: number | null; stdout: string; stderr: string; ctx: string };

export function runTool(
	bin: string,
	args: string[],
	cwd: string,
	env?: NodeJS.ProcessEnv,
): ToolRun {
	const r = spawnSync(bin, args, { cwd, encoding: 'utf8', env });
	if (r.error) throw new Error(`${bin}: не запустился: ${r.error.message}`);
	const ctx = `status=${r.status} signal=${r.signal}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`;
	return { status: r.status, stdout: r.stdout, stderr: r.stderr, ctx };
}

// Путь к бинарю из пина: последняя непустая строка stdout. В окружении агента proto печатает NDJSON,
// и путь лежит в поле message последней строки. Нет бинаря — тест падает с выводом proto, а не пропускается.
export function protoBin(tool: string): string {
	const r = spawnSync('proto', ['bin', tool], { cwd: ROOT, encoding: 'utf8' });
	if (r.error) throw new Error(`proto bin ${tool}: ${r.error.message}`);
	let last = r.stdout
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l !== '')
		.at(-1);
	if (last?.startsWith('{')) {
		try {
			const message: unknown = (JSON.parse(last) as { message?: unknown }).message;
			if (typeof message === 'string') last = message;
		} catch {
			// не JSON: остаётся как есть, existsSync ниже отклонит
		}
	}
	if (r.status !== 0 || !last || !existsSync(last)) {
		throw new Error(
			`proto bin ${tool}: нет бинаря (status=${r.status})\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`,
		);
	}
	return last;
}

// JSON из stdout; не разбирается — Error с текстом ошибки разбора и run.ctx.
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- T задаёт тип разобранного JSON на стороне вызова
export function toolJson<T>(run: ToolRun): T {
	try {
		return JSON.parse(run.stdout) as T;
	} catch (e) {
		throw new Error(`stdout не JSON: ${e instanceof Error ? e.message : String(e)}\n${run.ctx}`, {
			cause: e,
		});
	}
}

// Конфигурация git на время файла тестов: у владельца глобально commit.gpgsign=true, в CI нет идентичности.
// Возвращает функцию, которая возвращает прежние значения.
export function isolateGitConfig(): () => void {
	const dir = mkdtempSync(join(tmpdir(), 'stack-gitconfig-'));
	const config = join(dir, 'gitconfig');
	writeFileSync(
		config,
		'[user]\n\tname = test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n',
	);
	const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
	const savedNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
	process.env.GIT_CONFIG_GLOBAL = config;
	process.env.GIT_CONFIG_NOSYSTEM = '1';
	return () => {
		if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
		else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
		if (savedNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
		else process.env.GIT_CONFIG_NOSYSTEM = savedNoSystem;
	};
}

// repoDir(files) под git: commit всех файлов на main и bare-remote origin с этим commit.
export function gitRepo(files: Record<string, string>): { dir: string; remote: string } {
	const dir = repoDir(files);
	const remote = mkdtempSync(join(tmpdir(), 'stack-remote-'));
	git(remote, 'init', '--bare');
	git(dir, 'init', '-b', 'main');
	git(dir, 'add', '-A');
	git(dir, 'commit', '-m', 'base');
	git(dir, 'remote', 'add', 'origin', remote);
	git(dir, 'push', 'origin', 'main');
	return { dir, remote };
}

// Скрипт шага history из check.yml: исполняется как на runner, bash -e -c в корне checkout.
export function historyScript(): string {
	const wf = parseYaml(
		readFileSync(join(import.meta.dir, '../../../.github/workflows/check.yml'), 'utf8'),
	) as { jobs: Record<string, { steps: { id?: string; run?: string }[] }> };
	const step = Object.values(wf.jobs)
		.flatMap((j) => j.steps)
		.find((s) => s.id === 'history');
	if (!step?.run) throw new Error('check.yml has no history step');
	return step.run;
}

export function historyStep(cwd: string, baseRef = 'main'): { code: number | null; err: string } {
	const r = spawnSync('bash', ['-e', '-c', historyScript()], {
		cwd,
		encoding: 'utf8',
		env: { ...process.env, GITHUB_BASE_REF: baseRef },
	});
	return { code: r.status, err: r.stderr };
}

// Каталог, каким его оставляет actions/checkout в PR-джобе с fetch-depth 1: один коммит, HEAD — merge-коммит,
// origin/<база> нет.
export function shallowPrCheckout(remote: string): string {
	const work = mkdtempSync(join(tmpdir(), 'stack-pr-'));
	git(work, 'init', '-b', 'main');
	git(work, 'remote', 'add', 'origin', `file://${remote}`);
	git(
		work,
		'fetch',
		'--no-tags',
		'--depth=1',
		'origin',
		'+refs/pull/1/merge:refs/remotes/pull/1/merge',
	);
	git(work, 'checkout', '--force', 'refs/remotes/pull/1/merge');
	return work;
}

// Помощники тестов sync-pr: поддельный порт GitHub и запуск publishChanges.
export const PR_URL = 'https://github.com/acme/app/pull/1';

export function botPr(
	number: number,
	version: string,
	base = 'main',
	author = 'acme-bot[bot]',
): OpenPr {
	return {
		number,
		url: `https://github.com/acme/app/pull/${number}`,
		head: `stack/v${version}`,
		base,
		author,
	};
}

// open — изменяемый список открытых PR: createPr добавляет свой, closePr убирает закрытый.
export function fakeGitHub(
	over: Partial<GitHub> = {},
	initial: readonly OpenPr[] = [],
): {
	github: GitHub;
	calls: string[];
	created: NewPr[];
	closed: [number, string][];
	open: OpenPr[];
} {
	const calls: string[] = [];
	const created: NewPr[] = [];
	const closed: [number, string][] = [];
	const open: OpenPr[] = [...initial];
	const github: GitHub = {
		botUserId: () => {
			calls.push('botUserId');
			return Promise.resolve(42);
		},
		createPr: (pr) => {
			calls.push('createPr');
			created.push(pr);
			open.push({
				number: 100,
				url: PR_URL,
				head: pr.head,
				base: pr.base ?? '',
				author: 'acme-bot[bot]',
			});
			return Promise.resolve(PR_URL);
		},
		defaultBranch: () => {
			calls.push('defaultBranch');
			return Promise.resolve('main');
		},
		openPrs: () => {
			calls.push('openPrs');
			return Promise.resolve([...open]);
		},
		closePr: (number, comment) => {
			calls.push('closePr');
			closed.push([number, comment]);
			const i = open.findIndex((p) => p.number === number);
			if (i >= 0) open.splice(i, 1);
			return Promise.resolve();
		},
		...over,
	};
	return { github, calls, created, closed, open };
}

export function put(dir: string, path: string, content: string): void {
	mkdirSync(dirname(join(dir, path)), { recursive: true });
	writeFileSync(join(dir, path), content);
}

export async function run(
	opts: PublishOptions,
	github: GitHub,
): Promise<{ code: 0 | 1; out: string[]; err: string[] }> {
	const out: string[] = [];
	const err: string[] = [];
	const code = await publishChanges(opts, github, (stream, line) =>
		(stream === 'out' ? out : err).push(line),
	);
	return { code, out, err };
}

export const opts = (dir: string, over: Partial<PublishOptions> = {}): PublishOptions => ({
	repoRoot: dir,
	version: '1.2.3',
	appSlug: 'acme-bot',
	...over,
});

export const CLI = join(import.meta.dir, 'cli.ts');

export async function runCli(args: string[], cwd: string, env: Record<string, string> = {}) {
	const proc = Bun.spawn(['bun', CLI, ...args, '--repo', cwd], {
		stdout: 'pipe',
		stderr: 'pipe',
		env: { ...process.env, ...env },
	});
	const [out, err] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { code: await proc.exited, out, err };
}

// Репозиторий до init: package.json с engines на реальном каноне и пустой workspace.
export const BARE = {
	'package.json': '{ "name": "r", "engines": { "node": ">=26.8.1" } }',
	'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
};

// Без добавки --repo: проводник и бинарник repo-rules получают аргументы как есть.
export async function spawnIn(cmd: string[], cwd: string) {
	const proc = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' });
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, out, err };
}

export const HOOK = 'pnpm run stack:post-sync|VERSION=1.2.3';

// Ожидаемые обращения к реестру — из канона, а не литералом.
export const SERVED = loadCanon({ profile: 'node', with: [], exceptions: [] }).ownPackages.map(
	(p) => `served ${p.name}@${p.version}`,
);

export const NODE_PKG = JSON.stringify({ name: 'app', scripts: { 'stack:post-sync': 'true' } });

export async function runSyncPr(
	dir: string,
	over: Partial<SyncPrOptions> = {},
	handlers: {
		run?: (line: string) => number | undefined;
		served?: Served | ((name: string, version: string) => Served);
		github?: GitHub;
		peers?: PeersReader;
		repoRules?: RepoRulesReader;
	} = {},
) {
	const journal: string[] = [];
	const out: string[] = [];
	const err: string[] = [];
	const fake = fakeGitHub();
	const execute: RunProcess = (cmd, args, o) => {
		const line = `${cmd} ${args.join(' ')}`;
		journal.push(o.env?.VERSION ? `${line}|VERSION=${o.env.VERSION}` : line);
		return handlers.run?.(line) ?? 0;
	};
	const code = await syncPr(
		{
			repoRoot: dir,
			version: '1.2.3',
			appSlug: 'acme-bot',
			install: true,
			wait: { attempts: 2, intervalMs: 0 },
			...over,
		},
		{
			run: execute,
			github: handlers.github ?? fake.github,
			registry: {
				has: (name, version) => {
					journal.push(`has ${name}@${version}`);
					return Promise.resolve(true);
				},
				served: (name, version) => {
					journal.push(`served ${name}@${version}`);
					const served = handlers.served ?? 'served';
					return Promise.resolve(typeof served === 'function' ? served(name, version) : served);
				},
			},
			print: (stream, line) => (stream === 'out' ? out : err).push(line),
			// Вызов порта pnpm виден в журнале; по умолчанию pnpm ничего не находит.
			peers: (root) => {
				journal.push('peers');
				return handlers.peers?.(root) ?? { status: 0, signal: null, stdout: '{}', stderr: '' };
			},
			// Вызов порта repo-rules виден в журнале; по умолчанию режим ничего не меняет.
			repoRules: (argv, env) => {
				journal.push(`repo-rules ${argv.join(' ')}`);
				return handlers.repoRules?.(argv, env) ?? { code: 0, out: '', err: '' };
			},
		},
	);
	return { code, journal, out, err, github: fake };
}

// Подставные порты функции команды. Печать копится в lines. journal: `peers <root>`,
// `repo-rules <argv через пробел>`, `guardrails <root>` (вызов фабрики), `github <root>` (вызов фабрики),
// `<cmd> <args>` и `<cmd> <args>|VERSION=<v>` (порт процессов), `served <name>@<version>` (реестр).
// По умолчанию: peers — { status: 0, signal: null, stdout: '{}', stderr: '' }; repo-rules —
// { code: 0, out: '', err: '' }; запуск инструмента Guardrails бросает; процесс — код 0; GitHub —
// fakeGitHub(); реестр — виден и отдаётся. over заменяет порт целиком.
export function fakeCommandPorts(over: Partial<CommandPorts> = {}): {
	ports: CommandPorts;
	lines: Line[];
	journal: string[];
	github: ReturnType<typeof fakeGitHub>;
} {
	const lines: Line[] = [];
	const journal: string[] = [];
	const github = fakeGitHub();
	const ports: CommandPorts = {
		print: (stream, text) => void lines.push({ stream, text }),
		peers: (root) => {
			journal.push(`peers ${root}`);
			return { status: 0, signal: null, stdout: '{}', stderr: '' };
		},
		repoRules: (argv) => {
			journal.push(`repo-rules ${argv.join(' ')}`);
			return { code: 0, out: '', err: '' };
		},
		guardrails: (root) => {
			journal.push(`guardrails ${root}`);
			return (cmd, argv) => {
				throw new Error(
					`запуск инструмента Guardrails без подставного порта: ${cmd} ${argv.join(' ')}`,
				);
			};
		},
		run: (cmd, args, o) => {
			const line = `${cmd} ${args.join(' ')}`;
			journal.push(o.env?.VERSION ? `${line}|VERSION=${o.env.VERSION}` : line);
			return 0;
		},
		github: (root) => {
			journal.push(`github ${root}`);
			return github.github;
		},
		registry: {
			has: () => Promise.resolve(true),
			served: (name, version) => {
				journal.push(`served ${name}@${version}`);
				return Promise.resolve('served');
			},
		},
		...over,
	};
	return { ports, lines, journal, github };
}

// Команда в процессе на подставных портах: dir — cwd, окружение — только opts.env. out и err — строки
// своего канала, каждая с переводом строки, как их увидел бы процесс.
export async function runStack(
	args: string[],
	dir: string,
	opts: { env?: Record<string, string>; ports?: Partial<CommandPorts> } = {},
): Promise<{
	code: ExitCode;
	out: string;
	err: string;
	lines: Line[];
	journal: string[];
	github: ReturnType<typeof fakeGitHub>;
}> {
	const { ports, lines, journal, github } = fakeCommandPorts(opts.ports);
	const code = await runCommand({ argv: args, env: opts.env ?? {}, cwd: dir }, ports);
	return { code, ...channels(lines), lines, journal, github };
}

// Строки одного канала подряд, каждая с переводом строки, как их увидел бы процесс.
function channels(lines: readonly Line[]): { out: string; err: string } {
	const channel = (stream: Line['stream']) =>
		lines
			.filter((l) => l.stream === stream)
			.map((l) => `${l.text}\n`)
			.join('');
	return { out: channel('out'), err: channel('err') };
}

// Приёмка ниже команды: те же функции, что зовёт обработчик, на боевых adapter. StackConfigError они
// не ловят — случаи с кодом 2 идут через runStack.

/** `stack init` в процессе: assertKnownGroups и initConfig; профиль по умолчанию — node. */
export function initRepo(dir: string, opts: { profile?: Profile; with?: string[] } = {}): void {
	const groups = opts.with ?? [];
	assertKnownGroups(groups, readCanonSource());
	initConfig(dir, { profile: opts.profile ?? 'node', with: groups });
}

/** `stack sync` в процессе: syncRepo по конфигурации каталога и syncOutput. */
export function syncDir(dir: string): { out: string; err: string } {
	const cfg = readStackConfig(dir);
	return channels(syncOutput(syncRepo(dir, loadCanon(cfg), cfg.exceptions)));
}

/** `stack check` в процессе: checkRepo с pnpmPeers, inProcessRepoRules и spawnRunner(dir, env), затем
 *  checkOutput. env = testEnv(opts.env) — одно и то же окружение идёт в adapter и в checkRepo. */
export function checkDir(
	dir: string,
	opts: { env?: Record<string, string>; base?: string } = {},
): { code: 0 | 1; out: string; err: string } {
	const env = testEnv(opts.env);
	const cfg = readStackConfig(dir);
	const { lines, code } = checkOutput(
		checkRepo(dir, loadCanon(cfg), cfg.exceptions, {
			ports: {
				peers: pnpmPeers(env),
				'repo-rules': inProcessRepoRules,
				guardrails: spawnRunner(dir, env),
			},
			env,
			base: opts.base,
		}),
	);
	return { code, ...channels(lines) };
}

/** `stack peers-baseline` в процессе на pnpmPeers(testEnv(env)). */
export function baselineDir(
	dir: string,
	mode: PeersBaselineMode,
	env?: Record<string, string>,
): { code: 0 | 1 | 2; out: string; err: string } {
	const cfg = readStackConfig(dir);
	const r = peersBaseline(dir, loadCanon(cfg), mode, pnpmPeers(testEnv(env)));
	return {
		code: r.code,
		out: r.out.map((l) => `${l}\n`).join(''),
		err: r.err.map((l) => `${l}\n`).join(''),
	};
}

/** Репозитории под git для приёмки групп правил. guardRepo: gitRepo из files (для профиля node — поверх
 *  BARE), initRepo с группой guardrails (group: false — без неё), syncDir, коммит `canon`, push в
 *  origin/main. clean удаляет все созданные каталоги: его зовёт afterAll файла. */
export function guardRepos(): {
	guardRepo(
		files: Record<string, string>,
		opts?: { group?: boolean; profile?: Profile },
	): { dir: string; remote: string };
	clean(): void;
} {
	const made: string[] = [];
	function guardRepo(
		files: Record<string, string>,
		opts: { group?: boolean; profile?: Profile } = {},
	): { dir: string; remote: string } {
		const profile = opts.profile ?? 'node';
		const repo = gitRepo(profile === 'node' ? { ...BARE, ...files } : files);
		made.push(repo.dir, repo.remote);
		initRepo(repo.dir, { profile, with: opts.group === false ? [] : ['guardrails'] });
		syncDir(repo.dir);
		git(repo.dir, 'add', '-A');
		git(repo.dir, 'commit', '-m', 'canon');
		git(repo.dir, 'push', 'origin', 'main');
		return repo;
	}
	function clean(): void {
		for (const d of made) rmSync(d, { recursive: true, force: true });
	}
	return { guardRepo, clean };
}
