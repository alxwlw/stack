import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { parsePins } from './canon.ts';
import { BARE, git, isolateGitConfig, protoBin, put, repoDir, ROOT } from './testkit.ts';
import { checkDir, guardRepos, initRepo, syncDir } from './testkit-acceptance.ts';

// Приёмка группы guardrails на настоящих инструментах: пиннутые actionlint и shellcheck.
describe('check с группой guardrails на настоящих инструментах', () => {
	const NO_DRIFT = 'canon: no drift\n';
	const BAD_SCRIPT = '#!/bin/bash\ncd dir\necho $HOME\n';
	const GOOD_SCRIPT = '#!/bin/bash\ncd dir || exit 1\necho $HOME\n';
	const BAD_RUN = '      - run: echo "${{ github.event.foo( }}"\n';
	const GOOD_RUN = '      - run: echo $HOME\n';
	const workflow = (step: string) =>
		`name: lint\non: push\npermissions:\n  contents: read\nconcurrency: lint\njobs:\n  lint:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    steps:\n${step}`;
	const VIOLATION_LINE = 'guardrails-violation: ';
	const GONE = '.github/workflows/gone.yml';
	const TIMEOUT = 60_000;
	// Версии — из канонного prototools, который sync кладёт в репозиторий; литералов версий в тесте нет.
	const PINS = parsePins(readFileSync(join(ROOT, 'packages/stack/canon/files/prototools'), 'utf8'));

	let restore: () => void;
	let tools: Record<string, string>;
	beforeAll(() => {
		restore = isolateGitConfig();
		tools = {
			ACTIONLINT_BIN: protoBin('actionlint'),
			SHELLCHECK_BIN: protoBin('shellcheck'),
			GITLEAKS_BIN: protoBin('gitleaks'),
			UV_BIN: protoBin('uv'),
		};
	});
	// Каталоги фикстур файла: убираются в afterAll, в том числе после упавшего теста.
	const { guardRepo, clean } = guardRepos();
	const made: string[] = [];
	afterAll(() => {
		restore();
		clean();
		for (const d of made) rmSync(d, { recursive: true, force: true });
	});

	const MISSING = {
		ACTIONLINT_BIN: '/nonexistent/actionlint',
		SHELLCHECK_BIN: '/nonexistent/shellcheck',
		GITLEAKS_BIN: '/nonexistent/gitleaks',
		UV_BIN: '/nonexistent/uv',
	};

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
		() => {
			const { dir } = guardRepo(BAD_FILES);
			const r = checkDir(dir, { env: tools });
			expect(r.code).toBe(1);
			const found = violations(r.err);
			expect(found).toHaveLength(2);
			expect(found[0]).toStartWith(
				`guardrails-violation: .github/workflows/lint.yml:${runLine(workflow(BAD_RUN))} — actionlint expression: `,
			);
			expect(found[1]).toStartWith('guardrails-violation: scripts/a.sh:2 — shellcheck SC2164: ');
			expect(r.err).toContain(`guardrails actionlint ${PINS.actionlint}: `);
			expect(r.err).toContain(`guardrails shellcheck ${PINS.shellcheck}: `);
			expect(r.err).toContain(`guardrails actionlint ${PINS.actionlint}: 4 file(s), 1 finding(s)`);
			expect(r.err).toContain(`guardrails shellcheck ${PINS.shellcheck}: 1 file(s), 1 finding(s)`);
			expect(r.err).not.toContain('guardrails-unavailable');
			expect(r.out).not.toContain('canon: no drift');
		},
		TIMEOUT,
	);

	test(
		'SHELLCHECK_OPTS из окружения не сдвигает порог',
		() => {
			const { dir } = guardRepo(BAD_FILES);
			const r = checkDir(dir, { env: { ...tools, SHELLCHECK_OPTS: '-S error' } });
			expect(r.code).toBe(1);
			expect(violations(r.err)).toContainEqual(
				expect.stringContaining('scripts/a.sh:2 — shellcheck SC2164: '),
			);
			expect(r.out).not.toContain('canon: no drift');
		},
		TIMEOUT,
	);

	test(
		'чистый репозиторий: код 0 и no drift, канонные workflow проходят actionlint',
		() => {
			const { dir } = guardRepo(CLEAN_FILES);
			const r = checkDir(dir, { env: tools });
			expect(r.err).not.toContain(VIOLATION_LINE);
			expect(r.err).not.toContain('guardrails-unavailable');
			expect(r.code).toBe(0);
			expect(r.out).toBe(NO_DRIFT);
		},
		TIMEOUT,
	);

	test(
		'приёмка 8: неотслеживаемые, игнорируемые и файлы worktree не доходят до инструментов',
		() => {
			const { dir } = guardRepo({ ...CLEAN_FILES, '.gitignore': '*.local.sh\n' });
			put(dir, 'scripts/new.sh', BAD_SCRIPT);
			put(dir, 'scripts/b.local.sh', BAD_SCRIPT);
			git(dir, 'worktree', 'add', '--detach', '.worktrees/wt');
			put(dir, '.worktrees/wt/scripts/c.sh', BAD_SCRIPT);
			const r = checkDir(dir, { env: tools });
			expect(violations(r.err)).toStrictEqual([]);
			expect(r.err).toContain(`guardrails shellcheck ${PINS.shellcheck}: 1 file(s), 0 finding(s)`);
			expect(r.code).toBe(0);
			expect(r.out).toBe(NO_DRIFT);
		},
		TIMEOUT,
	);

	test(
		'вне git: guardrails-unavailable для git ls-files, не no drift',
		() => {
			const dir = repoDir(BARE);
			made.push(dir);
			initRepo(dir, { with: ['guardrails'] });
			syncDir(dir);
			const r = checkDir(dir, { env: { ...tools, GIT_CEILING_DIRECTORIES: dirname(dir) } });
			expect(r.code).toBe(1);
			expect(r.err).toContain(
				'guardrails-unavailable: git ls-files — fatal: not a git repository (or any of the parent directories): .git',
			);
			expect(r.err).not.toContain('guardrails actionlint');
			expect(r.err).not.toContain('guardrails shellcheck');
			expect(r.out).not.toContain('canon: no drift');
		},
		TIMEOUT,
	);

	test(
		'приёмка 3: несуществующий SHELLCHECK_BIN — guardrails-unavailable shellcheck',
		() => {
			const { dir } = guardRepo(CLEAN_FILES);
			const r = checkDir(dir, { env: { ...tools, SHELLCHECK_BIN: MISSING.SHELLCHECK_BIN } });
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
		() => {
			const { dir } = guardRepo(BAD_FILES, { group: false });
			const r = checkDir(dir, { env: MISSING });
			expect(r.code).toBe(0);
			expect(r.out).toBe(NO_DRIFT);
			expect(r.err).not.toContain('guardrails');
		},
		TIMEOUT,
	);

	test(
		'Review Focus 4: удалённый с диска закоммиченный workflow не роняет actionlint',
		() => {
			const { dir } = guardRepo({ ...BAD_FILES, [GONE]: workflow(GOOD_RUN) });
			rmSync(join(dir, GONE));
			const r = checkDir(dir, { env: tools });
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
		'приёмка 4: sync переписывает пин proto, а check затем показывает нарушение actionlint и нет находки toolchain-pin',
		() => {
			const stale =
				workflow(BAD_RUN) +
				'      - uses: moonrepo/setup-toolchain@v0\n        with:\n          proto-version: 0.60.2\n';
			const { dir } = guardRepo({ '.github/workflows/lint.yml': stale });
			const path = join(dir, '.github/workflows/lint.yml');
			// guardRepo уже сделал sync: возвращаем устаревший пин и проверяем, что sync его перепишет
			writeFileSync(path, stale);
			git(dir, 'add', '-A');
			git(dir, 'commit', '-m', 'stale pin');
			syncDir(dir);
			const text = readFileSync(path, 'utf8');
			expect(text).not.toContain('0.60.2');
			expect(text).toContain(`proto-version: ${PINS.proto}`);
			git(dir, 'add', '-A');
			git(dir, 'commit', '-m', 'synced');
			const r = checkDir(dir, { env: tools });
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
