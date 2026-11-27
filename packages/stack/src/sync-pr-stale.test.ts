import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { type OpenPr, type PublishOptions, stalePrs } from './sync-pr.ts';
import {
	botPr,
	fakeGitHub,
	git,
	gitRepo,
	isolateGitConfig,
	opts,
	PR_URL,
	put,
	run,
} from './testkit.ts';
import { ACME_SETTINGS } from './testkit-sources.ts';

let restore: () => void;
beforeAll(() => {
	restore = isolateGitConfig();
});
afterAll(() => restore());

const pushBranch = (dir: string, branch: string): void => {
	git(dir, 'push', 'origin', `main:refs/heads/${branch}`);
};
const remoteHeads = (dir: string): string =>
	git(dir, 'for-each-ref', '--format=%(refname)', 'refs/heads');
const prUrl = (n: number): string => `https://github.com/acme/app/pull/${n}`;

describe('stalePrs', () => {
	test('только PR бота своей базы со строго меньшей версией, в порядке входа', () => {
		const prs: OpenPr[] = [
			botPr(1, '1.9.2'),
			botPr(2, '1.12.0'),
			botPr(3, '1.13.0'),
			botPr(4, '1.14.0'),
			botPr(5, '1.12.0', 'staging'),
			botPr(6, '1.12.0', 'main', 'alice'),
			{ ...botPr(7, '1.12.0'), head: 'stack/v1.12' },
			{ ...botPr(8, '1.12.0'), head: 'stack/v1.12.0-fix' },
			{ ...botPr(9, '1.12.0'), head: 'renovate/x' },
		];
		const stale = stalePrs(prs, { version: '1.13.0', base: 'main', bot: 'acme-bot[bot]' });
		expect(stale.map((p) => p.number)).toStrictEqual([1, 2]);
		expect(stale).toHaveLength(2);
	});

	test('PR бота своей базы без поля ветки не попадает под правило', () => {
		const broken = {
			number: 1,
			url: prUrl(1),
			base: 'main',
			author: 'acme-bot[bot]',
		} as unknown as OpenPr;
		expect(stalePrs([broken], { version: '1.13.0', base: 'main', bot: 'acme-bot[bot]' })).toEqual(
			[],
		);
	});
});

describe('publishChanges: устаревшие sync-PR', () => {
	const opts13 = (dir: string, over: Partial<PublishOptions> = {}) =>
		opts(dir, { version: '1.13.0', ...over });
	const replaced = (n: number): [number, string] => [n, `Заменён ${PR_URL} — канон 1.13.0.`];

	test('sync-PR 1.13.0 закрывает PR бота 1.12.0, 1.11.0 и 1.9.2; PR не бота, другой базы, новее и не той ветки не трогает', async () => {
		const { dir, remote } = gitRepo({ 'a.txt': 'a' });
		put(dir, 'b.txt', 'b');
		const list = [
			botPr(11, '1.12.0'),
			botPr(10, '1.11.0'),
			botPr(9, '1.9.2'),
			botPr(12, '1.14.0'),
			botPr(13, '1.10.0', 'staging'),
			botPr(14, '1.10.0', 'main', 'alice'),
			{ ...botPr(15, '1.10.0'), head: 'stack/v1.13.0-fix' },
		];
		for (const pr of list) pushBranch(dir, pr.head);
		const { github, closed } = fakeGitHub({}, list);
		const r = await run(opts13(dir), github);
		expect(r.code).toBe(0);
		expect(closed).toEqual([replaced(11), replaced(10), replaced(9)]);
		const heads = remoteHeads(remote);
		for (const gone of ['stack/v1.12.0', 'stack/v1.11.0', 'stack/v1.9.2']) {
			expect(heads).not.toContain(`refs/heads/${gone}\n`);
		}
		for (const kept of ['stack/v1.14.0', 'stack/v1.10.0', 'stack/v1.13.0-fix']) {
			expect(heads).toContain(`refs/heads/${kept}\n`);
		}
		expect(r.out).toEqual([
			'pushed stack/v1.13.0',
			`opened PR ${PR_URL}`,
			`closed PR ${prUrl(11)} (stack/v1.12.0)`,
			`closed PR ${prUrl(10)} (stack/v1.11.0)`,
			`closed PR ${prUrl(9)} (stack/v1.9.2)`,
		]);
	});

	test('повторный запуск той же версии ничего не закрывает', async () => {
		const { dir, remote } = gitRepo({ 'a.txt': 'a' });
		put(dir, 'b.txt', 'b');
		const list = [
			botPr(11, '1.12.0'),
			botPr(12, '1.14.0'),
			botPr(13, '1.10.0', 'staging'),
			botPr(14, '1.10.0', 'main', 'alice'),
			{ ...botPr(15, '1.10.0'), head: 'stack/v1.13.0-fix' },
		];
		for (const pr of list) pushBranch(dir, pr.head);
		const fake = fakeGitHub({}, list);
		await run(opts13(dir), fake.github);
		expect(fake.closed).toHaveLength(1);

		const clone = mkdtempSync(join(tmpdir(), 'stack-clone-'));
		git(clone, 'clone', remote, '.');
		put(clone, 'c.txt', 'c');
		git(clone, 'add', 'c.txt');
		git(clone, 'commit', '-m', 'base moved');
		git(clone, 'push', 'origin', 'main');
		put(clone, 'b.txt', 'b');
		const r = await run(opts13(clone), fake.github);

		expect(fake.closed).toHaveLength(1);
		expect(fake.created).toHaveLength(1);
		expect(r.out.at(-1)).toBe(`updated PR ${PR_URL}`);
	});

	test('раздача старой версии не закрывает PR новее', async () => {
		const { dir, remote } = gitRepo({ 'a.txt': 'a' });
		put(dir, 'b.txt', 'b');
		for (const v of ['1.13.0', '1.11.0']) pushBranch(dir, `stack/v${v}`);
		const { github, closed } = fakeGitHub({}, [botPr(20, '1.13.0'), botPr(19, '1.11.0')]);
		const r = await run(opts(dir, { version: '1.12.0' }), github);
		expect(r.code).toBe(0);
		expect(closed.map(([n]) => n)).toEqual([19]);
		expect(remoteHeads(remote)).toContain('refs/heads/stack/v1.13.0\n');
		expect(remoteHeads(remote)).not.toContain('refs/heads/stack/v1.11.0\n');
	});

	test('коммитить нечего — комментарий закрытия следует настройкам канона', async () => {
		const { dir } = gitRepo({ 'a.txt': 'a' });
		pushBranch(dir, 'stack/v1.12.0');
		const { github, closed } = fakeGitHub({}, [botPr(11, '1.12.0')]);
		const r = await run(opts13(dir), github, ACME_SETTINGS.syncPr);
		expect(r.code).toBe(0);
		expect(closed).toStrictEqual([[11, 'Canon 1.13.0 is already in main.']]);
	});

	test('коммитить нечего — PR старших версий закрываются, бот не ищется', async () => {
		const { dir, remote } = gitRepo({ 'a.txt': 'a' });
		pushBranch(dir, 'stack/v1.12.0');
		const { github, calls, closed } = fakeGitHub({}, [botPr(11, '1.12.0')]);
		const r = await run(opts13(dir), github);
		expect(r.code).toBe(0);
		expect(calls).toEqual(['defaultBranch', 'openPrs', 'closePr']);
		expect(closed).toEqual([[11, 'Канон 1.13.0 уже в `main` — этот PR устарел.']]);
		expect(r.out).toEqual([
			'canon already applied, nothing to commit',
			`closed PR ${prUrl(11)} (stack/v1.12.0)`,
		]);
		expect(remoteHeads(remote)).not.toContain('stack/v1.12.0');
		expect(remoteHeads(remote)).not.toContain('stack/v1.13.0');
	});

	test('--base staging — устаревшие ищутся на staging, defaultBranch не зовётся', async () => {
		const { dir } = gitRepo({ 'a.txt': 'a' });
		put(dir, 'b.txt', 'b');
		pushBranch(dir, 'stack/v1.12.0');
		pushBranch(dir, 'stack/v1.11.0');
		const { github, calls, closed, created } = fakeGitHub({}, [
			botPr(13, '1.12.0', 'staging'),
			botPr(11, '1.11.0', 'main'),
		]);
		const r = await run(opts13(dir, { base: 'staging' }), github);
		expect(r.code).toBe(0);
		expect(closed.map(([n]) => n)).toEqual([13]);
		expect(created[0]?.base).toBe('staging');
		expect(calls).not.toContain('defaultBranch');
	});

	test('ветка с открытым PR другой базы не удаляется', async () => {
		const { dir, remote } = gitRepo({ 'a.txt': 'a' });
		put(dir, 'b.txt', 'b');
		pushBranch(dir, 'stack/v1.12.0');
		const { github, closed, open } = fakeGitHub({}, [
			botPr(11, '1.12.0', 'main'),
			botPr(13, '1.12.0', 'staging'),
		]);
		const r = await run(opts13(dir), github);
		expect(r.code).toBe(0);
		expect(closed.map(([n]) => n)).toEqual([11]);
		expect(open.map((p) => p.number)).toContain(13);
		expect(remoteHeads(remote)).toContain('refs/heads/stack/v1.12.0\n');
		expect(r.out.at(-1)).toBe(
			`closed PR ${prUrl(11)} (stack/v1.12.0 kept: ${prUrl(13)} is open on it)`,
		);
	});

	test('закрытие упало — код 1, причина и PR названы, свой PR уже открыт', async () => {
		const { dir, remote } = gitRepo({ 'a.txt': 'a' });
		put(dir, 'b.txt', 'b');
		pushBranch(dir, 'stack/v1.12.0');
		pushBranch(dir, 'stack/v1.11.0');
		const { github, created, closed } = fakeGitHub(
			{
				closePr: async () => {
					throw new Error('boom');
				},
			},
			[botPr(11, '1.12.0'), botPr(10, '1.11.0')],
		);
		const r = await run(opts13(dir), github);
		expect(r.code).toBe(1);
		expect(r.err).toEqual([`sync-pr: closing PR ${prUrl(11)} failed: boom`]);
		expect(created).toHaveLength(1);
		expect(closed).toEqual([]);
		expect(remoteHeads(remote)).toContain('refs/heads/stack/v1.12.0\n');
		expect(remoteHeads(remote)).toContain('refs/heads/stack/v1.11.0\n');
	});

	test('ветки нет в remote — код 1, git push --delete назван', async () => {
		const { dir } = gitRepo({ 'a.txt': 'a' });
		put(dir, 'b.txt', 'b');
		const { github } = fakeGitHub({}, [botPr(11, '1.12.0')]);
		const r = await run(opts13(dir), github);
		expect(r.code).toBe(1);
		expect(r.err[0]).toStartWith('sync-pr: git push --delete stack/v1.12.0 failed:');
	});

	test('ветка по умолчанию не нашлась — код 1, ничего не запушено', async () => {
		const { dir, remote } = gitRepo({ 'a.txt': 'a' });
		put(dir, 'b.txt', 'b');
		const { github } = fakeGitHub({
			defaultBranch: async () => {
				throw new Error('boom');
			},
		});
		const r = await run(opts13(dir), github);
		expect(r.code).toBe(1);
		expect(r.err).toEqual(['sync-pr: default branch lookup failed: boom']);
		expect(remoteHeads(remote)).not.toContain('stack/v1.13.0');
	});

	test('PR на ту же ветку в другую базу — не свой: PR в базу запуска создаётся', async () => {
		const { dir } = gitRepo({ 'a.txt': 'a' });
		put(dir, 'b.txt', 'b');
		pushBranch(dir, 'stack/v1.12.0');
		const { github, created, closed } = fakeGitHub({}, [
			botPr(30, '1.13.0', 'staging'),
			botPr(11, '1.12.0'),
		]);
		const r = await run(opts13(dir), github);
		expect(r.code).toBe(0);
		expect(created[0]?.base).toBe('main');
		expect(closed).toEqual([replaced(11)]);
	});

	test('PR человека на той же паре head+base — свой: переиспользован, комментарий ссылается на него', async () => {
		const { dir } = gitRepo({ 'a.txt': 'a' });
		put(dir, 'b.txt', 'b');
		pushBranch(dir, 'stack/v1.12.0');
		const own = botPr(30, '1.13.0', 'main', 'alice');
		const { github, created, closed } = fakeGitHub({}, [own, botPr(11, '1.12.0')]);
		const r = await run(opts13(dir), github);
		expect(r.code).toBe(0);
		expect(created).toEqual([]);
		expect(r.out).toContain(`updated PR ${own.url}`);
		expect(closed).toEqual([[11, `Заменён ${own.url} — канон 1.13.0.`]]);
	});

	test('коммитить нечего, список PR не получен — код 1, ничего не закрыто', async () => {
		const { dir } = gitRepo({ 'a.txt': 'a' });
		const { github, closed } = fakeGitHub({
			openPrs: async () => {
				throw new Error('boom');
			},
		});
		const r = await run(opts13(dir), github);
		expect(r.code).toBe(1);
		expect(r.err).toEqual(['sync-pr: listing open PRs failed: boom']);
		expect(r.out).toEqual(['canon already applied, nothing to commit']);
		expect(closed).toEqual([]);
	});

	test('комментарий закрытия следует настройкам канона', async () => {
		const { dir } = gitRepo({ 'a.txt': 'a' });
		put(dir, 'b.txt', 'b');
		pushBranch(dir, 'stack/v1.12.0');
		const own = botPr(30, '1.13.0', 'main', 'alice');
		const { github, closed } = fakeGitHub({}, [own, botPr(11, '1.12.0')]);
		const r = await run(opts13(dir), github, ACME_SETTINGS.syncPr);
		expect(r.code).toBe(0);
		expect(closed).toStrictEqual([[11, `Superseded by ${own.url} (1.13.0).`]]);
	});
});
