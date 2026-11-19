import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { parse as parseJsonc } from 'jsonc-parser';
import { parse as parseYaml } from 'yaml';

import { ownVersion } from './own-packages.ts';
import { git, gitRepo, isolateGitConfig, protoBin, repoDir, UNMET_PEER_LOCK } from './testkit.ts';

const CLI = join(import.meta.dir, 'cli.ts');

async function run(args: string[], cwd: string, env: Record<string, string> = {}) {
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
const BARE = {
	'package.json': '{ "name": "r", "engines": { "node": ">=26.8.1" } }',
	'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
};

test('init создаёт конфигурацию, повторный init — код 2', async () => {
	const dir = repoDir(BARE);
	expect((await run(['init', '--profile', 'node'], dir)).code).toBe(0);
	expect((await run(['init', '--profile', 'node'], dir)).code).toBe(2);
});

test('check без .stack.jsonc — код 2 с подсказкой', async () => {
	const dir = repoDir(BARE);
	const r = await run(['check'], dir);
	expect(r.code).toBe(2);
	expect(r.err).toContain('stack init');
});

test('check до sync — код 1, после sync — код 0', async () => {
	const dir = repoDir(BARE);
	await run(['init', '--profile', 'node'], dir);
	expect((await run(['check'], dir)).code).toBe(1);
	const synced = await run(['sync'], dir);
	expect(synced.code).toBe(0);
	expect(synced.out).toContain('seeded');
	expect(synced.out).toContain('updated');
	expect((await run(['check'], dir)).code).toBe(0);
});

test('неизвестная команда — код 2', async () => {
	const r = await run(['помой-посуду'], repoDir(BARE));
	expect(r.code).toBe(2);
	expect(r.err).toContain('Available: init, sync, check, sync-pr, peers-baseline, repo-rules');
});

test('sync-pr без GH_TOKEN или STACK_APP_SLUG — код 2 до sync, файлы не тронуты', async () => {
	for (const env of [
		{ GH_TOKEN: '', STACK_APP_SLUG: 'acme-bot' },
		{ GH_TOKEN: 't', STACK_APP_SLUG: '' },
	]) {
		const dir = repoDir({ '.stack.jsonc': '{ "profile": "node" }' });
		const r = await run(['sync-pr'], dir, env);
		expect(r.code).toBe(2);
		expect(r.err).toContain('sync-pr needs GH_TOKEN and STACK_APP_SLUG');
		expect(readdirSync(dir)).toEqual(['.stack.jsonc']);
	}
});

test('sync-pr --base без значения — код 2, сообщение parseArgs, файлы не тронуты', async () => {
	const dir = repoDir({ '.stack.jsonc': '{ "profile": "node" }' });
	const r = await run(['sync-pr', '--base'], dir, { GH_TOKEN: 't', STACK_APP_SLUG: 'acme-bot' });
	expect(r.code).toBe(2);
	expect(r.err).toContain("Option '--base' argument is ambiguous");
	expect(readdirSync(dir)).toEqual(['.stack.jsonc']);
});

// Фальшивые бинари на PATH: адаптеры процессов и gh проверяются настоящим cli.ts без сети.
const TOKEN_ENV = { GH_TOKEN: 'secret-token', STACK_APP_SLUG: 'acme-bot' };

function fakeBin(scripts: Record<string, string>): { path: string; env: Record<string, string> } {
	const path = mkdtempSync(join(tmpdir(), 'stack-bin-'));
	for (const [name, body] of Object.entries(scripts)) {
		writeFileSync(join(path, name), `#!/bin/sh\n${body}\n`);
		chmodSync(join(path, name), 0o755);
	}
	return { path, env: { PATH: `${path}:${process.env.PATH ?? ''}` } };
}

const NODE_REPO_NO_PKG = { '.stack.jsonc': '{ "profile": "node" }' };
const NODE_REPO = { ...BARE, '.stack.jsonc': '{ "profile": "node" }' };

describe('sync-pr через настоящий cli', () => {
	let restore: () => void;
	beforeAll(() => {
		restore = isolateGitConfig();
	});
	afterAll(() => restore());

	test('окружение задано, нет .stack.jsonc — код 2 из sync, не из проверки окружения', async () => {
		const r = await run(['sync-pr'], repoDir(BARE), TOKEN_ENV);
		expect(r.code).toBe(2);
		expect(r.err).not.toContain('sync-pr needs');
		expect(r.err).toContain('stack init');
	});

	test('proto убит сигналом — код 1 и имя сигнала', async () => {
		const bin = fakeBin({ proto: 'kill -TERM $$' });
		const r = await run(['sync-pr', '--no-install'], repoDir(NODE_REPO), {
			...TOKEN_ENV,
			...bin.env,
		});
		expect(r.code).toBe(1);
		expect(r.err).toContain('sync-pr: proto killed by SIGTERM');
	});

	test('proto не найден — код 127 в сообщении шага', async () => {
		// PATH без каталога proto: только каталог bun и системные.
		const path = `${dirname(process.execPath)}:/usr/bin:/bin`;
		const r = await run(['sync-pr', '--no-install'], repoDir(NODE_REPO), {
			...TOKEN_ENV,
			PATH: path,
		});
		expect(r.code).toBe(1);
		expect(r.err).toContain('sync-pr: proto:');
		expect(r.err).toContain('`proto install` exited with 127');
	});

	test('вывод процесса наследуется, GH_TOKEN до него не доходит, сообщения шагов — в stderr', async () => {
		const bin = fakeBin({ proto: 'echo "token=${GH_TOKEN-unset}"; exit 1' });
		const r = await run(['sync-pr', '--no-install'], repoDir(NODE_REPO), {
			...TOKEN_ENV,
			...bin.env,
		});
		expect(r.code).toBe(1);
		expect(r.out).toContain('token=unset');
		expect(r.out).not.toContain('secret-token');
		expect(r.out).not.toContain('exited with 1');
		expect(r.err).toContain('`proto install` exited with 1');
	});

	test('--no-install: pnpm не зовётся', async () => {
		const log = join(mkdtempSync(join(tmpdir(), 'stack-log-')), 'pnpm.log');
		const bin = fakeBin({ proto: 'exit 0', pnpm: `echo "$@" >> ${log}` });
		const dir = repoDir(NODE_REPO);
		const r = await run(['sync-pr', '--no-install'], dir, {
			...TOKEN_ENV,
			...bin.env,
			GIT_CEILING_DIRECTORIES: dirname(dir), // репозиторий не git, даже если TMPDIR внутри чужого
		});
		expect(r.code).toBe(1); // дальше шага установки репозиторий не git: падает publishChanges
		expect(existsSync(log)).toBe(false);
	});

	test('хук stack:post-sync получает VERSION пакета и не получает GH_TOKEN', async () => {
		const log = join(mkdtempSync(join(tmpdir(), 'stack-log-')), 'hook.log');
		const bin = fakeBin({
			proto: 'exit 0',
			pnpm: `echo "$1 $2 version=$VERSION token=\${GH_TOKEN-unset}" >> ${log}`,
		});
		const dir = repoDir({
			...NODE_REPO,
			'package.json':
				'{ "name": "r", "engines": { "node": ">=26.8.1" }, "scripts": { "stack:post-sync": "x" } }',
		});
		await run(['sync-pr', '--no-install'], dir, {
			...TOKEN_ENV,
			...bin.env,
			GIT_CEILING_DIRECTORIES: dirname(dir),
		});
		expect(readFileSync(log, 'utf8').trim()).toBe(
			`run stack:post-sync version=${ownVersion()} token=unset`,
		);
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

test('init без --profile — код 2', async () => {
	const dir = repoDir(BARE);
	const r = await run(['init'], dir);
	expect(r.code).toBe(2);
	expect(r.err).toContain('--profile');
	expect(existsSync(join(dir, '.stack.jsonc'))).toBe(false);
});

test('init с недопустимым --profile — код 2, файл не создан', async () => {
	const dir = repoDir(BARE);
	const r = await run(['init', '--profile', 'банан'], dir);
	expect(r.code).toBe(2);
	expect(r.err).toContain('банан');
	expect(existsSync(join(dir, '.stack.jsonc'))).toBe(false);
});

test('.stack.jsonc с синтаксической ошибкой — check и sync код 2', async () => {
	const dir = repoDir(BARE);
	writeFileSync(join(dir, '.stack.jsonc'), '{ nope');
	const checked = await run(['check'], dir);
	expect(checked.code).toBe(2);
	expect(checked.err).toContain('JSONC');
	expect((await run(['sync'], dir)).code).toBe(2);
});

test('.stack.jsonc с неизвестным ключом — check и sync код 2, одна строка, sync ничего не пишет', async () => {
	const dir = repoDir(BARE);
	writeFileSync(join(dir, '.stack.jsonc'), '{ "profile": "node", "wiht": ["libs"] }');
	const checked = await run(['check'], dir);
	expect(checked.code).toBe(2);
	expect(checked.err).toContain('unknown key "wiht"');
	expect(checked.err.trim().split('\n')).toHaveLength(1);
	expect((await run(['sync'], dir)).code).toBe(2);
	expect(existsSync(join(dir, '.editorconfig'))).toBe(false);
});

test('повторный sync — без изменений, код 0', async () => {
	const dir = repoDir(BARE);
	await run(['init', '--profile', 'node'], dir);
	await run(['sync'], dir);
	const again = await run(['sync'], dir);
	expect(again.code).toBe(0);
	expect(again.out).toContain('already up to date');
});

test('подавленная находка печатается предупреждением, код 0', async () => {
	const dir = repoDir(BARE);
	await run(['init', '--profile', 'node'], dir);
	await run(['sync'], dir);
	rmSync(join(dir, '.editorconfig'));
	// jsonc-parser, не JSON.parse: .stack.jsonc — JSONC (trailing comma), как читает readStackConfig.
	const cfg = parseJsonc(readFileSync(join(dir, '.stack.jsonc'), 'utf8')) as Record<
		string,
		unknown
	>;
	cfg.exceptions = [{ file: '.editorconfig', reason: 'тест: намеренно подавлено' }];
	writeFileSync(join(dir, '.stack.jsonc'), JSON.stringify(cfg, null, '\t'));
	const r = await run(['check'], dir);
	expect(r.code).toBe(0);
	expect(r.err).toContain('тест: намеренно подавлено');
	expect(r.err).toContain('.editorconfig');
	expect(r.out).toContain('no drift');
});

test('неизвестный флаг — код 2, без необработанного исключения', async () => {
	const dir = repoDir(BARE);
	const r = await run(['sync', '--bogus'], dir);
	expect(r.code).toBe(2);
	expect(r.err).toContain('bogus');
	expect(r.err).not.toContain('cli.ts');
});

test('init с несуществующим --repo — код 2, без стектрейса', async () => {
	const dir = join(repoDir(BARE), 'nope');
	const r = await run(['init', '--profile', 'node'], dir);
	expect(r.code).toBe(2);
	expect(r.err).not.toContain('cli.ts');
	expect(r.err).not.toContain('ENOENT');
});

test('sync с исключением на файл: файл не тронут, строка allowed, check — код 0', async () => {
	const dir = repoDir(BARE);
	writeFileSync(
		join(dir, '.stack.jsonc'),
		'{ "profile": "node", "with": [], "exceptions": [{ "file": ".editorconfig", "reason": "свой отступ" }] }',
	);
	writeFileSync(join(dir, '.editorconfig'), 'свой\n');
	const synced = await run(['sync'], dir);
	expect(synced.code).toBe(0);
	expect(synced.out).not.toContain('updated .editorconfig');
	expect(synced.err).toContain('allowed (свой отступ): .editorconfig');
	expect(readFileSync(join(dir, '.editorconfig'), 'utf8')).toBe('свой\n');
	expect((await run(['check'], dir)).code).toBe(0);
});

// dependabot.yml в репо — находка dependabot-config: её правят руками (перенос в Renovate), sync файл не трогает.
const DEPENDABOT_CONFIG =
	"version: 2\nupdates:\n  - package-ecosystem: 'npm'\n    directory: '/'\n    schedule:\n      interval: 'weekly'\n";

async function syncedRepo(): Promise<string> {
	const dir = repoDir(BARE);
	await run(['init', '--profile', 'node'], dir);
	await run(['sync'], dir);
	mkdirSync(join(dir, '.github'), { recursive: true });
	writeFileSync(join(dir, '.github/dependabot.yml'), DEPENDABOT_CONFIG);
	return dir;
}

test('check: находка, которую sync не чинит, — без совета stack sync', async () => {
	const r = await run(['check'], await syncedRepo());
	expect(r.code).toBe(1);
	expect(r.err).toContain('dependabot-config');
	expect(r.err).not.toContain('Fix with: stack sync');
	expect(r.err).toContain('1 finding(s). stack sync does not fix these — fix them by hand');
});

test('check: смесь — в подсказке оба числа', async () => {
	const dir = await syncedRepo();
	rmSync(join(dir, '.editorconfig'));
	rmSync(join(dir, '.oxfmtrc.jsonc'));
	const r = await run(['check'], dir);
	expect(r.code).toBe(1);
	expect(r.err).toContain('3 finding(s): 2 fixable with: stack sync, 1 to fix by hand');
});

test('check: подавленная находка не входит в числа подсказки', async () => {
	const dir = await syncedRepo();
	rmSync(join(dir, '.editorconfig'));
	const cfg = parseJsonc(readFileSync(join(dir, '.stack.jsonc'), 'utf8')) as Record<
		string,
		unknown
	>;
	cfg.exceptions = [{ file: '.editorconfig', reason: 'тест: подавлено' }];
	writeFileSync(join(dir, '.stack.jsonc'), JSON.stringify(cfg, null, '\t'));
	const r = await run(['check'], dir);
	expect(r.code).toBe(1);
	expect(r.err).toContain('1 finding(s). stack sync does not fix these');
});

test('check: всё чинит sync — подсказка прежняя', async () => {
	const dir = repoDir(BARE);
	await run(['init', '--profile', 'node'], dir);
	await run(['sync'], dir);
	rmSync(join(dir, '.editorconfig'));
	const r = await run(['check'], dir);
	expect(r.code).toBe(1);
	expect(r.err).toMatch(/\n\d+ finding\(s\)\. Fix with: stack sync\n/);
});

// Группа renovate устарела и ничего не включает: репо с ней и без конфига Renovate получает засев
// от sync, и check после этого чист — прежнее правило про ignore краснело на засеянном пресете.
test('with renovate без конфига Renovate: sync засевает renovate.json5, check — код 0 без находок', async () => {
	const dir = repoDir(BARE);
	expect((await run(['init', '--profile', 'node', '--with', 'renovate'], dir)).code).toBe(0);
	expect(existsSync(join(dir, 'renovate.json5'))).toBe(false);
	const synced = await run(['sync'], dir);
	expect(synced.code).toBe(0);
	expect(readFileSync(join(dir, 'renovate.json5'), 'utf8')).toContain(
		'github>alxwlw/stack//renovate/canon.json5#v1',
	);
	const checked = await run(['check'], dir);
	expect(checked.err).not.toContain('renovate');
	expect(checked.code).toBe(0);
});

test('check и sync с опечаткой в with — код 2, ошибка называет группу', async () => {
	const dir = repoDir(BARE);
	writeFileSync(join(dir, '.stack.jsonc'), '{ "profile": "node", "with": ["moon-task"] }');
	for (const command of ['check', 'sync']) {
		const r = await run([command], dir);
		expect(r.code).toBe(2);
		expect(r.err).toContain('unknown group "moon-task"');
		expect(r.err).not.toContain('cli.ts');
	}
});

test('init с неизвестной --with — код 2, файл не создан', async () => {
	const dir = repoDir(BARE);
	const r = await run(['init', '--profile', 'node', '--with', 'moon-task'], dir);
	expect(r.code).toBe(2);
	expect(existsSync(join(dir, '.stack.jsonc'))).toBe(false);
});

test('init с опечаткой во второй --with — код 2, файл не создан', async () => {
	const dir = repoDir(BARE);
	const r = await run(['init', '--profile', 'node', '--with', 'libs', '--with', 'moon-task'], dir);
	expect(r.code).toBe(2);
	expect(r.err).toContain('unknown group "moon-task"');
	expect(existsSync(join(dir, '.stack.jsonc'))).toBe(false);
});

// Репо после init --with peers и sync; lock — текст pnpm-lock.yaml, null — лока нет.
async function peersRepo(lock: string | null): Promise<string> {
	const dir = repoDir(BARE);
	expect((await run(['init', '--profile', 'node', '--with', 'peers'], dir)).code).toBe(0);
	expect((await run(['sync'], dir)).code).toBe(0);
	if (lock !== null) writeFileSync(join(dir, 'pnpm-lock.yaml'), lock);
	return dir;
}

describe('check с группой peers через настоящий cli', () => {
	test('check с группой peers: настоящий pnpm на рукописном локе — peer-dependency, код 1', async () => {
		const dir = await peersRepo(UNMET_PEER_LOCK);
		const bin = fakeBin({ pnpm: `exec "${protoBin('pnpm')}" "$@"` });
		const r = await run(['check'], dir, {
			...bin.env,
			npm_config_registry: 'http://127.0.0.1:9/',
		});
		expect(r.code, r.err).toBe(1);
		expect(r.err).toContain(
			'peer-dependency: peer in . — decl@1.0.0 wants ^2.0.0, found 1.0.0; not in .stack-peers-baseline.json',
		);
	}, 30_000);

	test('check с группой peers без pnpm-lock.yaml — peers-unavailable, pnpm не зовётся', async () => {
		const marker = join(mkdtempSync(join(tmpdir(), 'stack-log-')), 'pnpm.called');
		const bin = fakeBin({ pnpm: `touch ${marker}; echo '{}'` });
		const dir = await peersRepo(null);
		const r = await run(['check'], dir, bin.env);
		expect(r.code).toBe(1);
		expect(r.err).toContain('peers-unavailable: pnpm peers check — no pnpm-lock.yaml');
		expect(existsSync(marker)).toBe(false);
		// Контроль: с локом тот же фальшивый pnpm зовётся, а пустой ответ — чистый check.
		writeFileSync(join(dir, 'pnpm-lock.yaml'), UNMET_PEER_LOCK);
		const withLock = await run(['check'], dir, bin.env);
		expect(existsSync(marker)).toBe(true);
		expect({ code: withLock.code, err: withLock.err }).toEqual({ code: 0, err: '' });
	}, 30_000);

	test('check с группой peers: pnpm выходит с 2 — первая строка stderr в находке, код 1', async () => {
		const bin = fakeBin({ pnpm: 'echo; echo " ERR_PNPM_BOOM nope" >&2; exit 2' });
		const r = await run(['check'], await peersRepo(UNMET_PEER_LOCK), bin.env);
		expect(r.code).toBe(1);
		expect(r.err).toContain(
			'peers-unavailable: pnpm peers check — pnpm peers check exited with 2: ERR_PNPM_BOOM nope\n',
		);
	}, 30_000);

	test('check с группой peers: pnpm печатает справку вместо JSON — peers-unavailable, код 1', async () => {
		const bin = fakeBin({ pnpm: 'echo "Usage: pnpm [command] [flags]"; exit 0' });
		const r = await run(['check'], await peersRepo(UNMET_PEER_LOCK), bin.env);
		expect(r.code).toBe(1);
		expect(r.err).toContain(
			'peers-unavailable: pnpm peers check — pnpm peers check output is not JSON\n',
		);
	}, 30_000);

	test('check с группой peers: pnpm нет на PATH — peers-unavailable с причиной запуска, код 1', async () => {
		const dir = await peersRepo(UNMET_PEER_LOCK);
		// PATH без pnpm: только каталог bun и системные.
		const r = await run(['check'], dir, { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` });
		expect(r.code).toBe(1);
		expect(r.err).toContain(
			'peers-unavailable: pnpm peers check — pnpm peers check did not start: Executable not found in $PATH: "pnpm"\n',
		);
	}, 30_000);

	test('check с группой peers: pnpm зовётся в корне --repo с аргументами гейта и без GH_TOKEN', async () => {
		const bin = fakeBin({ pnpm: 'echo "cwd=$PWD args=$* token=${GH_TOKEN-unset}" >&2; exit 2' });
		const dir = await peersRepo(UNMET_PEER_LOCK);
		const elsewhere = mkdtempSync(join(tmpdir(), 'stack-cwd-'));
		const proc = Bun.spawn(['bun', CLI, 'check', '--repo', dir], {
			cwd: elsewhere,
			stdout: 'pipe',
			stderr: 'pipe',
			env: { ...process.env, ...bin.env, GH_TOKEN: 'secret-token' },
		});
		const err = await new Response(proc.stderr).text();
		expect(await proc.exited).toBe(1);
		expect(err).toContain(
			`pnpm peers check exited with 2: cwd=${realpathSync(dir)} args=peers check --lockfile-only --json token=unset\n`,
		);
	}, 30_000);
});

// UNMET_PEER_LOCK после починки: стоит peer@2.0.0, decl доволен — pnpm записей не видит.
const FIXED_PEER_LOCK = UNMET_PEER_LOCK.replaceAll('peer@1.0.0', 'peer@2.0.0')
	.replace(
		'specifier: 1.0.0\n        version: 1.0.0\n\npackages',
		'specifier: 2.0.0\n        version: 2.0.0\n\npackages',
	)
	.replace('      peer: 1.0.0\n', '      peer: 2.0.0\n');

describe('peers-baseline через настоящий cli', () => {
	test('peers-baseline: init, затем check — код 0; лок починили — check краснеет на stale, peers-baseline — снова 0', async () => {
		const dir = await peersRepo(UNMET_PEER_LOCK);
		const bin = fakeBin({ pnpm: `exec "${protoBin('pnpm')}" "$@"` });
		const env = { ...bin.env, npm_config_registry: 'http://127.0.0.1:9/' };
		const init = await run(['peers-baseline', '--init'], dir, env);
		expect({ code: init.code, out: init.out, err: init.err }).toEqual({
			code: 0,
			out: 'wrote .stack-peers-baseline.json: 1 entr(ies)\n',
			err: '',
		});
		const clean = await run(['check'], dir, env);
		expect(clean.code, clean.err).toBe(0);

		writeFileSync(join(dir, 'pnpm-lock.yaml'), FIXED_PEER_LOCK);
		const stale = await run(['check'], dir, env);
		expect(stale.code).toBe(1);
		expect(stale.err).toContain(
			'stale-peer-baseline: peer in . — recorded unmet by decl (found 1) is gone; drop it with: stack peers-baseline\n',
		);
		const lowered = await run(['peers-baseline'], dir, env);
		expect({ code: lowered.code, out: lowered.out, err: lowered.err }).toEqual({
			code: 0,
			out: 'wrote .stack-peers-baseline.json: 0 entr(ies) (-1 fixed, +0 new)\n',
			err: '',
		});
		const again = await run(['check'], dir, env);
		expect(again.code, again.err).toBe(0);
	}, 60_000);

	test('peers-baseline: новая запись — без флагов код 1, с --allow-grow принята', async () => {
		const dir = await peersRepo(FIXED_PEER_LOCK);
		const bin = fakeBin({ pnpm: `exec "${protoBin('pnpm')}" "$@"` });
		const env = { ...bin.env, npm_config_registry: 'http://127.0.0.1:9/' };
		expect((await run(['peers-baseline', '--init'], dir, env)).out).toBe(
			'wrote .stack-peers-baseline.json: 0 entr(ies)\n',
		);
		writeFileSync(join(dir, 'pnpm-lock.yaml'), UNMET_PEER_LOCK);
		const lower = await run(['peers-baseline'], dir, env);
		expect({ code: lower.code, out: lower.out, err: lower.err }).toEqual({
			code: 1,
			out: '',
			err:
				'new: peer in . — decl@1.0.0 wants ^2.0.0, found 1.0.0\n' +
				'1 new entr(ies) — fix them or pass --allow-grow\n',
		});
		const grow = await run(['peers-baseline', '--allow-grow'], dir, env);
		expect({ code: grow.code, out: grow.out, err: grow.err }).toEqual({
			code: 0,
			out: 'wrote .stack-peers-baseline.json: 1 entr(ies) (-0 fixed, +1 new)\n',
			err: '',
		});
		const check = await run(['check'], dir, env);
		expect(check.code, check.err).toBe(0);
	}, 60_000);

	test('peers-baseline: --init и --allow-grow вместе — код 2, файл не создан', async () => {
		const dir = await peersRepo(UNMET_PEER_LOCK);
		const r = await run(['peers-baseline', '--init', '--allow-grow'], dir);
		expect(r.code).toBe(2);
		expect(r.err).toBe('--init and --allow-grow do not go together\n');
		expect(existsSync(join(dir, '.stack-peers-baseline.json'))).toBe(false);
	}, 30_000);

	test('peers-baseline без группы peers — код 2, сообщение называет with', async () => {
		const dir = repoDir(BARE);
		expect((await run(['init', '--profile', 'node'], dir)).code).toBe(0);
		writeFileSync(join(dir, 'pnpm-lock.yaml'), UNMET_PEER_LOCK);
		const r = await run(['peers-baseline', '--init'], dir);
		expect(r.code).toBe(2);
		expect(r.err).toBe('peers-baseline needs "peers" in "with" of .stack.jsonc\n');
	}, 30_000);

	test('peers-baseline без .stack.jsonc — код 2 с подсказкой stack init', async () => {
		const r = await run(['peers-baseline'], repoDir(BARE));
		expect(r.code).toBe(2);
		expect(r.err).toContain('stack init');
	}, 30_000);
});

test('init и check отвергают опечатку в with одной и той же строкой', async () => {
	const initDir = repoDir(BARE);
	const init = await run(['init', '--profile', 'node', '--with', 'typo'], initDir);
	const checkDir = repoDir(BARE);
	writeFileSync(join(checkDir, '.stack.jsonc'), '{ "profile": "node", "with": ["typo"] }');
	const check = await run(['check'], checkDir);
	expect(init.code).toBe(2);
	expect(check.code).toBe(2);
	const line = (err: string) => err.split('\n').find((l) => l.includes('unknown group'));
	expect(line(init.err)).toContain('unknown group "typo" in "with", expected one of: ');
	expect(line(init.err)).toBe(line(check.err));
});

const RR_BIN = join(import.meta.dir, '../../repo-rules/src/cli.mjs');

// Без добавки --repo: проводник и бинарник repo-rules получают аргументы как есть.
async function spawnIn(cmd: string[], cwd: string) {
	const proc = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' });
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, out, err };
}

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

describe('check с группой repo-rules через настоящий cli', () => {
	const LOCAL = { GITHUB_ACTIONS: '', GITHUB_EVENT_NAME: '', GITHUB_BASE_REF: '' };
	const PR = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request', GITHUB_BASE_REF: 'main' };
	const PUSH = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push', GITHUB_BASE_REF: '' };
	const ONLY = "test.only('x', () => {});\n";
	const TWO_EXPECTS = 'expect(1).toBe(1);\nexpect(2).toBe(2);\n';
	const TWO_DISABLES =
		'// eslint-disable-next-line\nexport const a = 1;\n// eslint-disable-next-line\nexport const b = 2;\n';
	const BASELINE = '.repo-rules-baseline.json';
	const NO_DRIFT = 'canon: no drift\n';
	const REMOVED_LINE = 'repo-rules-violation: a.test.ts — removed-assertions: −1 / +0 assertions';

	let restore: () => void;
	beforeAll(() => {
		restore = isolateGitConfig();
	});
	afterAll(() => restore());

	// Репозиторий под git: init (с группой или без), sync, по желанию baseline repo-rules; всё закоммичено и
	// отправлено в origin/main. Пакета @alxwlw/repo-rules в манифестах нет.
	async function rulesRepo(
		files: Record<string, string>,
		opts: { group?: boolean; baseline?: boolean } = {},
	): Promise<string> {
		const { dir } = gitRepo({ ...BARE, ...files });
		const withGroup = opts.group === false ? [] : ['--with', 'repo-rules'];
		expect((await run(['init', '--profile', 'node', ...withGroup], dir)).code).toBe(0);
		expect((await run(['sync'], dir)).code).toBe(0);
		git(dir, 'add', '-A');
		if (opts.baseline !== false) {
			expect((await spawnIn(['bun', CLI, 'repo-rules', 'baseline', '--init'], dir)).code).toBe(0);
			git(dir, 'add', '-A');
		}
		git(dir, 'commit', '-m', 'canon');
		git(dir, 'push', 'origin', 'main');
		return dir;
	}

	// Ветка PR: удалена одна из двух проверок, коммит не отправлен.
	async function removedAssertion(): Promise<string> {
		const dir = await rulesRepo({ 'a.test.ts': TWO_EXPECTS });
		writeFileSync(join(dir, 'a.test.ts'), 'expect(1).toBe(1);\n');
		git(dir, 'add', '-A');
		git(dir, 'commit', '-m', 'drop a check');
		return dir;
	}

	test('приёмка 1: чистый baseline — no drift и пометка о пропуске diff', async () => {
		const dir = await rulesRepo({ 'src/a.ts': TWO_DISABLES });
		const r = await run(['check'], dir, LOCAL);
		expect(r.code).toBe(0);
		expect(r.out).toBe(NO_DRIFT);
		expect(r.err).toContain('repo-rules diff: skipped (no --base outside GitHub Actions)');
	});

	test('приёмка 1: новое нарушение и устаревшая запись baseline — код 1', async () => {
		const dir = await rulesRepo({ 'src/a.ts': TWO_DISABLES });
		writeFileSync(join(dir, 'src/a.ts'), '// eslint-disable-next-line\nexport const a = 1;\n');
		writeFileSync(join(dir, 'c.test.ts'), ONLY);
		git(dir, 'add', '-A');
		const r = await run(['check'], dir, LOCAL);
		expect(r.code).toBe(1);
		expect(r.err).toContain('repo-rules-violation: c.test.ts:1 — focused-skipped-tests: ');
		expect(r.err).toContain(
			'stale-repo-rules-baseline: src/a.ts — suppression-reason: recorded 2, now 1; lower it with: stack repo-rules baseline',
		);
		expect(r.err).toContain('stack sync does not fix these');
		expect(r.out).not.toContain('canon: no drift');
	});

	test('приёмка 2: PR-джоб сообщает удалённую проверку', async () => {
		const dir = await removedAssertion();
		const r = await run(['check'], dir, PR);
		expect(r.code).toBe(1);
		expect(r.err).toContain(REMOVED_LINE);
		expect(r.err).toContain(
			'repo-rules diff: intended? add a commit trailer "Tests-Removed: <reason>" in the range',
		);
	});

	test('приёмка 2: вне PR — пропуск с пометкой, код 0', async () => {
		const dir = await removedAssertion();
		const r = await run(['check'], dir, PUSH);
		expect(r.code).toBe(0);
		expect(r.err).toContain('repo-rules diff: skipped (not a pull request)');
		expect(r.out).toBe(NO_DRIFT);
	});

	test('--base локально: с базой — нарушение, без неё — пометка', async () => {
		const dir = await removedAssertion();
		const withBase = await run(['check', '--base', 'origin/main'], dir, LOCAL);
		expect(withBase.code).toBe(1);
		expect(withBase.err).toContain(REMOVED_LINE);
		const without = await run(['check'], dir, LOCAL);
		expect(without.code).toBe(0);
		expect(without.err).toContain('skipped (no --base outside GitHub Actions)');
	});

	test('baseline не разбирается — repo-rules-unavailable, не no drift', async () => {
		const dir = await rulesRepo({});
		writeFileSync(join(dir, BASELINE), 'not json');
		const r = await run(['check'], dir, LOCAL);
		expect(r.code).toBe(1);
		expect(r.err).toContain('repo-rules-unavailable: repo-rules check — ');
		expect(r.err).toContain('not JSON');
		expect(r.out).not.toContain('canon: no drift');
	});

	test('базовой ветки нет — repo-rules-unavailable у diff, check отработал', async () => {
		const dir = await rulesRepo({});
		const r = await run(['check'], dir, { ...PR, GITHUB_BASE_REF: 'gone' });
		expect(r.code).toBe(1);
		expect(r.err).toContain('repo-rules-unavailable: repo-rules diff — git merge-base failed');
		expect(r.err).not.toContain('repo-rules check');
	});

	test('каталог не под git — repo-rules-unavailable', async () => {
		const dir = repoDir(BARE);
		expect((await run(['init', '--profile', 'node', '--with', 'repo-rules'], dir)).code).toBe(0);
		expect((await run(['sync'], dir)).code).toBe(0);
		const r = await run(['check'], dir, LOCAL);
		expect(r.code).toBe(1);
		expect(r.err).toContain('repo-rules-unavailable: repo-rules check — git rev-parse failed');
	});

	test('группа без файла baseline — нарушения становятся находками', async () => {
		const dir = await rulesRepo({ 'c.test.ts': ONLY }, { baseline: false });
		const r = await run(['check'], dir, LOCAL);
		expect(r.code).toBe(1);
		expect(r.err).toContain('repo-rules-violation: c.test.ts:1 — focused-skipped-tests: ');
	});

	test('группа выключена: repo-rules не запускается, --base не мешает', async () => {
		const dir = await rulesRepo({ 'c.test.ts': ONLY }, { group: false, baseline: false });
		const cfg = join(dir, '.stack.jsonc');
		writeFileSync(cfg, `// repo-rules: not yet\n${readFileSync(cfg, 'utf8')}`);
		const r = await run(['check', '--base', 'origin/main'], dir, PR);
		expect(r.code).toBe(0);
		expect(r.out).toBe(NO_DRIFT);
		expect(r.err).not.toContain('repo-rules');
		// Без базы и вне Actions включённая группа дала бы пометку о пропуске diff: её нет.
		const local = await run(['check'], dir, LOCAL);
		expect(local.code).toBe(0);
		expect(local.err).not.toContain('repo-rules');
	});

	test('--repo на подкаталог git: проверяется весь репозиторий, пути от его корня', async () => {
		const { dir } = gitRepo({
			'x.test.ts': ONLY,
			'app/package.json': BARE['package.json'],
			'app/pnpm-workspace.yaml': BARE['pnpm-workspace.yaml'],
		});
		const app = join(dir, 'app');
		expect((await run(['init', '--profile', 'node', '--with', 'repo-rules'], app)).code).toBe(0);
		expect((await run(['sync'], app)).code).toBe(0);
		git(dir, 'add', '-A');
		const r = await run(['check'], app, LOCAL);
		expect(r.code).toBe(1);
		expect(r.err).toContain('repo-rules-violation: x.test.ts:1 — focused-skipped-tests: ');
	});

	describe('check.yml: история для diff группы repo-rules', () => {
		// Скрипт шага history берётся из check.yml и исполняется как на runner: bash -e -c в корне checkout.
		const historyScript = (): string => {
			const wf = parseYaml(
				readFileSync(join(import.meta.dir, '../../../.github/workflows/check.yml'), 'utf8'),
			) as { jobs: Record<string, { steps: { id?: string; run?: string }[] }> };
			const step = Object.values(wf.jobs)
				.flatMap((j) => j.steps)
				.find((s) => s.id === 'history');
			if (!step?.run) throw new Error('check.yml has no history step');
			return step.run;
		};
		const step = (cwd: string, baseRef = 'main') => {
			const r = spawnSync('bash', ['-e', '-c', historyScript()], {
				cwd,
				encoding: 'utf8',
				env: { ...process.env, GITHUB_BASE_REF: baseRef },
			});
			return { code: r.status, err: r.stderr };
		};
		const probe = (cwd: string, ...args: string[]) => {
			const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
			return { code: r.status, out: r.stdout.trim() };
		};

		// origin с PR: feature убирает одну проверку из тестового файла фикстуры, main после ответвления ушёл на коммит вперёд,
		// merge-коммит лежит в refs/pull/1/merge, как у GitHub. Возвращает путь bare-remote.
		async function prOrigin(opts: { group?: boolean; baseline?: boolean } = {}): Promise<string> {
			const dir = await rulesRepo({ 'a.test.ts': TWO_EXPECTS }, opts);
			git(dir, 'checkout', '-b', 'feature');
			writeFileSync(join(dir, 'a.test.ts'), 'expect(1).toBe(1);\n');
			git(dir, 'commit', '-am', 'drop a check');
			git(dir, 'checkout', 'main');
			writeFileSync(join(dir, 'later.txt'), 'main moved on\n');
			git(dir, 'add', 'later.txt');
			git(dir, 'commit', '-m', 'main moves on');
			git(dir, 'push', 'origin', 'main');
			git(dir, 'checkout', '--detach', 'main');
			git(dir, 'merge', '--no-ff', 'feature', '-m', 'merge pr');
			git(dir, 'push', 'origin', 'HEAD:refs/pull/1/merge');
			const remote = git(dir, 'remote', 'get-url', 'origin').trim();
			git(remote, 'config', 'uploadpack.allowFilter', 'true');
			return remote;
		}

		// Каталог, каким его оставляет actions/checkout в PR-джобе с fetch-depth 1: один коммит, HEAD — merge-коммит,
		// origin/<база> нет.
		function shallowPrCheckout(remote: string): string {
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

		test('группа включена: после шага stack check видит удалённую проверку', async () => {
			const work = shallowPrCheckout(await prOrigin());
			expect(probe(work, 'rev-parse', '--is-shallow-repository').out).toBe('true');
			const s = step(work);
			expect(s.code).toBe(0);
			expect(probe(work, 'rev-parse', '--is-shallow-repository').out).toBe('false');
			expect(probe(work, 'merge-base', 'origin/main', 'HEAD').code).toBe(0);
			const r = await run(['check'], work, PR);
			expect(r.code).toBe(1);
			expect(r.err).toContain(REMOVED_LINE);
		});

		test('контроль: без шага тот же checkout — repo-rules-unavailable', async () => {
			const work = shallowPrCheckout(await prOrigin());
			const r = await run(['check'], work, PR);
			expect(r.code).toBe(1);
			expect(r.err).toContain('repo-rules-unavailable: repo-rules diff — git merge-base failed');
		});

		test('группа выключена: шаг ничего не скачивает', async () => {
			const work = shallowPrCheckout(await prOrigin({ group: false, baseline: false }));
			expect(step(work).code).toBe(0);
			expect(probe(work, 'rev-parse', '--is-shallow-repository').out).toBe('true');
			expect(probe(work, 'rev-parse', '--verify', '-q', 'origin/main').code).toBe(1);
		});

		test('нет .stack.jsonc: шаг проходит и ничего не скачивает', async () => {
			const work = shallowPrCheckout(await prOrigin({ group: false, baseline: false }));
			rmSync(join(work, '.stack.jsonc'));
			expect(step(work).code).toBe(0);
			expect(probe(work, 'rev-parse', '--is-shallow-repository').out).toBe('true');
		});

		test('слово repo-rules только в комментарии: лишний fetch, падения нет', async () => {
			const work = shallowPrCheckout(await prOrigin({ group: false, baseline: false }));
			const cfg = join(work, '.stack.jsonc');
			writeFileSync(cfg, `// "repo-rules" later\n${readFileSync(cfg, 'utf8')}`);
			expect(step(work).code).toBe(0);
			expect(probe(work, 'rev-parse', '--is-shallow-repository').out).toBe('false');
			const r = await run(['check'], work, PR);
			expect(r.code).toBe(0);
			expect(r.out).toBe(NO_DRIFT);
		});

		test('полный клон: шаг не зовёт --unshallow', async () => {
			const remote = await prOrigin();
			const work = mkdtempSync(join(tmpdir(), 'stack-full-'));
			git(work, 'clone', `file://${remote}`, '.');
			git(work, 'fetch', 'origin', '+refs/pull/1/merge:refs/remotes/pull/1/merge');
			git(work, 'checkout', '--force', 'refs/remotes/pull/1/merge');
			const s = step(work);
			expect(s.code).toBe(0);
			expect(s.err).toBe('');
		});

		test('базовой ветки нет на origin: шаг падает', async () => {
			const work = shallowPrCheckout(await prOrigin());
			const s = step(work, 'gone');
			expect(s.code).not.toBe(0);
			expect(s.err).toContain("couldn't find remote ref");
		});
	});
});
