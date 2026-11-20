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

import { ownVersion } from './own-packages.ts';
import type { PeerEntry, PeersReader } from './peers.ts';
import { type NewPr, prBody, SYNC_PR_WAIT } from './sync-pr.ts';
import {
	fakeGitHub,
	git,
	gitRepo,
	HOOK,
	isolateGitConfig,
	NODE_PKG,
	opts,
	PR_URL,
	put,
	repoDir,
	run,
	runSyncPr,
	SERVED,
} from './testkit.ts';

let restore: () => void;
beforeAll(() => {
	restore = isolateGitConfig();
});
afterAll(() => restore());

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

// Группа peers: записи baseline — литералы, ответ pnpm — JSON той же формы, что у pnpm 12.
const PEERS_FILE = '.stack-peers-baseline.json';
const CONFLICT_REACT: PeerEntry = { importer: '.', peer: 'react', kind: 'conflict' };
const MISSING_ETHERS: PeerEntry = {
	importer: '.',
	peer: 'ethers',
	kind: 'missing',
	by: '@typechain/hardhat',
};

const baselineText = (entries: PeerEntry[]): string =>
	`${JSON.stringify({ version: 1, peers: entries }, null, '\t')}\n`;

// Порт pnpm, который видит заданные записи (conflict react и/или missing ethers).
function peersPort(...entries: PeerEntry[]): PeersReader {
	const json = {
		'.': {
			bad: {},
			missing: entries.includes(MISSING_ETHERS)
				? {
						ethers: [
							{
								parents: [{ name: '@typechain/hardhat', version: '9.1.0' }],
								optional: false,
								wantedRange: '^6.1.0',
							},
						],
					}
				: {},
			conflicts: entries.includes(CONFLICT_REACT) ? ['react'] : [],
			intersections: {},
		},
	};
	return () => ({ status: 1, signal: null, stdout: JSON.stringify(json), stderr: '' });
}

// Потребитель с группой peers, локом и baseline из записей.
function peersRepo(baseline: PeerEntry[]): { dir: string; remote: string } {
	return gitRepo({
		'.stack.jsonc': '{ "profile": "node", "with": ["peers"] }',
		'package.json': NODE_PKG,
		'pnpm-lock.yaml': 'lockfileVersion: x\n',
		[PEERS_FILE]: baselineText(baseline),
	});
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

	test('порядок шагов: sync, ожидание реестра, proto install, pnpm install, pnpm dedupe, хук с VERSION, публикация', async () => {
		const { dir } = gitRepo({ '.stack.jsonc': '{ "profile": "node" }', 'package.json': NODE_PKG });
		const r = await runSyncPr(dir);
		expect(r.code).toBe(0);
		expect(r.journal).toEqual([
			...SERVED,
			'proto install',
			'pnpm install --no-frozen-lockfile',
			'pnpm dedupe',
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

	test('--no-install: ни ожидания, ни pnpm install, ни pnpm dedupe; proto install и хук идут', async () => {
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
		expect(r.journal).toEqual([
			...SERVED,
			'proto install',
			'pnpm install --no-frozen-lockfile',
			'pnpm dedupe',
		]);
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

	test('pnpm install упал — код 1, ни dedupe, ни хук не зовутся', async () => {
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

	test('pnpm dedupe упал — код 1, хук не зовётся, публикации нет', async () => {
		const { dir } = gitRepo({ '.stack.jsonc': '{ "profile": "node" }', 'package.json': NODE_PKG });
		const r = await runSyncPr(dir, {}, { run: (l) => (l === 'pnpm dedupe' ? 1 : 0) });
		expect(r.code).toBe(1);
		expect(r.journal).toStrictEqual([
			...SERVED,
			'proto install',
			'pnpm install --no-frozen-lockfile',
			'pnpm dedupe',
		]);
		expect(r.err.at(-1)).toBe('sync-pr: `pnpm dedupe` exited with 1');
		expect(r.github.calls).toStrictEqual([]);
		expect(git(dir, 'branch', '--list', 'stack/v1.2.3')).toBe('');
	});

	// Приёмка 6: install оставил в lockfile дубликаты — хук видит lockfile уже после dedupe, и в коммит идёт он.
	test('lockfile после dedupe: его видит хук, и он попадает в коммит sync-PR', async () => {
		const { dir, remote } = gitRepo({
			'.stack.jsonc': '{ "profile": "node" }',
			'package.json': NODE_PKG,
		});
		const lock = join(dir, 'pnpm-lock.yaml');
		const duplicated = "lockfileVersion: '9.0'\n# ms@2.1.1, ms@2.1.3\n";
		const deduped = "lockfileVersion: '9.0'\n# ms@2.1.3\n";
		let seenByHook = '';
		const r = await runSyncPr(
			dir,
			{},
			{
				run: (line) => {
					if (line === 'pnpm install --no-frozen-lockfile') writeFileSync(lock, duplicated);
					if (line === 'pnpm dedupe') writeFileSync(lock, deduped);
					if (line === 'pnpm run stack:post-sync') seenByHook = readFileSync(lock, 'utf8');
					return undefined;
				},
			},
		);
		expect(r.code).toBe(0);
		expect(seenByHook).toBe(deduped);
		expect(git(remote, 'show', 'stack/v1.2.3:pnpm-lock.yaml')).toBe(deduped);
	});

	test('реестр не показал версию — код 1, процессов нет', async () => {
		const { dir } = gitRepo({ '.stack.jsonc': '{ "profile": "node" }', 'package.json': NODE_PKG });
		const r = await runSyncPr(dir, {}, { served: 'unlisted' });
		expect(r.code).toBe(1);
		expect(r.err.at(-1)).toStartWith('sync-pr: за 2 попыток в реестре не появились версии:');
		expect(r.journal.every((l) => l.startsWith('served '))).toBe(true);
		expect(r.journal.length).toBeGreaterThan(0);
	});

	test('реестр не показал транзитивный свой пакет — код 1, пакет назван, процессов нет', async () => {
		const { dir } = gitRepo({ '.stack.jsonc': '{ "profile": "node" }', 'package.json': NODE_PKG });
		const r = await runSyncPr(
			dir,
			{},
			{ served: (name) => (name === '@alxwlw/repo-rules' ? 'unlisted' : 'served') },
		);
		expect(r.code).toBe(1);
		expect(r.err.at(-1)).toContain(`@alxwlw/repo-rules@${ownVersion()}`);
		expect(r.journal.every((l) => l.startsWith('served '))).toBe(true);
		expect(r.journal).toContain(`served @alxwlw/repo-rules@${ownVersion()}`);
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

	test('peers: после установки исправленная запись уходит из baseline и попадает в коммит sync-PR', async () => {
		const { dir, remote } = peersRepo([CONFLICT_REACT, MISSING_ETHERS]);
		const r = await runSyncPr(dir, {}, { peers: peersPort(MISSING_ETHERS) });
		expect(r.code).toBe(0);
		expect(r.journal).toEqual([
			...SERVED,
			'proto install',
			'pnpm install --no-frozen-lockfile',
			'pnpm dedupe',
			HOOK,
			'peers',
		]);
		expect(git(remote, 'show', `stack/v1.2.3:${PEERS_FILE}`)).toBe(baselineText([MISSING_ETHERS]));
		expect(r.out).toContain('dropped 1 fixed entr(ies) from .stack-peers-baseline.json');
		expect(r.out.indexOf('dropped 1 fixed entr(ies) from .stack-peers-baseline.json')).toBeLessThan(
			r.out.indexOf('pushed stack/v1.2.3'),
		);
	});

	test('peers: новая запись не добавляется, sync-PR не падает', async () => {
		const { dir, remote } = peersRepo([MISSING_ETHERS]);
		const r = await runSyncPr(dir, {}, { peers: peersPort(CONFLICT_REACT, MISSING_ETHERS) });
		expect(r.code).toBe(0);
		expect(git(remote, 'show', `stack/v1.2.3:${PEERS_FILE}`)).toBe(baselineText([MISSING_ETHERS]));
		expect(r.out.some((l) => l.includes(PEERS_FILE))).toBe(false);
		expect(r.github.created).toHaveLength(1);
	});

	test('peers: pnpm недоступен — строка в stderr, sync-PR идёт дальше', async () => {
		const { dir } = peersRepo([MISSING_ETHERS]);
		const r = await runSyncPr(dir, {}, { peers: () => ({ error: 'spawn pnpm ENOENT' }) });
		expect(r.code).toBe(0);
		expect(r.err).toContain(
			'sync-pr: peers baseline: pnpm peers check did not start: spawn pnpm ENOENT',
		);
		expect(r.github.created).toHaveLength(1);
	});

	test('peers: группа выключена — порт не зовётся', async () => {
		const { dir } = gitRepo({
			'.stack.jsonc': '{ "profile": "node" }',
			'package.json': NODE_PKG,
			'pnpm-lock.yaml': 'lockfileVersion: x\n',
			[PEERS_FILE]: baselineText([CONFLICT_REACT]),
		});
		const r = await runSyncPr(dir);
		expect(r.code).toBe(0);
		expect(r.journal).not.toContain('peers');
		expect(r.journal.at(-1)).toBe(HOOK);
	});
});
