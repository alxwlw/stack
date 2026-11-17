import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { expect, test } from 'bun:test';

import { type Exec, ghGitHub, spawnExec } from './gh.ts';

const REPO = '/work/repo';
type Call = [string, readonly string[], string | undefined];
type Result = { status: number | null; stdout: string; stderr: string; signal?: string | null };

// Фальшивый Exec: пишет вызовы и отдаёт заданный результат.
function fake(result: Partial<Result>): { exec: Exec; calls: Call[]; cwds: string[] } {
	const calls: Call[] = [];
	const cwds: string[] = [];
	const exec: Exec = (cmd, args, opts) => {
		calls.push([cmd, args, opts.input]);
		cwds.push(opts.cwd);
		return { status: 0, stdout: '', stderr: '', ...result };
	};
	return { exec, calls, cwds };
}

test('botUserId: gh api /users/<slug>[bot] --jq .id, число из stdout', async () => {
	const { exec, calls } = fake({ stdout: '42\n' });
	expect(await ghGitHub(REPO, exec).botUserId('acme-bot')).toBe(42);
	expect(calls).toEqual([['gh', ['api', '/users/acme-bot[bot]', '--jq', '.id'], undefined]]);
});

test('botUserId: пустой или нечисловой ответ — throw', async () => {
	for (const stdout of ['', 'null\n']) {
		const { exec } = fake({ stdout });
		await expect(ghGitHub(REPO, exec).botUserId('acme-bot')).rejects.toThrow(
			'gh api returned no user id for acme-bot[bot]',
		);
	}
});

test('openPr: открытый PR — URL, нет — undefined', async () => {
	const open = fake({ stdout: 'https://github.com/acme/app/pull/7\n' });
	expect(await ghGitHub(REPO, open.exec).openPr('stack/v1.2.3')).toBe(
		'https://github.com/acme/app/pull/7',
	);
	expect(open.calls[0]?.[1]).toEqual([
		'pr',
		'list',
		'--head',
		'stack/v1.2.3',
		'--state',
		'open',
		'--json',
		'url',
		'--jq',
		'.[0].url // ""',
	]);
	const none = fake({ stdout: '\n' });
	expect(await ghGitHub(REPO, none.exec).openPr('stack/v1.2.3')).toBeUndefined();
});

test('createPr: тело через stdin, --base только когда задан, URL — последняя строка stdout', async () => {
	const stdout = 'Creating pull request…\nhttps://github.com/acme/app/pull/8\n';
	const pr = { head: 'stack/v1.2.3', title: 'chore(stack): канон 1.2.3', body: 'тело PR\n' };
	const head = [
		'pr',
		'create',
		'--title',
		'chore(stack): канон 1.2.3',
		'--body-file',
		'-',
		'--head',
		'stack/v1.2.3',
	];

	const plain = fake({ stdout });
	expect(await ghGitHub(REPO, plain.exec).createPr(pr)).toBe('https://github.com/acme/app/pull/8');
	expect(plain.calls).toEqual([['gh', head, 'тело PR\n']]);

	const empty = fake({ stdout });
	await ghGitHub(REPO, empty.exec).createPr({ ...pr, base: '' });
	expect(empty.calls[0]?.[1]).toEqual(head);

	const staged = fake({ stdout });
	await ghGitHub(REPO, staged.exec).createPr({ ...pr, base: 'staging' });
	expect(staged.calls[0]?.[1]).toEqual([...head, '--base', 'staging']);
});

test('ненулевой код gh — throw со stderr', async () => {
	const { exec } = fake({ status: 1, stderr: 'HTTP 403\n' });
	await expect(
		ghGitHub(REPO, exec).createPr({ head: 'stack/v1.2.3', title: 't', body: 'b' }),
	).rejects.toThrow('gh pr create exited with 1: HTTP 403');
});

test('каждый вызов gh идёт в cwd репозитория', async () => {
	const f = fake({ stdout: '42\n' });
	const github = ghGitHub(REPO, f.exec);
	await github.botUserId('acme-bot');
	await github.openPr('stack/v1.2.3');
	const g = fake({ stdout: 'https://github.com/acme/app/pull/8\n' });
	await ghGitHub(REPO, g.exec).createPr({ head: 'h', title: 't', body: 'b' });
	expect(f.cwds).toEqual([REPO, REPO]);
	expect(g.cwds).toEqual([REPO]);
});

test('status null без сигнала — throw с exited with null', async () => {
	const { exec } = fake({ status: null, stderr: 'boom\n' });
	await expect(ghGitHub(REPO, exec).openPr('h')).rejects.toThrow(
		'gh pr list exited with null: boom',
	);
});

test('gh убит сигналом — throw называет сигнал', async () => {
	const { exec } = fake({ status: null, signal: 'SIGTERM' });
	await expect(ghGitHub(REPO, exec).openPr('h')).rejects.toThrow('gh pr list killed by SIGTERM');
});

test('createPr: gh вышел с 0 и пустым stdout — throw, не пустой URL', async () => {
	const { exec } = fake({ status: 0, stdout: '' });
	await expect(ghGitHub(REPO, exec).createPr({ head: 'h', title: 't', body: 'b' })).rejects.toThrow(
		'no PR URL',
	);
});

test('spawnExec: бинаря нет — status null и текст ошибки с именем бинаря', () => {
	const r = spawnExec('stack-no-such-binary', [], { cwd: tmpdir() });
	expect(r.status).toBeNull();
	expect(r.stdout).toBe('');
	expect(r.stderr).toContain('stack-no-such-binary');
});

test('spawnExec: input уходит в stdin, stdout — строка, cwd применён', () => {
	expect(spawnExec('cat', [], { cwd: tmpdir(), input: 'x' })).toMatchObject({
		status: 0,
		stdout: 'x',
	});
	expect(spawnExec('pwd', [], { cwd: realpathSync(tmpdir()) }).stdout.trim()).toBe(
		realpathSync(tmpdir()),
	);
});

test('spawnExec: убитый сигналом процесс — signal в результате', () => {
	const r = spawnExec('sh', ['-c', 'kill -TERM $$'], { cwd: tmpdir() });
	expect(r.status).toBeNull();
	expect(r.signal).toBe('SIGTERM');
});
