import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { main } from '@alxwlw/repo-rules';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import type { RepoRulesReader } from './repo-rules.ts';
import { git, gitRepo, HOOK, isolateGitConfig, NODE_PKG, runSyncPr, SERVED } from './testkit.ts';

let restore: () => void;
beforeAll(() => {
	restore = isolateGitConfig();
});
afterAll(() => restore());

const FILE = '.repo-rules-baseline.json';
const DISABLE = '// eslint-disable-next-line no-console\nconsole.log(1);\n';
const WITH_GROUP = '{ "profile": "node", "with": ["repo-rules"] }';
const baseline = (entries: Record<string, number>): string =>
	`${JSON.stringify({ version: 1, rules: { 'suppression-reason': entries } }, null, 2)}\n`;
const lowered = (n: number): string => `repo-rules baseline: lowered ${n} entr(ies) in ${FILE}`;
const call = (dir: string): string => `repo-rules -C ${dir} baseline --drop-fixed`;
const onBranch = (remote: string): string => git(remote, 'show', `stack/v1.2.3:${FILE}`);

// Настоящий repo-rules в процессе — то же, что боевой адаптер в cli.ts.
const real: RepoRulesReader = (argv, env) => {
	const out: string[] = [];
	const err: string[] = [];
	const code = main(
		argv,
		env,
		(s) => void out.push(s),
		(s) => void err.push(s),
	);
	return { code, out: out.join('\n'), err: err.join('\n') };
};

// Одна запись исправлена, одна выросла, одно нарушение новое.
const mixedRepo = (
	config = WITH_GROUP,
	manifest: Record<string, string> = { 'package.json': NODE_PKG },
): { dir: string; remote: string } =>
	gitRepo({
		'.stack.jsonc': config,
		...manifest,
		'src/fixed.ts': 'console.log(1);\n',
		'src/grown.ts': `${DISABLE}${DISABLE}`,
		'src/new.ts': DISABLE,
		[FILE]: baseline({ 'src/fixed.ts': 1, 'src/grown.ts': 1 }),
	});

describe('syncPr: baseline repo-rules', () => {
	test('исправленная запись уходит из baseline и попадает в коммит; рост и новое не записаны', async () => {
		const { dir, remote } = mixedRepo();
		const r = await runSyncPr(dir, {}, { repoRules: real });
		expect(r.code).toBe(0);
		expect(r.journal).toStrictEqual([
			...SERVED,
			'proto install',
			'pnpm install --no-frozen-lockfile',
			'pnpm dedupe',
			HOOK,
			call(dir),
		]);
		expect(onBranch(remote)).toBe(baseline({ 'src/grown.ts': 1 }));
		expect(r.out).toContain(lowered(1));
		expect(r.out.indexOf(lowered(1))).toBeLessThan(r.out.indexOf('pushed stack/v1.2.3'));
		expect(r.err.some((l) => l.includes('repo-rules'))).toBe(false);
	});

	test('исправлять нечего — файл baseline в коммите байт в байт прежний', async () => {
		const hand =
			'{\n    "version": 1,\n    "rules": {\n        "suppression-reason": {\n' +
			'            "src/z.ts": 1,\n            "src/a.ts": 1\n        }\n    }\n}\n';
		const { dir, remote } = gitRepo({
			'.stack.jsonc': WITH_GROUP,
			'package.json': NODE_PKG,
			'src/z.ts': DISABLE,
			'src/a.ts': `${DISABLE}${DISABLE}`,
			[FILE]: hand,
		});
		const r = await runSyncPr(dir, {}, { repoRules: real });
		expect(r.code).toBe(0);
		expect(r.journal).toContain(call(dir));
		expect(onBranch(remote)).toBe(hand);
		expect(git(remote, 'diff', '--name-only', 'main', 'stack/v1.2.3')).not.toContain(FILE);
		expect(r.out.some((l) => l.includes('repo-rules baseline'))).toBe(false);
	});

	test('файла baseline нет — режим его не создаёт', async () => {
		const { dir, remote } = gitRepo({
			'.stack.jsonc': WITH_GROUP,
			'package.json': NODE_PKG,
			'src/a.ts': DISABLE,
		});
		const r = await runSyncPr(dir, {}, { repoRules: real });
		expect(r.code).toBe(0);
		expect(r.journal).toContain(call(dir));
		expect(existsSync(join(dir, FILE))).toBe(false);
		expect(git(remote, 'ls-tree', '-r', '--name-only', 'stack/v1.2.3')).not.toContain(FILE);
		expect(r.github.created).toHaveLength(1);
	});

	test('baseline не разбирается — строка в stderr, файл не тронут, sync-PR идёт дальше', async () => {
		const { dir, remote } = gitRepo({
			'.stack.jsonc': WITH_GROUP,
			'package.json': NODE_PKG,
			'src/a.ts': DISABLE,
			[FILE]: '{ not json',
		});
		const r = await runSyncPr(dir, {}, { repoRules: real });
		expect(r.code).toBe(0);
		const lines = r.err.filter((l) => l.startsWith('sync-pr: repo-rules baseline: '));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toStartWith(`sync-pr: repo-rules baseline: ${FILE}: not JSON (`);
		expect(onBranch(remote)).toBe('{ not json');
		expect(r.github.created).toHaveLength(1);
	});

	test('группа выключена — порт не зовётся, файл baseline прежний', async () => {
		const { dir, remote } = mixedRepo('{ "profile": "node" }');
		const r = await runSyncPr(
			dir,
			{},
			{
				repoRules: () => {
					throw new Error('repo-rules called');
				},
			},
		);
		expect(r.code).toBe(0);
		expect(r.journal.some((l) => l.startsWith('repo-rules'))).toBe(false);
		expect(r.journal.at(-1)).toBe(HOOK);
		expect(onBranch(remote)).toBe(baseline({ 'src/fixed.ts': 1, 'src/grown.ts': 1 }));
	});

	test('репозиторий без package.json — режим идёт, запись уходит в коммит', async () => {
		const { dir, remote } = mixedRepo('{ "profile": "infra", "with": ["repo-rules"] }', {});
		const r = await runSyncPr(dir, {}, { repoRules: real });
		expect(r.code).toBe(0);
		expect(r.journal).toStrictEqual([call(dir)]);
		expect(onBranch(remote)).toBe(baseline({ 'src/grown.ts': 1 }));
	});

	test('--no-install — режим идёт', async () => {
		const { dir, remote } = mixedRepo();
		const r = await runSyncPr(dir, { install: false }, { repoRules: real });
		expect(r.code).toBe(0);
		expect(r.journal).toStrictEqual(['proto install', HOOK, call(dir)]);
		expect(onBranch(remote)).toBe(baseline({ 'src/grown.ts': 1 }));
	});

	test('сбой режима без текста — причина по коду; порт получает пустое окружение', async () => {
		const seen: { argv: string[]; env: NodeJS.ProcessEnv }[] = [];
		const { dir } = mixedRepo();
		const r = await runSyncPr(
			dir,
			{},
			{
				repoRules: (argv, env) => {
					seen.push({ argv, env });
					return { code: 2, out: 'ignored', err: '' };
				},
			},
		);
		expect(r.code).toBe(0);
		expect(seen).toStrictEqual([{ argv: ['-C', dir, 'baseline', '--drop-fixed'], env: {} }]);
		expect(r.err).toContain('sync-pr: repo-rules baseline: exited with 2');
		expect(r.out).not.toContain('ignored');
		expect(r.github.created).toHaveLength(1);
	});

	test('peers и repo-rules вместе: сначала peers, затем repo-rules', async () => {
		const { dir } = gitRepo({
			'.stack.jsonc': '{ "profile": "node", "with": ["peers", "repo-rules"] }',
			'package.json': NODE_PKG,
			'pnpm-lock.yaml': 'lockfileVersion: x\n',
			'.stack-peers-baseline.json': `${JSON.stringify({ version: 1, peers: [] }, null, '\t')}\n`,
		});
		const r = await runSyncPr(dir);
		expect(r.code).toBe(0);
		expect(r.journal.slice(-3)).toStrictEqual([HOOK, 'peers', call(dir)]);
	});

	test('упавший install — режим не зовётся', async () => {
		const { dir } = mixedRepo();
		const r = await runSyncPr(
			dir,
			{},
			{ run: (line) => (line.startsWith('pnpm install') ? 1 : undefined), repoRules: real },
		);
		expect(r.code).toBe(1);
		expect(r.journal.some((l) => l.startsWith('repo-rules'))).toBe(false);
		expect(readFileSync(join(dir, FILE), 'utf8')).toBe(
			baseline({ 'src/fixed.ts': 1, 'src/grown.ts': 1 }),
		);
	});
});
