import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { parse as parseYaml } from 'yaml';

import { loadCanon } from './canon.ts';
import type { Served } from './registry.ts';
import {
	type GitHub,
	type NewPr,
	type OpenPr,
	ownVersion,
	prBody,
	publishChanges,
	type PublishOptions,
	type RunProcess,
	stalePrs,
	SYNC_PR_WAIT,
	syncPr,
	type SyncPrOptions,
} from './sync-pr.ts';
import { git, gitRepo, isolateGitConfig, repoDir } from './testkit.ts';

const PR_URL = 'https://github.com/acme/app/pull/1';

let restore: () => void;
beforeAll(() => {
	restore = isolateGitConfig();
});
afterAll(() => restore());

function botPr(number: number, version: string, base = 'main', author = 'acme-bot[bot]'): OpenPr {
	return {
		number,
		url: `https://github.com/acme/app/pull/${number}`,
		head: `stack/v${version}`,
		base,
		author,
	};
}

// open — изменяемый список открытых PR: createPr добавляет свой, closePr убирает закрытый.
function fakeGitHub(
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
		botUserId: async () => {
			calls.push('botUserId');
			return 42;
		},
		createPr: async (pr) => {
			calls.push('createPr');
			created.push(pr);
			open.push({
				number: 100,
				url: PR_URL,
				head: pr.head,
				base: pr.base ?? '',
				author: 'acme-bot[bot]',
			});
			return PR_URL;
		},
		defaultBranch: async () => {
			calls.push('defaultBranch');
			return 'main';
		},
		openPrs: async () => {
			calls.push('openPrs');
			return [...open];
		},
		closePr: async (number, comment) => {
			calls.push('closePr');
			closed.push([number, comment]);
			const i = open.findIndex((p) => p.number === number);
			if (i >= 0) open.splice(i, 1);
		},
		...over,
	};
	return { github, calls, created, closed, open };
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
	test('изменений нет — строка, код 0, ни ветки, ни коммита; GitHub только ищет устаревшие PR', async () => {
		const { dir } = gitRepo({ 'a.txt': 'a' });
		const { github, calls } = fakeGitHub();
		const r = await run(opts(dir), github);
		expect(r.code).toBe(0);
		expect(r.out).toEqual(['canon already applied, nothing to commit']);
		expect(calls).toEqual(['defaultBranch', 'openPrs']);
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

	test('PR: заголовок, head, без --base — база из defaultBranch', async () => {
		const { dir } = gitRepo({ 'a.txt': 'a' });
		put(dir, 'b.txt', 'b');
		const { github, created } = fakeGitHub();
		await run(opts(dir), github);
		expect(created).toHaveLength(1);
		const pr = created[0] as NewPr;
		expect(pr.head).toBe('stack/v1.2.3');
		expect(pr.title).toBe('chore(stack): канон 1.2.3');
		expect(pr.base).toBe('main');
	});

	test('--base передаётся в создание PR', async () => {
		const { dir } = gitRepo({ 'a.txt': 'a' });
		put(dir, 'b.txt', 'b');
		const { github, created } = fakeGitHub();
		await run(opts(dir, { base: 'staging' }), github);
		expect(created[0]?.base).toBe('staging');
	});

	test('копия: исходный путь и новый по одному разу', async () => {
		const { dir } = gitRepo({ 'a.txt': 'x\n'.repeat(50) });
		git(dir, 'config', 'status.renames', 'copies');
		put(dir, 'a.txt', `${'x\n'.repeat(50)}y\n`);
		put(dir, 'b.txt', `${'x\n'.repeat(50)}y\n`);
		git(dir, 'add', '-A');
		const { github, created } = fakeGitHub();
		await run(opts(dir), github);
		expect(created[0]?.body).toBe(prBody('1.2.3', ['a.txt', 'b.txt']));
	});

	test('путь в списке один раз, даже если он и источник переименования, и новый файл', async () => {
		const { dir } = gitRepo({ 'a.txt': 'a' });
		git(dir, 'mv', 'a.txt', 'b.txt');
		put(dir, 'a.txt', 'new');
		const { github, created } = fakeGitHub();
		await run(opts(dir), github);
		expect(created[0]?.body).toBe(prBody('1.2.3', ['b.txt', 'a.txt']));
	});

	test('ветка уже есть локально — checkout -B её пересоздаёт, код 0', async () => {
		const { dir, remote } = gitRepo({ 'a.txt': 'a' });
		git(dir, 'branch', 'stack/v1.2.3');
		put(dir, 'b.txt', 'b');
		const { github } = fakeGitHub();
		const r = await run(opts(dir), github);
		expect(r.code).toBe(0);
		expect(git(remote, 'rev-parse', 'stack/v1.2.3^')).toBe(git(remote, 'rev-parse', 'main'));
	});

	test('пустой base — как без --base, база из defaultBranch', async () => {
		const { dir } = gitRepo({ 'a.txt': 'a' });
		put(dir, 'b.txt', 'b');
		const { github, created } = fakeGitHub();
		await run(opts(dir, { base: '' }), github);
		expect(created[0]?.base).toBe('main');
	});

	test('git status упал — код 1, причина git в сообщении, GitHub не зовётся', async () => {
		const dir = repoDir({ 'a.txt': 'a' });
		const saved = process.env.GIT_CEILING_DIRECTORIES;
		process.env.GIT_CEILING_DIRECTORIES = dirname(dir);
		try {
			const { github, calls } = fakeGitHub();
			const r = await run(opts(dir), github);
			expect(r.code).toBe(1);
			expect(r.err[0]).toStartWith('sync-pr: git status failed: fatal: not a git repository');
			expect(calls).toEqual([]);
		} finally {
			if (saved === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
			else process.env.GIT_CEILING_DIRECTORIES = saved;
		}
	});

	test("хуки consumer'а не запускаются — ни из .git/hooks, ни из core.hooksPath", async () => {
		const { dir, remote } = gitRepo({ 'a.txt': 'a' });
		const log = join(mkdtempSync(join(tmpdir(), 'stack-hooklog-')), 'hooks.log');
		const external = mkdtempSync(join(tmpdir(), 'stack-hooks-'));
		const hooks = [
			'pre-commit',
			'prepare-commit-msg',
			'commit-msg',
			'post-commit',
			'post-checkout',
			'reference-transaction',
			'pre-push',
		];
		for (const base of [join(dir, '.git', 'hooks'), external]) {
			mkdirSync(base, { recursive: true });
			for (const hook of hooks) {
				const path = join(base, hook);
				writeFileSync(path, `#!/bin/sh\necho ${hook} >> ${log}\nexit 1\n`);
				chmodSync(path, 0o755);
			}
		}
		git(dir, 'config', 'core.hooksPath', external);
		put(dir, 'b.txt', 'b');
		const { github } = fakeGitHub();
		const r = await run(opts(dir), github);
		expect(r.code).toBe(0);
		expect(existsSync(log)).toBe(false);
		expect(git(remote, 'log', '-1', '--format=%s', 'stack/v1.2.3')).toBe(
			'chore(stack): канон 1.2.3\n',
		);
	});

	test('filter из .git/config не получает GH_TOKEN', async () => {
		const { dir } = gitRepo({ 'a.txt': 'a' });
		const log = join(mkdtempSync(join(tmpdir(), 'stack-filterlog-')), 'filter.log');
		writeFileSync(join(dir, '.git', 'info', 'attributes'), '*.txt filter=probe\n');
		git(dir, 'config', 'filter.probe.clean', `echo "token=\${GH_TOKEN-unset}" >> '${log}'; cat`);
		put(dir, 'b.txt', 'b');
		const saved = process.env.GH_TOKEN;
		process.env.GH_TOKEN = 'secret-token';
		try {
			const { github } = fakeGitHub();
			expect((await run(opts(dir), github)).code).toBe(0);
		} finally {
			if (saved === undefined) delete process.env.GH_TOKEN;
			else process.env.GH_TOKEN = saved;
		}
		const lines = readFileSync(log, 'utf8')
			.split('\n')
			.filter((l) => l !== '');
		expect(lines.length).toBeGreaterThan(0);
		for (const l of lines) expect(l).toBe('token=unset');
	});

	test('prBody — текст описания PR, список пофайлово', () => {
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
		const r = await run(opts(clone), first.github);

		expect(first.created).toHaveLength(1);
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
		expect(r.err[0]?.endsWith('\n')).toBe(false);
		expect(calls).toEqual(['defaultBranch', 'botUserId']);
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

	test('поиск открытых PR упал — код 1, PR не создаётся', async () => {
		const { dir } = gitRepo({ 'a.txt': 'a' });
		put(dir, 'b.txt', 'b');
		const { github, calls } = fakeGitHub({
			openPrs: async () => {
				throw new Error('boom');
			},
		});
		const r = await run(opts(dir), github);
		expect(r.code).toBe(1);
		expect(r.err).toEqual(['sync-pr: listing open PRs failed: boom']);
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

	test('PR без заполненных полей ветки и автора не попадает под правило', () => {
		const broken = { number: 1, url: prUrl(1), base: 'main' } as unknown as OpenPr;
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
		const list = [botPr(11, '1.12.0'), botPr(12, '1.14.0'), botPr(13, '1.10.0', 'staging')];
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
		expect(r.out.at(-1)).toBe(`closed PR ${prUrl(11)} (stack/v1.12.0)`);
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
});

const HOOK = 'pnpm run stack:post-sync|VERSION=1.2.3';

// Ожидаемые обращения к реестру — из канона, а не литералом.
const wantedServed = loadCanon({ profile: 'node', with: [], exceptions: [] }).catalogs.dev;
const SERVED = Object.entries(wantedServed ?? {})
	.filter(([name]) => name.startsWith('@alxwlw/'))
	.map(([name, v]) => `served ${name}@${v}`);

const NODE_PKG = JSON.stringify({ name: 'app', scripts: { 'stack:post-sync': 'true' } });

async function runSyncPr(
	dir: string,
	over: Partial<SyncPrOptions> = {},
	handlers: {
		run?: (line: string) => number | undefined;
		served?: Served;
		github?: GitHub;
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
				has: async (name, version) => {
					journal.push(`has ${name}@${version}`);
					return true;
				},
				served: async (name, version) => {
					journal.push(`served ${name}@${version}`);
					return handlers.served ?? 'served';
				},
			},
			print: (stream, line) => (stream === 'out' ? out : err).push(line),
		},
	);
	return { code, journal, out, err, github: fake };
}

describe('syncPr', () => {
	test('удержанные sync строки — в stderr, не в stdout', async () => {
		const { dir } = gitRepo({
			'.stack.jsonc':
				'{ "profile": "node", "with": [], "exceptions": [{ "file": ".editorconfig", "reason": "свой отступ" }] }',
			'.editorconfig': 'свой\n',
		});
		const r = await runSyncPr(dir);
		expect(r.err.join('\n')).toContain('allowed (свой отступ): .editorconfig');
		expect(r.out.join('\n')).not.toContain('allowed (');
	});

	test('SYNC_PR_WAIT — те же ATTEMPTS и INTERVAL, что у шага ожидания sync.yml', () => {
		const wf = parseYaml(
			readFileSync(
				join(import.meta.dir, '..', '..', '..', '.github', 'workflows', 'sync.yml'),
				'utf8',
			),
		) as { jobs?: Record<string, { steps?: { name?: string; env?: Record<string, string> }[] }> };
		const step = Object.values(wf.jobs ?? {})
			.flatMap((j) => j.steps ?? [])
			.find((x) => x.name === 'дождаться версии в npm');
		expect(SYNC_PR_WAIT).toEqual({
			attempts: Number(step?.env?.ATTEMPTS),
			intervalMs: Number(step?.env?.INTERVAL) * 1000,
		});
	});

	test('порядок шагов: sync, ожидание реестра, proto install, pnpm install, хук с VERSION, публикация', async () => {
		const { dir } = gitRepo({ '.stack.jsonc': '{ "profile": "node" }', 'package.json': NODE_PKG });
		const r = await runSyncPr(dir);
		expect(r.code).toBe(0);
		expect(r.journal).toEqual([
			...SERVED,
			'proto install',
			'pnpm install --no-frozen-lockfile',
			HOOK,
		]);
		expect(r.github.created).toHaveLength(1);
		expect(r.out.indexOf('canon applied')).toBeGreaterThanOrEqual(0);
		expect(r.out.indexOf('canon applied')).toBeLessThan(r.out.indexOf('pushed stack/v1.2.3'));
	});

	test('файл, который написал хук, есть в теле PR', async () => {
		const { dir } = gitRepo({ '.stack.jsonc': '{ "profile": "node" }', 'package.json': NODE_PKG });
		const r = await runSyncPr(
			dir,
			{},
			{
				run: (line) => {
					if (line === 'pnpm run stack:post-sync') writeFileSync(join(dir, 'hook.txt'), 'h');
					return undefined;
				},
			},
		);
		expect(r.github.created[0]?.body).toContain('- hook.txt\n');
	});

	test('без package.json при install: true — ни ожидания, ни процессов, публикация идёт', async () => {
		const { dir } = gitRepo({ '.stack.jsonc': '{ "profile": "infra" }' });
		const r = await runSyncPr(dir);
		expect(r.code).toBe(0);
		expect(r.journal).toEqual([]);
		expect(existsSync(join(dir, 'package.json'))).toBe(false);
		expect(r.github.created).toHaveLength(1);
	});

	test('--no-install: ни ожидания, ни pnpm install; proto install и хук идут', async () => {
		const { dir } = gitRepo({ '.stack.jsonc': '{ "profile": "node" }', 'package.json': NODE_PKG });
		const r = await runSyncPr(dir, { install: false });
		expect(r.code).toBe(0);
		expect(r.journal).toEqual(['proto install', HOOK]);
	});

	test('хука нет — pnpm run не зовётся', async () => {
		const { dir } = gitRepo({
			'.stack.jsonc': '{ "profile": "node" }',
			'package.json': JSON.stringify({ name: 'app' }),
		});
		const r = await runSyncPr(dir);
		expect(r.journal).toEqual([...SERVED, 'proto install', 'pnpm install --no-frozen-lockfile']);
	});

	test('хук упал — код 1, публикации нет', async () => {
		const { dir } = gitRepo({ '.stack.jsonc': '{ "profile": "node" }', 'package.json': NODE_PKG });
		const r = await runSyncPr(dir, {}, { run: (l) => (l === 'pnpm run stack:post-sync' ? 1 : 0) });
		expect(r.code).toBe(1);
		expect(r.err.at(-1)).toBe('sync-pr: `pnpm run stack:post-sync` exited with 1');
		expect(r.github.calls).toEqual([]);
		expect(git(dir, 'branch', '--list', 'stack/v1.2.3')).toBe('');
	});

	test('package.json не разбирается — код 1, ни ожидания, ни процессов', async () => {
		const { dir } = gitRepo({ '.stack.jsonc': '{ "profile": "node" }', 'package.json': '{' });
		const r = await runSyncPr(dir);
		expect(r.code).toBe(1);
		expect(r.err).toHaveLength(1);
		expect(r.err[0]).toStartWith('sync-pr: package.json does not parse:');
		expect(r.journal).toEqual([]);
	});

	test('proto install упал — код 1, pnpm не зовётся', async () => {
		const { dir } = gitRepo({ '.stack.jsonc': '{ "profile": "node" }', 'package.json': NODE_PKG });
		const r = await runSyncPr(dir, {}, { run: (l) => (l === 'proto install' ? 1 : 0) });
		expect(r.code).toBe(1);
		expect(r.journal).toEqual([...SERVED, 'proto install']);
		expect(r.err.at(-1)).toBe('sync-pr: `proto install` exited with 1');
	});

	test('pnpm install упал — код 1, хук не зовётся', async () => {
		const { dir } = gitRepo({ '.stack.jsonc': '{ "profile": "node" }', 'package.json': NODE_PKG });
		const r = await runSyncPr(
			dir,
			{},
			{ run: (l) => (l === 'pnpm install --no-frozen-lockfile' ? 1 : 0) },
		);
		expect(r.code).toBe(1);
		expect(r.journal).toEqual([...SERVED, 'proto install', 'pnpm install --no-frozen-lockfile']);
		expect(r.err.at(-1)).toBe('sync-pr: `pnpm install --no-frozen-lockfile` exited with 1');
	});

	test('реестр не показал версию — код 1, процессов нет', async () => {
		const { dir } = gitRepo({ '.stack.jsonc': '{ "profile": "node" }', 'package.json': NODE_PKG });
		const r = await runSyncPr(dir, {}, { served: 'unlisted' });
		expect(r.code).toBe(1);
		expect(r.err.at(-1)).toStartWith('sync-pr: за 2 попыток в реестре не появились версии:');
		expect(r.journal.every((l) => l.startsWith('served '))).toBe(true);
		expect(r.journal.length).toBeGreaterThan(0);
	});

	test('ошибка .stack.jsonc — код 2, ничего не запускается', async () => {
		const { dir } = gitRepo({
			'.stack.jsonc': '{ "profile": "node", "wiht": [] }',
			'package.json': NODE_PKG,
		});
		const r = await runSyncPr(dir);
		expect(r.code).toBe(2);
		expect(r.err.join('\n')).toContain('unknown key "wiht"');
		expect(r.journal).toEqual([]);
		expect(r.github.calls).toEqual([]);
	});

	test('второй запуск на применённом каноне — менять нечего, код 0', async () => {
		const { dir } = gitRepo({ '.stack.jsonc': '{ "profile": "infra" }' });
		const first = await runSyncPr(dir);
		const second = await runSyncPr(dir);
		expect(first.code).toBe(0);
		expect(second.code).toBe(0);
		expect(second.out.at(-1)).toBe('canon already applied, nothing to commit');
		expect(first.github.created).toHaveLength(1);
		expect(second.github.created).toHaveLength(0);
	});

	test('ownVersion — version из packages/stack/package.json', () => {
		const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8')) as {
			version: string;
		};
		expect(ownVersion()).toBe(pkg.version);
		expect(ownVersion()).toMatch(/^\d+\.\d+\.\d+/);
	});
});
