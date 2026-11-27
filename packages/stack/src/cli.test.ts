import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { loadCanon } from './canon.ts';
import { checkRepo } from './check.ts';
import { readStackConfig } from './config.ts';
import { checkOutput } from './output.ts';
import { ownVersion } from './own-packages.ts';
import {
	BARE,
	CLI,
	fakeBin,
	gitRepo,
	isolateGitConfig,
	OWNER_SOURCE,
	repoDir,
	runCli,
	spawnIn,
} from './testkit.ts';

test('вход: argv доходит до функции команды, код возвращается, каналы не перепутаны', async () => {
	const dir = repoDir(BARE);
	expect(await runCli(['init', '--profile', 'node'], dir)).toStrictEqual({
		code: 0,
		out: `created ${join(dir, '.stack.jsonc')}\n`,
		err: '',
	});
	const red = await runCli(['check'], dir);
	expect({ code: red.code, out: red.out }).toStrictEqual({ code: 1, out: '' });
	expect(red.err).toContain('finding(s)');
	const synced = await runCli(['sync'], dir);
	expect({ code: synced.code, err: synced.err }).toStrictEqual({ code: 0, err: '' });
	expect(synced.out).toEndWith('canon applied\n');
	expect(await runCli(['check'], dir)).toStrictEqual({
		code: 0,
		out: 'canon: no drift\n',
		err: '',
	});
	const usage = await runCli(['sync', '--bogus'], dir);
	expect({ code: usage.code, out: usage.out }).toStrictEqual({ code: 2, out: '' });
	expect(usage.err).toStartWith("Unknown option '--bogus'");
	expect(usage.err).not.toContain('cli.ts');
	expect(await runCli(['sync-pr'], dir, { GH_TOKEN: '', STACK_APP_SLUG: '' })).toStrictEqual({
		code: 2,
		out: '',
		err: 'sync-pr needs GH_TOKEN and STACK_APP_SLUG in the environment\n',
	});
	expect(await runCli(['peers-baseline'], dir)).toStrictEqual({
		code: 2,
		out: '',
		err: 'peers-baseline needs "peers" in "with" of .stack.jsonc\n',
	});
}, 60_000);

// Фальшивые бинари на PATH: адаптеры процессов и gh проверяются настоящим cli.ts без сети.
const TOKEN_ENV = { GH_TOKEN: 'secret-token', STACK_APP_SLUG: 'acme-bot' };

const NODE_REPO_NO_PKG = { '.stack.jsonc': '{ "profile": "node" }' };
const NODE_REPO = { ...BARE, '.stack.jsonc': '{ "profile": "node" }' };

describe('sync-pr через настоящий cli', () => {
	let restore: () => void;
	beforeAll(() => {
		restore = isolateGitConfig();
	});
	afterAll(() => restore());

	test('вывод процесса наследуется, GH_TOKEN до него не доходит, сообщения шагов — в stderr', async () => {
		const bin = fakeBin({ proto: 'echo "token=${GH_TOKEN-unset}"; exit 1' });
		const r = await runCli(['sync-pr', '--no-install'], repoDir(NODE_REPO), {
			...TOKEN_ENV,
			...bin.env,
		});
		expect(r.code).toBe(1);
		expect(r.out).toContain('token=unset');
		expect(r.out).not.toContain('secret-token');
		expect(r.out).not.toContain('exited with 1');
		expect(r.err).toContain('`proto install` exited with 1');
	});

	test('gh идёт в каталог --repo, --base доходит до gh pr create, out и err разведены', async () => {
		const { dir } = gitRepo(NODE_REPO_NO_PKG);
		const log = join(mkdtempSync(join(tmpdir(), 'stack-log-')), 'gh.log');
		const bin = fakeBin({
			gh: `case "$1 $2" in
"api /users/acme-bot[bot]") echo 42;;
"pr list") echo "[]";;
"pr create") echo "$PWD|$*" >> ${log}; cat >/dev/null; echo https://github.com/acme/app/pull/8;;
*) echo "unexpected $*" >&2; exit 9;;
esac`,
		});
		const elsewhere = mkdtempSync(join(tmpdir(), 'stack-cwd-'));
		const proc = Bun.spawn(['bun', CLI, 'sync-pr', '--base', 'staging', '--repo', dir], {
			cwd: elsewhere,
			stdout: 'pipe',
			stderr: 'pipe',
			env: { ...process.env, ...TOKEN_ENV, ...bin.env },
		});
		const [out, err] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		expect({ code: await proc.exited, err }).toEqual({ code: 0, err: '' });
		expect(out).toContain('opened PR https://github.com/acme/app/pull/8');
		const [cwd, args] = readFileSync(log, 'utf8').trim().split('|');
		expect(realpathSync(cwd ?? '')).toBe(realpathSync(dir));
		expect(args).toContain('--base staging');
	});

	test('пустой --base= (потребитель без STACK_SYNC_BASE) — gh pr create с базой из gh repo view', async () => {
		const { dir } = gitRepo(NODE_REPO_NO_PKG);
		const log = join(mkdtempSync(join(tmpdir(), 'stack-log-')), 'gh.log');
		const bin = fakeBin({
			gh: `case "$1 $2" in
"api /users/acme-bot[bot]") echo 42;;
"repo view") echo main;;
"pr list") echo "[]";;
"pr create") echo "$*" >> ${log}; cat >/dev/null; echo https://github.com/acme/app/pull/9;;
*) echo "unexpected $*" >&2; exit 9;;
esac`,
		});
		const proc = Bun.spawn(['bun', CLI, 'sync-pr', '--base=', '--no-install', '--repo', dir], {
			stdout: 'pipe',
			stderr: 'pipe',
			env: { ...process.env, ...TOKEN_ENV, ...bin.env },
		});
		const [out, err] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		expect({ code: await proc.exited, err }).toEqual({ code: 0, err: '' });
		expect(out).toContain('opened PR https://github.com/acme/app/pull/9');
		const args = readFileSync(log, 'utf8').trim();
		expect(args).toContain('pr create');
		expect(args).toContain('--base main');
	});
});

test('вывод check длиннее 128 КиБ доходит до канала целиком при коде 1', async () => {
	const exceptions = Array.from({ length: 2000 }, (_, i) => ({
		file: `nope-${i}.txt`,
		reason: 'r'.repeat(80),
	}));
	const dir = repoDir({ ...BARE, '.stack.jsonc': JSON.stringify({ profile: 'node', exceptions }) });
	const cfg = readStackConfig(dir, OWNER_SOURCE.settings);
	const expected = checkOutput(checkRepo(dir, loadCanon(cfg), cfg.exceptions));
	expect(expected.code).toBe(1);
	const bytes = expected.lines
		.filter((l) => l.stream === 'err')
		.reduce((n, l) => n + Buffer.byteLength(l.text) + 1, 0);
	expect(bytes).toBeGreaterThan(200_000);
	const rc = join(mkdtempSync(join(tmpdir(), 'stack-rc-')), 'rc');
	// Читатель через shell-канал: Response().text() выбирает канал слишком быстро и обрезания не видит.
	// Без --repo: корень репозитория берётся из cwd процесса, его задаёт spawnIn.
	const piped = await spawnIn(
		['sh', '-c', '{ bun "$0" check 2>&1 >/dev/null; echo $? >"$1"; } | wc -c', CLI, rc],
		dir,
	);
	expect(Number(piped.out.trim())).toBe(bytes);
	expect(readFileSync(rc, 'utf8').trim()).toBe('1');
}, 60_000);

const RR_BIN = join(import.meta.dir, '../../repo-rules/src/cli.mjs');

describe('stack repo-rules', () => {
	let restore: () => void;
	let clean: string;
	let dirty: string;
	let plain: string;
	beforeAll(() => {
		restore = isolateGitConfig();
		clean = gitRepo({ 'a.ts': 'export const a = 1;\n' }).dir;
		dirty = gitRepo({ 'a.test.ts': "test.only('x', () => {});\n" }).dir;
		plain = repoDir({});
	});
	afterAll(() => restore());

	test('приёмка 3: stack repo-rules baseline --init создаёт baseline без пакета в манифестах', async () => {
		// Свой репозиторий: baseline делает общий dirty чистым для остальных тестов.
		const { dir } = gitRepo({ 'a.test.ts': "test.only('x', () => {});\n" });
		const r = await spawnIn(['bun', CLI, 'repo-rules', 'baseline', '--init'], dir);
		expect(r.code).toBe(0);
		expect(r.out).toContain('repo-rules baseline: wrote .repo-rules-baseline.json (');
		expect(existsSync(join(dir, '.repo-rules-baseline.json'))).toBe(true);
		expect(existsSync(join(dir, 'package.json'))).toBe(false);
	});

	// Каждая строка: аргументы и каталог. Вывод и код проводника равны выводу и коду бинарника.
	const SAME: [string, () => { args: string[]; cwd: string }][] = [
		['--version', () => ({ args: ['--version'], cwd: clean })],
		['--help', () => ({ args: ['--help'], cwd: clean })],
		['check, чисто', () => ({ args: ['check'], cwd: clean })],
		['check, нарушение', () => ({ args: ['check'], cwd: dirty })],
		['check --json', () => ({ args: ['check', '--json'], cwd: dirty })],
		['-C из другого каталога', () => ({ args: ['-C', dirty, 'check'], cwd: plain })],
		['diff --base', () => ({ args: ['diff', '--base', 'HEAD', '--json'], cwd: clean })],
		['без команды', () => ({ args: [], cwd: clean })],
		['неизвестная команда', () => ({ args: ['nope'], cwd: clean })],
		['флаг stack --repo', () => ({ args: ['--repo', clean, 'check'], cwd: clean })],
		['вне git', () => ({ args: ['check'], cwd: plain })],
	];
	test.each(SAME)('stack repo-rules как бинарник: %s', async (_name, make) => {
		const { args, cwd } = make();
		const viaStack = await spawnIn(['bun', CLI, 'repo-rules', ...args], cwd);
		const viaBin = await spawnIn(['node', RR_BIN, ...args], cwd);
		expect(viaStack).toStrictEqual(viaBin);
	});

	test('большой вывод проводника доходит целиком (канал не обрывается на выходе)', async () => {
		const files: Record<string, string> = {};
		for (let i = 0; i < 3000; i++) files[`f${i}.test.ts`] = `test.only('x${i}', () => {});\n`;
		const { dir } = gitRepo(files);
		// Читатель через shell-канал: Response().text() выбирает канал слишком быстро и обрезания не видит.
		const bytes = async (cmd: string) =>
			(await spawnIn(['sh', '-c', `${cmd} | wc -c`, CLI, RR_BIN], dir)).out.trim();
		const viaBin = await bytes('node "$1" check --json');
		expect(Number(viaBin)).toBeGreaterThan(300_000);
		expect(await bytes('bun "$0" repo-rules check --json')).toBe(viaBin);
	}, 60_000);

	test('сломанный stdout: проводник как бинарник — строка repo-rules: и код 2', async () => {
		// /dev/full: запись падает с ENOSPC; код выхода и stderr сравниваются с бинарником.
		const via = (cmd: string) =>
			spawnIn(['sh', '-c', `${cmd} >/dev/full; echo "rc=$?"`, CLI, RR_BIN], clean);
		const viaBin = await via('node "$1" check --json');
		expect(viaBin.out).toBe('rc=2\n');
		expect(viaBin.err).toStartWith('repo-rules: ENOSPC');
		expect(await via('bun "$0" repo-rules check --json')).toStrictEqual(viaBin);
	});

	test('коды проводника: чисто 0, нарушение 1, вне git 2', async () => {
		expect((await spawnIn(['bun', CLI, 'repo-rules', 'check'], clean)).code).toBe(0);
		expect((await spawnIn(['bun', CLI, 'repo-rules', 'check'], dirty)).code).toBe(1);
		const outside = await spawnIn(['bun', CLI, 'repo-rules', 'check'], plain);
		expect(outside.code).toBe(2);
		expect(outside.err).toStartWith('repo-rules: git rev-parse failed');
	});

	test('версия проводника — версия stack, даже когда у репозитория свой repo-rules в node_modules', async () => {
		const dir = repoDir({
			'node_modules/@alxwlw/repo-rules/package.json':
				'{"name":"@alxwlw/repo-rules","version":"0.0.1","type":"module","exports":{".":"./src/main.mjs"}}',
			'node_modules/@alxwlw/repo-rules/src/main.mjs':
				'export const main = (_a, _e, out) => (out("0.0.1"), 0);\nexport const run = main;\n',
		});
		const r = await spawnIn(['bun', CLI, 'repo-rules', '--version'], dir);
		expect(r).toStrictEqual({ code: 0, out: `${ownVersion()}\n`, err: '' });
	});

	test('repo-rules не первым аргументом — код 2 с подсказкой', async () => {
		const r = await spawnIn(['bun', CLI, '--repo', clean, 'repo-rules', 'check'], clean);
		expect(r.code).toBe(2);
		expect(r.err).toContain('must come first: stack repo-rules [-C <dir>] <command>');
		expect(r.err).not.toContain('unknown command');
	});

	test('cli.ts берёт repo-rules по имени пакета, не по пути в соседний каталог', () => {
		const imports = new Bun.Transpiler({ loader: 'ts' })
			.scanImports(readFileSync(CLI, 'utf8').replace(/^#!.*\n/, ''))
			.map((i) => i.path);
		expect(imports).toContain('@alxwlw/repo-rules');
		expect(imports.filter((p) => p.includes('repo-rules/'))).toStrictEqual([]);
	});
});
