import {
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

import { checkRepo } from './check.ts';
import { loadCanon } from './canon.ts';
import { readStackConfig } from './config.ts';
import { checkOutput } from './output.ts';
import { ownVersion } from './own-packages.ts';
import {
	BARE,
	CLI,
	fakeBin,
	gitRepo,
	isolateGitConfig,
	protoBin,
	repoDir,
	runCli as run,
	spawnIn,
	UNMET_PEER_LOCK,
} from './testkit.ts';

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

test('вывод check длиннее 128 КиБ доходит до канала целиком при коде 1', async () => {
	const exceptions = Array.from({ length: 2000 }, (_, i) => ({
		file: `nope-${i}.txt`,
		reason: 'r'.repeat(80),
	}));
	const dir = repoDir({ ...BARE, '.stack.jsonc': JSON.stringify({ profile: 'node', exceptions }) });
	const cfg = readStackConfig(dir);
	const expected = checkOutput(checkRepo(dir, loadCanon(cfg), cfg.exceptions));
	expect(expected.code).toBe(1);
	const bytes = expected.lines
		.filter((l) => l.stream === 'err')
		.reduce((n, l) => n + Buffer.byteLength(l.text) + 1, 0);
	expect(bytes).toBeGreaterThan(200_000);
	const rc = join(mkdtempSync(join(tmpdir(), 'stack-rc-')), 'rc');
	// Читатель через shell-канал: Response().text() выбирает канал слишком быстро и обрезания не видит.
	const piped = await spawnIn(
		[
			'sh',
			'-c',
			'{ bun "$0" check --repo "$1" 2>&1 >/dev/null; echo $? >"$2"; } | wc -c',
			CLI,
			dir,
			rc,
		],
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
