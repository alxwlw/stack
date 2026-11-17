import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { type GitHub, type NewPr, prBody, publishChanges, type PublishOptions } from './sync-pr.ts';
import { git, gitRepo, isolateGitConfig } from './testkit.ts';

const PR_URL = 'https://github.com/acme/app/pull/1';

let restore: () => void;
beforeAll(() => {
	restore = isolateGitConfig();
});
afterAll(() => restore());

function fakeGitHub(over: Partial<GitHub> = {}): {
	github: GitHub;
	calls: string[];
	created: NewPr[];
} {
	const calls: string[] = [];
	const created: NewPr[] = [];
	const github: GitHub = {
		botUserId: async () => {
			calls.push('botUserId');
			return 42;
		},
		openPr: async () => {
			calls.push('openPr');
			return undefined;
		},
		createPr: async (pr) => {
			calls.push('createPr');
			created.push(pr);
			return PR_URL;
		},
		...over,
	};
	return { github, calls, created };
}

function put(dir: string, path: string, content: string): void {
	mkdirSync(dirname(join(dir, path)), { recursive: true });
	writeFileSync(join(dir, path), content);
}

async function run(
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

const opts = (dir: string, over: Partial<PublishOptions> = {}): PublishOptions => ({
	repoRoot: dir,
	version: '1.2.3',
	appSlug: 'acme-bot',
	...over,
});

describe('publishChanges', () => {
	test('изменений нет — строка, код 0, ни ветки, ни вызовов GitHub', async () => {
		const { dir } = gitRepo({ 'a.txt': 'a' });
		const { github, calls } = fakeGitHub();
		const r = await run(opts(dir), github);
		expect(r.code).toBe(0);
		expect(r.out).toEqual(['canon already applied, nothing to commit']);
		expect(calls).toEqual([]);
		expect(git(dir, 'branch', '--list', 'stack/v1.2.3')).toBe('');
	});

	test('новые файлы в новом каталоге перечислены пофайлово', async () => {
		const { dir } = gitRepo({ 'a.txt': 'a' });
		put(dir, '.moon/tasks/stack.yml', 'x');
		put(dir, '.moon/toolchain.yml', 'y');
		const { github, created } = fakeGitHub();
		await run(opts(dir), github);
		expect(created[0]?.body).toBe(
			prBody('1.2.3', ['.moon/tasks/stack.yml', '.moon/toolchain.yml']),
		);
	});

	test('имя с пробелом и кириллицей — как есть, без кавычек', async () => {
		const { dir } = gitRepo({ 'a.txt': 'a' });
		put(dir, 'docs/a b.md', 'x');
		put(dir, 'docs/канон.md', 'y');
		const { github, created } = fakeGitHub();
		await run(opts(dir), github);
		const body = created[0]?.body ?? '';
		expect(body).toContain('- docs/a b.md\n');
		expect(body).toContain('- docs/канон.md\n');
		expect(body).not.toContain('"');
		expect(body).not.toContain('\\3');
	});

	test('игнорируемый файл не попадает ни в список, ни в commit', async () => {
		const { dir, remote } = gitRepo({ '.gitignore': 'node_modules/\n' });
		put(dir, 'node_modules/x/index.js', 'x');
		put(dir, 'a.txt', 'a');
		const { github, created } = fakeGitHub();
		await run(opts(dir), github);
		expect(created[0]?.body).toBe(prBody('1.2.3', ['a.txt']));
		expect(git(remote, 'ls-tree', '-r', '--name-only', 'stack/v1.2.3')).not.toContain(
			'node_modules/',
		);
	});

	test('переименование хуком: оба пути по одному разу, без «->»', async () => {
		const { dir } = gitRepo({ 'a.txt': 'a' });
		git(dir, 'mv', 'a.txt', 'b.txt');
		const { github, created } = fakeGitHub();
		await run(opts(dir), github);
		expect(created[0]?.body).toBe(prBody('1.2.3', ['b.txt', 'a.txt']));
	});

	test('commit: автор и коммитер — бот, сообщение, ветка от HEAD; вывод', async () => {
		const { dir, remote } = gitRepo({ 'a.txt': 'a' });
		const tip = git(dir, 'rev-parse', 'main');
		put(dir, 'b.txt', 'b');
		const { github } = fakeGitHub();
		const r = await run(opts(dir), github);
		const bot = 'acme-bot[bot] <42+acme-bot[bot]@users.noreply.github.com>';
		expect(git(remote, 'log', '-1', '--format=%an <%ae>|%cn <%ce>|%s', 'stack/v1.2.3')).toBe(
			`${bot}|${bot}|chore(stack): канон 1.2.3\n`,
		);
		expect(git(remote, 'rev-parse', 'stack/v1.2.3^')).toBe(tip);
		expect(r.out).toEqual(['pushed stack/v1.2.3', `opened PR ${PR_URL}`]);
	});

	test('PR: заголовок, head, без --base — base не передаётся', async () => {
		const { dir } = gitRepo({ 'a.txt': 'a' });
		put(dir, 'b.txt', 'b');
		const { github, created } = fakeGitHub();
		await run(opts(dir), github);
		expect(created).toHaveLength(1);
		const pr = created[0] as NewPr;
		expect(pr.head).toBe('stack/v1.2.3');
		expect(pr.title).toBe('chore(stack): канон 1.2.3');
		expect('base' in pr).toBe(false);
	});

	test('--base передаётся в создание PR', async () => {
		const { dir } = gitRepo({ 'a.txt': 'a' });
		put(dir, 'b.txt', 'b');
		const { github, created } = fakeGitHub();
		await run(opts(dir, { base: 'staging' }), github);
		expect(created[0]?.base).toBe('staging');
	});

	test('prBody — текст sync.yml, список пофайлово', () => {
		expect(prBody('1.2.3', ['a.txt', 'b/c.txt'])).toBe(
			'Канон `@alxwlw/stack@1.2.3` применён к репозиторию.\n\nИзменённые файлы:\n- a.txt\n- b/c.txt\n\nРелиз: https://github.com/alxwlw/stack/releases/tag/v1.2.3\n',
		);
	});

	test('повторный запуск: ветка пересоздана от нового HEAD, открытый PR переиспользован', async () => {
		const { dir, remote } = gitRepo({ 'a.txt': 'a' });
		put(dir, 'b.txt', 'b');
		const first = fakeGitHub();
		await run(opts(dir), first.github);

		const clone = mkdtempSync(join(tmpdir(), 'stack-clone-'));
		git(clone, 'clone', remote, '.');
		put(clone, 'c.txt', 'c');
		git(clone, 'add', 'c.txt');
		git(clone, 'commit', '-m', 'base moved');
		git(clone, 'push', 'origin', 'main');
		put(clone, 'b.txt', 'b');
		const second = fakeGitHub({
			openPr: async () => PR_URL,
		});
		const r = await run(opts(clone), second.github);

		expect(first.created).toHaveLength(1);
		expect(second.created).toHaveLength(0);
		expect(r.out.at(-1)).toBe(`updated PR ${PR_URL}`);
		expect(git(remote, 'rev-parse', 'stack/v1.2.3^')).toBe(git(remote, 'rev-parse', 'main'));
		expect(git(remote, 'rev-list', '--count', 'main..stack/v1.2.3')).toBe('1\n');
	});

	test('push отклонён — код 1, PR не ищется и не создаётся', async () => {
		const { dir, remote } = gitRepo({ 'a.txt': 'a' });
		put(remote, 'hooks/pre-receive', '#!/bin/sh\nexit 1\n');
		chmodSync(join(remote, 'hooks/pre-receive'), 0o755);
		put(dir, 'b.txt', 'b');
		const { github, calls } = fakeGitHub();
		const r = await run(opts(dir), github);
		expect(r.code).toBe(1);
		expect(r.err[0]).toStartWith('sync-pr: git push failed:');
		expect(calls).toEqual(['botUserId']);
	});

	test('пользователь бота не найден — код 1, commit не создан', async () => {
		const { dir } = gitRepo({ 'a.txt': 'a' });
		put(dir, 'b.txt', 'b');
		const { github } = fakeGitHub({
			botUserId: async () => {
				throw new Error('not found');
			},
		});
		const r = await run(opts(dir), github);
		expect(r.code).toBe(1);
		expect(r.err).toEqual(['sync-pr: bot user lookup failed: not found']);
		expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main\n');
		expect(git(dir, 'branch', '--list', 'stack/v1.2.3')).toBe('');
	});

	test('поиск открытого PR упал — код 1, PR не создаётся', async () => {
		const { dir } = gitRepo({ 'a.txt': 'a' });
		put(dir, 'b.txt', 'b');
		const { github, calls } = fakeGitHub({
			openPr: async () => {
				throw new Error('boom');
			},
		});
		const r = await run(opts(dir), github);
		expect(r.code).toBe(1);
		expect(r.err).toEqual(['sync-pr: finding the open PR failed: boom']);
		expect(calls).not.toContain('createPr');
	});

	test('создание PR упало — код 1, ошибка названа, ветка уже в remote', async () => {
		const { dir, remote } = gitRepo({ 'a.txt': 'a' });
		put(dir, 'b.txt', 'b');
		const { github } = fakeGitHub({
			createPr: async () => {
				throw new Error('boom');
			},
		});
		const r = await run(opts(dir), github);
		expect(r.code).toBe(1);
		expect(r.err).toEqual(['sync-pr: creating the PR failed: boom']);
		expect(() => git(remote, 'rev-parse', '--verify', 'stack/v1.2.3')).not.toThrow();
	});
});
