import { expect, test } from 'bun:test';

import { type Exec, ghGitHub, spawnExec } from './gh.ts';

type Call = [string, readonly string[], string | undefined];
type Result = { status: number | null; stdout: string; stderr: string };

// Фальшивый Exec: пишет вызовы и отдаёт заданный результат.
function fake(result: Partial<Result>): { exec: Exec; calls: Call[] } {
	const calls: Call[] = [];
	const exec: Exec = (cmd, args, input) => {
		calls.push([cmd, args, input]);
		return { status: 0, stdout: '', stderr: '', ...result };
	};
	return { exec, calls };
}

test('botUserId: gh api /users/<slug>[bot] --jq .id, число из stdout', async () => {
	const { exec, calls } = fake({ stdout: '42\n' });
	expect(await ghGitHub(exec).botUserId('acme-bot')).toBe(42);
	expect(calls).toEqual([['gh', ['api', '/users/acme-bot[bot]', '--jq', '.id'], undefined]]);
});

test('botUserId: пустой или нечисловой ответ — throw', async () => {
	for (const stdout of ['', 'null\n']) {
		const { exec } = fake({ stdout });
		await expect(ghGitHub(exec).botUserId('acme-bot')).rejects.toThrow(
			'gh api returned no user id for acme-bot[bot]',
		);
	}
});

test('openPr: открытый PR — URL, нет — undefined', async () => {
	const open = fake({ stdout: 'https://github.com/acme/app/pull/7\n' });
	expect(await ghGitHub(open.exec).openPr('stack/v1.2.3')).toBe(
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
	expect(await ghGitHub(none.exec).openPr('stack/v1.2.3')).toBeUndefined();
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
	expect(await ghGitHub(plain.exec).createPr(pr)).toBe('https://github.com/acme/app/pull/8');
	expect(plain.calls).toEqual([['gh', head, 'тело PR\n']]);

	const empty = fake({ stdout });
	await ghGitHub(empty.exec).createPr({ ...pr, base: '' });
	expect(empty.calls[0]?.[1]).toEqual(head);

	const staged = fake({ stdout });
	await ghGitHub(staged.exec).createPr({ ...pr, base: 'staging' });
	expect(staged.calls[0]?.[1]).toEqual([...head, '--base', 'staging']);
});

test('ненулевой код gh — throw со stderr', async () => {
	const { exec } = fake({ status: 1, stderr: 'HTTP 403\n' });
	await expect(
		ghGitHub(exec).createPr({ head: 'stack/v1.2.3', title: 't', body: 'b' }),
	).rejects.toThrow('gh pr create exited with 1: HTTP 403');
});

test('spawnExec: бинаря нет — status null и текст ошибки', () => {
	const r = spawnExec('stack-no-such-binary', []);
	expect(r.status).toBeNull();
	expect(r.stderr).not.toBe('');
});
