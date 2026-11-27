import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { BARE, fakeBin, protoBin, repoDir, UNMET_PEER_LOCK } from './testkit.ts';
import { baselineDir, checkDir, initRepo, syncDir } from './testkit-acceptance.ts';

// Приёмка группы peers на боевом adapter: pnpmPeers получает testEnv(env), pnpm — настоящий из пина
// или подставной скрипт на PATH. Команда идёт функциями, что зовёт обработчик, без процесса cli.ts.

// Репо после init --with peers и sync; lock — текст pnpm-lock.yaml, null — лока нет.
function peersRepo(lock: string | null): string {
	const dir = repoDir(BARE);
	initRepo(dir, { with: ['peers'] });
	syncDir(dir);
	if (lock !== null) writeFileSync(join(dir, 'pnpm-lock.yaml'), lock);
	return dir;
}

describe('check с группой peers на боевом adapter', () => {
	test('check с группой peers: настоящий pnpm на рукописном локе — peer-dependency, код 1', () => {
		const dir = peersRepo(UNMET_PEER_LOCK);
		const bin = fakeBin({ pnpm: `exec "${protoBin('pnpm')}" "$@"` });
		const r = checkDir(dir, { env: { ...bin.env, npm_config_registry: 'http://127.0.0.1:9/' } });
		expect(r.code, r.err).toBe(1);
		expect(r.err).toContain(
			'peer-dependency: peer in . — decl@1.0.0 wants ^2.0.0, found 1.0.0; not in .stack-peers-baseline.json',
		);
	}, 30_000);

	test('check с группой peers без pnpm-lock.yaml — peers-unavailable, pnpm не зовётся', () => {
		const marker = join(mkdtempSync(join(tmpdir(), 'stack-log-')), 'pnpm.called');
		const bin = fakeBin({ pnpm: `touch ${marker}; echo '{}'` });
		const dir = peersRepo(null);
		const r = checkDir(dir, { env: bin.env });
		expect(r.code).toBe(1);
		expect(r.err).toContain('peers-unavailable: pnpm peers check — no pnpm-lock.yaml');
		expect(existsSync(marker)).toBe(false);
		// Контроль: с локом тот же фальшивый pnpm зовётся, а пустой ответ — чистый check.
		writeFileSync(join(dir, 'pnpm-lock.yaml'), UNMET_PEER_LOCK);
		const withLock = checkDir(dir, { env: bin.env });
		expect(existsSync(marker)).toBe(true);
		expect({ code: withLock.code, err: withLock.err }).toEqual({ code: 0, err: '' });
	}, 30_000);

	test('check с группой peers: pnpm выходит с 2 — первая строка stderr в находке, код 1', () => {
		const bin = fakeBin({ pnpm: 'echo; echo " ERR_PNPM_BOOM nope" >&2; exit 2' });
		const r = checkDir(peersRepo(UNMET_PEER_LOCK), { env: bin.env });
		expect(r.code).toBe(1);
		expect(r.err).toContain(
			'peers-unavailable: pnpm peers check — pnpm peers check exited with 2: ERR_PNPM_BOOM nope\n',
		);
	}, 30_000);

	test('check с группой peers: pnpm печатает справку вместо JSON — peers-unavailable, код 1', () => {
		const bin = fakeBin({ pnpm: 'echo "Usage: pnpm [command] [flags]"; exit 0' });
		const r = checkDir(peersRepo(UNMET_PEER_LOCK), { env: bin.env });
		expect(r.code).toBe(1);
		expect(r.err).toContain(
			'peers-unavailable: pnpm peers check — pnpm peers check output is not JSON\n',
		);
	}, 30_000);

	test('check с группой peers: pnpm нет на PATH — peers-unavailable с причиной запуска, код 1', () => {
		const dir = peersRepo(UNMET_PEER_LOCK);
		const r = checkDir(dir, { env: { PATH: '/nonexistent' } });
		expect(r.code).toBe(1);
		expect(r.err).toContain(
			'peers-unavailable: pnpm peers check — pnpm peers check did not start: Executable not found in $PATH: "pnpm"\n',
		);
	}, 30_000);

	test('check с группой peers: pnpm зовётся в корне --repo с аргументами гейта и без GH_TOKEN', () => {
		const bin = fakeBin({ pnpm: 'echo "cwd=$PWD args=$* token=${GH_TOKEN-unset}" >&2; exit 2' });
		const dir = peersRepo(UNMET_PEER_LOCK);
		const r = checkDir(dir, { env: { ...bin.env, GH_TOKEN: 'secret-token' } });
		expect(r.code).toBe(1);
		expect(r.err).toContain(
			`pnpm peers check exited with 2: cwd=${realpathSync(dir)} args=peers check --lockfile-only --json token=unset\n`,
		);
	}, 30_000);
});

describe('помощники приёмки: окружение', () => {
	test('checkDir: окружение идёт и в adapter, и в checkRepo', () => {
		const marker = join(mkdtempSync(join(tmpdir(), 'stack-log-')), 'pnpm.called');
		const bin = fakeBin({ pnpm: `touch ${marker}; echo '{}'` });
		const dir = repoDir(BARE);
		initRepo(dir, { with: ['peers', 'repo-rules'] });
		syncDir(dir);
		writeFileSync(join(dir, 'pnpm-lock.yaml'), UNMET_PEER_LOCK);
		const r = checkDir(dir, {
			env: {
				...bin.env,
				GITHUB_ACTIONS: 'true',
				GITHUB_EVENT_NAME: 'pull_request',
				GITHUB_BASE_REF: '',
			},
		});
		// adapter pnpm: подставной pnpm с PATH из env позван; checkRepo: GITHUB_* из env дошли до базы PR.
		expect(existsSync(marker)).toBe(true);
		expect(r.code).toBe(1);
		expect(r.err).toContain('GITHUB_BASE_REF is empty in a pull_request job');
	}, 30_000);

	test('baselineDir: окружение идёт в adapter pnpm', () => {
		const marker = join(mkdtempSync(join(tmpdir(), 'stack-log-')), 'pnpm.called');
		const bin = fakeBin({ pnpm: `touch ${marker}; echo '{}'` });
		const r = baselineDir(peersRepo(UNMET_PEER_LOCK), 'init', bin.env);
		expect(r).toStrictEqual({
			code: 0,
			out: 'wrote .stack-peers-baseline.json: 0 entr(ies)\n',
			err: '',
		});
		expect(existsSync(marker)).toBe(true);
	}, 30_000);
});

// UNMET_PEER_LOCK после починки: стоит peer@2.0.0, decl доволен — pnpm записей не видит.
const FIXED_PEER_LOCK = UNMET_PEER_LOCK.replaceAll('peer@1.0.0', 'peer@2.0.0')
	.replace(
		'specifier: 1.0.0\n        version: 1.0.0\n\npackages',
		'specifier: 2.0.0\n        version: 2.0.0\n\npackages',
	)
	.replace('      peer: 1.0.0\n', '      peer: 2.0.0\n');

describe('peers-baseline на настоящем pnpm', () => {
	test('peers-baseline: init, затем check — код 0; лок починили — check краснеет на stale, peers-baseline — снова 0', () => {
		const dir = peersRepo(UNMET_PEER_LOCK);
		const bin = fakeBin({ pnpm: `exec "${protoBin('pnpm')}" "$@"` });
		const env = { ...bin.env, npm_config_registry: 'http://127.0.0.1:9/' };
		const init = baselineDir(dir, 'init', env);
		expect({ code: init.code, out: init.out, err: init.err }).toEqual({
			code: 0,
			out: 'wrote .stack-peers-baseline.json: 1 entr(ies)\n',
			err: '',
		});
		const clean = checkDir(dir, { env });
		expect(clean.code, clean.err).toBe(0);

		writeFileSync(join(dir, 'pnpm-lock.yaml'), FIXED_PEER_LOCK);
		const stale = checkDir(dir, { env });
		expect(stale.code).toBe(1);
		expect(stale.err).toContain(
			'stale-peer-baseline: peer in . — recorded unmet by decl (found 1) is gone; drop it with: stack peers-baseline\n',
		);
		const lowered = baselineDir(dir, 'lower', env);
		expect({ code: lowered.code, out: lowered.out, err: lowered.err }).toEqual({
			code: 0,
			out: 'wrote .stack-peers-baseline.json: 0 entr(ies) (-1 fixed, +0 new)\n',
			err: '',
		});
		const again = checkDir(dir, { env });
		expect(again.code, again.err).toBe(0);
	}, 60_000);

	test('peers-baseline: новая запись — без флагов код 1, с --allow-grow принята', () => {
		const dir = peersRepo(FIXED_PEER_LOCK);
		const bin = fakeBin({ pnpm: `exec "${protoBin('pnpm')}" "$@"` });
		const env = { ...bin.env, npm_config_registry: 'http://127.0.0.1:9/' };
		expect(baselineDir(dir, 'init', env).out).toBe(
			'wrote .stack-peers-baseline.json: 0 entr(ies)\n',
		);
		writeFileSync(join(dir, 'pnpm-lock.yaml'), UNMET_PEER_LOCK);
		const lower = baselineDir(dir, 'lower', env);
		expect({ code: lower.code, out: lower.out, err: lower.err }).toEqual({
			code: 1,
			out: '',
			err:
				'new: peer in . — decl@1.0.0 wants ^2.0.0, found 1.0.0\n' +
				'1 new entr(ies) — fix them or pass --allow-grow\n',
		});
		const grow = baselineDir(dir, 'grow', env);
		expect({ code: grow.code, out: grow.out, err: grow.err }).toEqual({
			code: 0,
			out: 'wrote .stack-peers-baseline.json: 1 entr(ies) (-0 fixed, +1 new)\n',
			err: '',
		});
		const check = checkDir(dir, { env });
		expect(check.code, check.err).toBe(0);
	}, 60_000);
});
