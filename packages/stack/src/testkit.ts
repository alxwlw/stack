import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { stringify } from 'yaml';

import { type Canon, canonDir, canonFor, loadCanon, readCanonSource } from './canon.ts';
import type { Profile } from './config.ts';
import { STACK_RENOVATE_PRESET } from './deps.ts';
import { ownPackages } from './own-packages.ts';
import type { PeersReader } from './peers.ts';
import type { Served } from './registry.ts';
import { type Read, RENOVATE_CONFIGS, type Repo, repoFromSnapshot } from './repo.ts';
import type { RepoRulesReader } from './repo-rules.ts';
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

// Корень репозитория стека: тесты запускают proto и moon из него.
const ROOT = join(import.meta.dir, '..', '..', '..');

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
