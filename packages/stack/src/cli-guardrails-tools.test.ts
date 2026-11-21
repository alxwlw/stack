import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { parsePins } from './canon.ts';
import { YAMLLINT_VERSION } from './guardrails-yamllint.ts';
import {
	BARE,
	git,
	gitRepo,
	isolateGitConfig,
	protoBin,
	put,
	ROOT,
	runCli as run,
} from './testkit.ts';

// Приёмка группы guardrails через настоящий cli на всех шести настоящих инструментах.
describe('check с группой guardrails: все шесть инструментов через настоящий cli', () => {
	const NO_DRIFT = 'canon: no drift\n';
	const VIOLATION_LINE = 'guardrails-violation: ';
	const TIMEOUT = 120_000;
	// 64 hex собираются во время выполнения; в имени нет слов key, secret, token (generic-api-key).
	const HEX = '0123456789abcdef'.repeat(4);
	const LEAK = `export const ETH_PRIV = '0x${HEX}';\n`;
	const TOOLS = [
		'actionlint',
		'shellcheck',
		'gitleaks',
		'hadolint',
		'markdownlint-cli2',
		'yamllint',
	];
	const PINS = parsePins(readFileSync(join(ROOT, 'packages/stack/canon/files/prototools'), 'utf8'));
	const OWN_PACKAGE = JSON.parse(
		readFileSync(join(ROOT, 'packages/stack/package.json'), 'utf8'),
	) as { dependencies: Record<string, string> };
	const MARKDOWNLINT_VERSION = OWN_PACKAGE.dependencies['markdownlint-cli2'];

	const BAD_RUN = '      - run: echo "${{ github.event.foo( }}"\n';
	const workflow = (step: string) =>
		`name: lint\non: push\npermissions:\n  contents: read\nconcurrency: lint\njobs:\n  lint:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    steps:\n${step}`;
	const BAD_SCRIPT = '#!/bin/bash\ncd dir\necho $HOME\n';
	const BAD_DOCKERFILE = 'FROM node:20\nCMD node server.js\n';
	// Образ не node: toolchain-pin смотрит и неотслеживаемые Dockerfile независимо от группы.
	const LOCAL_DOCKERFILE = 'FROM alpine:3.20\nCMD echo hi\n';
	const BAD_README = '# Title\n\n```\nplain\n```\n';
	const BAD_YAML = 'a: 1\na: 2\n';
	const CLEAN_FILES = {
		'.github/workflows/lint.yml': workflow('      - run: echo $HOME\n'),
	};
	const BAD_FILES = {
		'.github/workflows/lint.yml': workflow(BAD_RUN),
		'scripts/a.sh': BAD_SCRIPT,
		'src/a.ts': LEAK,
		Dockerfile: BAD_DOCKERFILE,
		'README.md': BAD_README,
		'bad.yml': BAD_YAML,
	};
	// Имя конфига hadolint собирается, а не пишется: файла нет в этом репозитории (cite-check).
	const HADOLINT_CONFIG = ['', 'hadolint', 'yaml'].join('.');

	let restore: () => void;
	let tools: Record<string, string>;
	beforeAll(() => {
		restore = isolateGitConfig();
		tools = {
			ACTIONLINT_BIN: protoBin('actionlint'),
			SHELLCHECK_BIN: protoBin('shellcheck'),
			GITLEAKS_BIN: protoBin('gitleaks'),
			HADOLINT_BIN: protoBin('hadolint'),
			UV_BIN: protoBin('uv'),
		};
	});
	// Каталоги фикстур файла: убираются в afterAll, в том числе после упавшего теста.
	const made: string[] = [];
	afterAll(() => {
		restore();
		for (const d of made) rmSync(d, { recursive: true, force: true });
	});

	// Репозиторий под git: init с группой (или без), sync, всё закоммичено.
	async function guardRepo(
		files: Record<string, string>,
		opts: { group?: boolean; profile?: 'node' | 'infra' } = {},
	): Promise<string> {
		const profile = opts.profile ?? 'node';
		const { dir, remote } = gitRepo(profile === 'node' ? { ...BARE, ...files } : files);
		made.push(dir, remote);
		const withGroup = opts.group === false ? [] : ['--with', 'guardrails'];
		expect((await run(['init', '--profile', profile, ...withGroup], dir)).code).toBe(0);
		expect((await run(['sync'], dir)).code).toBe(0);
		git(dir, 'add', '-A');
		git(dir, 'commit', '-m', 'canon');
		return dir;
	}

	const violations = (err: string) => err.split('\n').filter((l) => l.startsWith(VIOLATION_LINE));
	// Пометки инструмента: `guardrails <tool> <версия>: …` или `guardrails <tool>: skipped (no files)`.
	const notes = (err: string, tool: string) =>
		err
			.split('\n')
			.filter((l) => l.startsWith(`guardrails ${tool}: `) || l.startsWith(`guardrails ${tool} `))
			.filter((l) => !l.startsWith(`guardrails ${tool} commits`));
	const hadolintFindings = (err: string) =>
		violations(err).filter((l) => l.includes(' — hadolint '));

	test(
		'приёмка 1 и 11: по нарушению на инструмент — шесть находок, версии пометок из источников',
		async () => {
			const dir = await guardRepo(BAD_FILES);
			const r = await run(['check'], dir, tools);
			expect(r.err).not.toContain('guardrails-unavailable');
			expect(r.code).toBe(1);
			const found = violations(r.err);
			expect(found).toHaveLength(6);
			const expected: [string, string][] = [
				['.github/workflows/lint.yml', 'actionlint'],
				['scripts/a.sh', 'shellcheck'],
				['src/a.ts', 'gitleaks'],
				['Dockerfile', 'hadolint'],
				['README.md', 'markdownlint-cli2'],
				['bad.yml', 'yamllint'],
			];
			for (const [path, tool] of expected) {
				const mine = found.filter((l) => l.includes(` — ${tool} `));
				expect(mine).toHaveLength(1);
				expect(mine[0]).toMatch(new RegExp(`^guardrails-violation: ${path}:\\d+ — ${tool} \\S+: `));
			}
			expect(found[3]).toContain(' — hadolint DL3025: ');
			expect(found[4]).toContain(' — markdownlint-cli2 MD040: ');
			expect(found[5]).toContain(' — yamllint key-duplicates: ');
			// версии пометок: proto-пины, dependencies stack и константа yamllint
			const versions: Record<string, string | undefined> = {
				actionlint: PINS.actionlint,
				shellcheck: PINS.shellcheck,
				gitleaks: PINS.gitleaks,
				hadolint: PINS.hadolint,
				'markdownlint-cli2': MARKDOWNLINT_VERSION,
				yamllint: YAMLLINT_VERSION,
			};
			for (const tool of TOOLS) {
				expect(
					notes(r.err, tool).filter((l) => l.startsWith(`guardrails ${tool} ${versions[tool]}: `)),
				).toHaveLength(1);
			}
			expect(r.out).not.toContain('canon: no drift');
			expect(r.out).not.toContain(HEX);
			expect(r.err).not.toContain(HEX);
		},
		TIMEOUT,
	);

	test(
		'чистый репозиторий: no drift, у каждого из шести ровно одна пометка',
		async () => {
			const dir = await guardRepo(CLEAN_FILES);
			const r = await run(['check'], dir, tools);
			expect(r.err).not.toContain(VIOLATION_LINE);
			expect(r.err).not.toContain('guardrails-unavailable');
			expect(r.code).toBe(0);
			expect(r.out).toBe(NO_DRIFT);
			for (const tool of TOOLS) {
				expect(notes(r.err, tool)).toHaveLength(1);
			}
		},
		TIMEOUT,
	);

	test(
		'приёмка 8: неотслеживаемые файлы и каталог worktree не доходят до инструментов',
		async () => {
			const dir = await guardRepo({ ...CLEAN_FILES, '.gitignore': '.worktrees/\n' });
			const dirty = {
				'local.Dockerfile': LOCAL_DOCKERFILE,
				'notes.md': BAD_README,
				'local.yml': BAD_YAML,
			};
			for (const [path, text] of Object.entries(dirty)) put(dir, path, text);
			git(dir, 'worktree', 'add', '--detach', '.worktrees/wt');
			for (const [path, text] of Object.entries(dirty)) put(dir, join('.worktrees/wt', path), text);
			const r = await run(['check'], dir, tools);
			expect(violations(r.err)).toStrictEqual([]);
			expect(r.err).not.toContain('guardrails-unavailable');
			expect(r.code).toBe(0);
			expect(r.out).toBe(NO_DRIFT);
		},
		TIMEOUT,
	);

	test(
		'приёмка 5: порог и override отслеживаемого конфига hadolint действуют, неотслеживаемый — нет',
		async () => {
			const df = { Dockerfile: BAD_DOCKERFILE };
			const threshold = await guardRepo({
				...CLEAN_FILES,
				...df,
				[HADOLINT_CONFIG]: 'failure-threshold: error\n',
			});
			const a = await run(['check'], threshold, tools);
			expect(hadolintFindings(a.err)).toHaveLength(1);
			expect(a.err).toContain(' — hadolint DL3025: ');
			expect(a.code).toBe(1);

			const lowered = await guardRepo({
				...CLEAN_FILES,
				...df,
				[HADOLINT_CONFIG]: 'override:\n  info: [DL3025]\n',
			});
			const b = await run(['check'], lowered, tools);
			expect(hadolintFindings(b.err)).toStrictEqual([]);
			expect(b.err).not.toContain('guardrails-unavailable');
			expect(b.code).toBe(0);
			expect(b.out).toBe(NO_DRIFT);

			const untracked = await guardRepo({ ...CLEAN_FILES, ...df });
			put(untracked, HADOLINT_CONFIG, 'ignored: [DL3025]\n');
			const c = await run(['check'], untracked, tools);
			expect(hadolintFindings(c.err)).toHaveLength(1);
			expect(c.err).toContain(' — hadolint DL3025: ');
			expect(c.code).toBe(1);
		},
		TIMEOUT,
	);

	test(
		'сломанный отслеживаемый .hadolint.yaml — короткая пометка',
		async () => {
			const dir = await guardRepo({
				...CLEAN_FILES,
				Dockerfile: BAD_DOCKERFILE,
				[HADOLINT_CONFIG]: 'ignored: [\n',
			});
			const r = await run(['check'], dir, tools);
			const lines = r.err
				.split('\n')
				.filter((l) => l.startsWith('guardrails-unavailable: hadolint — '));
			expect(lines).toHaveLength(1);
			const line = lines[0] ?? '';
			expect(line).toContain(HADOLINT_CONFIG);
			expect(line).not.toContain('\\n');
			expect(line).not.toContain(tmpdir());
			expect(line).not.toContain(realpathSync(tmpdir()));
			expect(line.length).toBeLessThan(200);
			expect(r.code).toBe(1);
		},
		TIMEOUT,
	);

	test(
		'hadolint из HOME и XDG_CONFIG_HOME не действует: находка DL3025 остаётся',
		async () => {
			const dir = await guardRepo({ ...CLEAN_FILES, Dockerfile: BAD_DOCKERFILE });
			const home = mkdtempSync(join(tmpdir(), 'stack-foreign-home-'));
			made.push(home);
			// Все места, где hadolint ищет конфиг вне репозитория; имена собираются (cite-check).
			const plain = ['hadolint', 'yaml'].join('.');
			for (const rel of [
				plain,
				join('.config', plain),
				HADOLINT_CONFIG,
				join('.hadolint', plain),
			]) {
				mkdirSync(dirname(join(home, rel)), { recursive: true });
				writeFileSync(join(home, rel), 'ignored: [DL3025]\n');
			}
			// proto ищет инструменты через ~/.proto: без PROTO_HOME чужой HOME ломает поиск, а не конфиг.
			const env = {
				...tools,
				HOME: home,
				XDG_CONFIG_HOME: home,
				PROTO_HOME: process.env.PROTO_HOME ?? join(homedir(), '.proto'),
			};
			const r = await run(['check'], dir, env);
			expect(r.err).not.toContain('guardrails-unavailable');
			expect(hadolintFindings(r.err)).toHaveLength(1);
			expect(r.err).toContain(' — hadolint DL3025: ');
			expect(r.code).toBe(1);
		},
		TIMEOUT,
	);

	test(
		'профиль infra без package.json и node_modules: markdownlint-cli2 берётся из установки stack',
		async () => {
			const dir = await guardRepo({ 'README.md': BAD_README }, { profile: 'infra' });
			const r = await run(['check'], dir, tools);
			expect(r.err).not.toContain('guardrails-unavailable');
			const found = violations(r.err);
			expect(found).toHaveLength(1);
			expect(found[0]).toStartWith('guardrails-violation: README.md:3 — markdownlint-cli2 MD040: ');
			expect(r.code).toBe(1);
		},
		TIMEOUT,
	);

	test(
		'uv без сети на холодном кэше: guardrails-unavailable yamllint, не no drift',
		async () => {
			const dir = await guardRepo({ ...CLEAN_FILES, 'bad.yml': BAD_YAML });
			const cache = mkdtempSync(join(tmpdir(), 'stack-uv-cache-'));
			try {
				const r = await run(['check'], dir, { ...tools, UV_OFFLINE: '1', UV_CACHE_DIR: cache });
				expect(r.code).toBe(1);
				const lines = r.err.split('\n').filter((l) => l.startsWith('guardrails-unavailable: '));
				expect(lines).toHaveLength(1);
				expect(lines[0]).toStartWith('guardrails-unavailable: yamllint — error: No solution found');
				expect(r.out).not.toContain('canon: no drift');
			} finally {
				rmSync(cache, { recursive: true, force: true });
			}
		},
		TIMEOUT,
	);

	test(
		'без группы те же шесть нарушений не видны, слова guardrails в stderr нет',
		async () => {
			const dir = await guardRepo(BAD_FILES, { group: false });
			const r = await run(['check'], dir, tools);
			expect(r.code).toBe(0);
			expect(r.out).toBe(NO_DRIFT);
			expect(r.err).not.toContain('guardrails');
		},
		TIMEOUT,
	);
});
