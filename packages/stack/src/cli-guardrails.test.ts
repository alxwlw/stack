import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
	BARE,
	git,
	gitRepo,
	isolateGitConfig,
	protoBin,
	put,
	repoDir,
	runCli as run,
} from './testkit.ts';

// Приёмка группы guardrails через настоящий cli на пиннутых actionlint и shellcheck.
describe('check с группой guardrails через настоящий cli', () => {
	const NO_DRIFT = 'canon: no drift\n';
	const BAD_SCRIPT = '#!/bin/bash\ncd dir\necho $HOME\n';
	const GOOD_SCRIPT = '#!/bin/bash\ncd dir || exit 1\necho $HOME\n';
	const BAD_RUN = '      - run: echo "${{ github.event.foo( }}"\n';
	const GOOD_RUN = '      - run: echo $HOME\n';
	const workflow = (step: string) =>
		`name: lint\non: push\njobs:\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n${step}`;
	const VIOLATION_LINE = 'guardrails-violation: ';
	const GONE = '.github/workflows/gone.yml';
	const TIMEOUT = 60_000;

	let restore: () => void;
	let tools: Record<string, string>;
	beforeAll(() => {
		restore = isolateGitConfig();
		tools = { ACTIONLINT_BIN: protoBin('actionlint'), SHELLCHECK_BIN: protoBin('shellcheck') };
	});
	afterAll(() => restore());

	const MISSING = {
		ACTIONLINT_BIN: '/nonexistent/actionlint',
		SHELLCHECK_BIN: '/nonexistent/shellcheck',
	};

	// Репозиторий под git: init с группой (или без), sync, всё закоммичено.
	async function guardRepo(
		files: Record<string, string>,
		opts: { group?: boolean } = {},
	): Promise<string> {
		const { dir } = gitRepo({ ...BARE, ...files });
		const withGroup = opts.group === false ? [] : ['--with', 'guardrails'];
		expect((await run(['init', '--profile', 'node', ...withGroup], dir)).code).toBe(0);
		expect((await run(['sync'], dir)).code).toBe(0);
		git(dir, 'add', '-A');
		git(dir, 'commit', '-m', 'canon');
		return dir;
	}

	const violations = (err: string) => err.split('\n').filter((l) => l.startsWith(VIOLATION_LINE));
	const runLine = (text: string) => text.split('\n').indexOf(BAD_RUN.trimEnd()) + 1;
	const BAD_FILES = {
		'scripts/a.sh': BAD_SCRIPT,
		'.github/workflows/lint.yml': workflow(BAD_RUN),
	};
	const CLEAN_FILES = {
		'scripts/a.sh': GOOD_SCRIPT,
		'.github/workflows/lint.yml': workflow(GOOD_RUN),
	};

	test(
		'приёмка 1: нарушения обоих инструментов — код 1, две находки и две пометки',
		async () => {
			const dir = await guardRepo(BAD_FILES);
			const r = await run(['check'], dir, tools);
			expect(r.code).toBe(1);
			const found = violations(r.err);
			expect(found).toHaveLength(2);
			expect(found[0]).toStartWith(
				`guardrails-violation: .github/workflows/lint.yml:${runLine(workflow(BAD_RUN))} — actionlint expression: `,
			);
			expect(found[1]).toStartWith('guardrails-violation: scripts/a.sh:2 — shellcheck SC2164: ');
			expect(r.err).toContain('guardrails actionlint 1.7.12: ');
			expect(r.err).toContain('guardrails shellcheck 0.11.0: ');
			expect(r.err).toContain('guardrails actionlint 1.7.12: 4 file(s), 1 finding(s)');
			expect(r.err).toContain('guardrails shellcheck 0.11.0: 1 file(s), 1 finding(s)');
			expect(r.err).not.toContain('guardrails-unavailable');
			expect(r.out).not.toContain('canon: no drift');
		},
		TIMEOUT,
	);

	test(
		'чистый репозиторий: код 0 и no drift, канонные workflow проходят actionlint',
		async () => {
			const dir = await guardRepo(CLEAN_FILES);
			const r = await run(['check'], dir, tools);
			expect(r.err).not.toContain(VIOLATION_LINE);
			expect(r.err).not.toContain('guardrails-unavailable');
			expect(r.code).toBe(0);
			expect(r.out).toBe(NO_DRIFT);
		},
		TIMEOUT,
	);

	test(
		'приёмка 8: неотслеживаемые, игнорируемые и файлы worktree не доходят до инструментов',
		async () => {
			const dir = await guardRepo({ ...CLEAN_FILES, '.gitignore': '*.local.sh\n' });
			put(dir, 'scripts/new.sh', BAD_SCRIPT);
			put(dir, 'scripts/b.local.sh', BAD_SCRIPT);
			git(dir, 'worktree', 'add', '--detach', '.worktrees/wt');
			put(dir, '.worktrees/wt/scripts/c.sh', BAD_SCRIPT);
			const r = await run(['check'], dir, tools);
			expect(violations(r.err)).toStrictEqual([]);
			expect(r.err).toContain('guardrails shellcheck 0.11.0: 1 file(s), 0 finding(s)');
			expect(r.code).toBe(0);
			expect(r.out).toBe(NO_DRIFT);
		},
		TIMEOUT,
	);

	test(
		'вне git: guardrails-unavailable для git ls-files, не no drift',
		async () => {
			const dir = repoDir(BARE);
			expect((await run(['init', '--profile', 'node', '--with', 'guardrails'], dir)).code).toBe(0);
			expect((await run(['sync'], dir)).code).toBe(0);
			const r = await run(['check'], dir, { ...tools, GIT_CEILING_DIRECTORIES: dirname(dir) });
			expect(r.code).toBe(1);
			expect(r.err).toContain(
				'guardrails-unavailable: git ls-files — fatal: not a git repository (or any of the parent directories): .git',
			);
			expect(r.out).not.toContain('canon: no drift');
			rmSync(dir, { recursive: true, force: true });
		},
		TIMEOUT,
	);

	test(
		'приёмка 3: несуществующий SHELLCHECK_BIN — guardrails-unavailable shellcheck',
		async () => {
			const dir = await guardRepo(CLEAN_FILES);
			const r = await run(['check'], dir, { ...tools, SHELLCHECK_BIN: MISSING.SHELLCHECK_BIN });
			expect(r.code).toBe(1);
			const lines = r.err.split('\n').filter((l) => l.startsWith('guardrails-unavailable: '));
			expect(lines.length).toBeGreaterThan(0);
			expect(lines[0]).toStartWith(
				'guardrails-unavailable: shellcheck — SHELLCHECK_BIN=/nonexistent/shellcheck: ',
			);
			expect(r.out).not.toContain('canon: no drift');
		},
		TIMEOUT,
	);

	test(
		'приёмка 2: без группы нарушения не видны, переменные не читаются, слова guardrails в stderr нет',
		async () => {
			const dir = await guardRepo(BAD_FILES, { group: false });
			const r = await run(['check'], dir, MISSING);
			expect(r.code).toBe(0);
			expect(r.out).toBe(NO_DRIFT);
			expect(r.err).not.toContain('guardrails');
		},
		TIMEOUT,
	);

	test(
		'Review Focus 4: удалённый с диска закоммиченный workflow не роняет actionlint',
		async () => {
			const dir = await guardRepo({ ...BAD_FILES, [GONE]: workflow(GOOD_RUN) });
			rmSync(join(dir, GONE));
			const r = await run(['check'], dir, tools);
			expect(r.code).toBe(1);
			const found = violations(r.err);
			expect(found).toHaveLength(2);
			expect(found[0]).toStartWith(
				`guardrails-violation: .github/workflows/lint.yml:${runLine(workflow(BAD_RUN))} — actionlint expression: `,
			);
			expect(found[1]).toStartWith('guardrails-violation: scripts/a.sh:2 — shellcheck SC2164: ');
			expect(r.err).not.toContain('guardrails-unavailable');
		},
		TIMEOUT,
	);

	test(
		'приёмка 4: sync не зовёт инструменты, а следующий check видит нарушение без toolchain-pin',
		async () => {
			const stale =
				workflow(BAD_RUN) +
				'      - uses: moonrepo/setup-toolchain@v0\n        with:\n          proto-version: 0.60.2\n';
			const dir = await guardRepo({ '.github/workflows/lint.yml': stale });
			const path = join(dir, '.github/workflows/lint.yml');
			// guardRepo уже сделал sync: возвращаем устаревший пин и проверяем, что sync его перепишет
			writeFileSync(path, stale);
			git(dir, 'add', '-A');
			git(dir, 'commit', '-m', 'stale pin');
			const synced = await run(['sync'], dir, MISSING);
			expect(synced.code).toBe(0);
			const text = readFileSync(path, 'utf8');
			expect(text).not.toContain('0.60.2');
			expect(text).toContain('proto-version: 0.64.0');
			git(dir, 'add', '-A');
			git(dir, 'commit', '-m', 'synced');
			const r = await run(['check'], dir, tools);
			expect(r.code).toBe(1);
			const found = violations(r.err);
			expect(found).toHaveLength(1);
			expect(found[0]).toStartWith(
				`guardrails-violation: .github/workflows/lint.yml:${runLine(text)} — actionlint expression: `,
			);
			expect(r.err).not.toContain('toolchain-pin');
		},
		TIMEOUT,
	);
});
