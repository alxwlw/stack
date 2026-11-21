import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { parsePins } from './canon.ts';
import { BARE, git, gitRepo, isolateGitConfig, protoBin, ROOT, runCli as run } from './testkit.ts';

// Гигиена workflow в группе guardrails через настоящий cli на пиннутых actionlint и shellcheck.
describe('гигиена workflow в check с группой guardrails через настоящий cli', () => {
	const BUILD = '.github/workflows/build.yml';
	const TIMEOUT = 60_000;
	const NO_DRIFT = 'canon: no drift\n';
	const PINS = parsePins(readFileSync(join(ROOT, 'packages/stack/canon/files/prototools'), 'utf8'));
	const STALE_PIN = '0.60.2';
	const KEYS = 'permissions:\n  contents: read\nconcurrency: build\n';
	const job = (timeout: string) =>
		`jobs:\n  build:\n    runs-on: ubuntu-latest\n${timeout}    steps:\n      - uses: moonrepo/setup-toolchain@v0\n        with:\n          proto-version: ${STALE_PIN}\n      - run: 'true'\n`;
	const BARE_BUILD = `name: build\non: push\n${job('')}`;
	const CLEAN_BUILD = `name: build\non: push\n${KEYS}${job('    timeout-minutes: 10\n')}`;
	const LINE = `workflow-hygiene: ${BUILD} — missing timeout-minutes (build); permissions (top level, or in build); concurrency (top level, or in build)`;

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
	afterAll(() => restore());

	// Репозиторий под git: init с группой (или без), sync, всё закоммичено; build.yml — после sync, чтобы
	// чужой пин дожил до check.
	async function guardRepo(build: string, opts: { group?: boolean } = {}): Promise<string> {
		const { dir } = gitRepo({ ...BARE });
		const withGroup = opts.group === false ? [] : ['--with', 'guardrails'];
		expect((await run(['init', '--profile', 'node', ...withGroup], dir)).code).toBe(0);
		expect((await run(['sync'], dir)).code).toBe(0);
		const path = join(dir, BUILD);
		git(dir, 'add', '-A');
		git(dir, 'commit', '-m', 'canon');
		writeFileSync(path, build);
		git(dir, 'add', '-A');
		git(dir, 'commit', '-m', 'build');
		return dir;
	}

	test(
		'check: находка гигиены, выход 1',
		async () => {
			const dir = await guardRepo(BARE_BUILD.replace(STALE_PIN, PINS.proto ?? ''));
			const r = await run(['check'], dir, tools);
			expect(r.code).toBe(1);
			expect(r.err).toContain(LINE);
			expect(r.err).toContain('stack sync does not fix these');
		},
		TIMEOUT,
	);

	test(
		'check: ключи дописаны — no drift',
		async () => {
			const dir = await guardRepo(CLEAN_BUILD.replace(STALE_PIN, PINS.proto ?? ''));
			const r = await run(['check'], dir, tools);
			expect(r.out).toBe(NO_DRIFT);
			expect(r.code).toBe(0);
		},
		TIMEOUT,
	);

	test(
		'без группы вывод прежний',
		async () => {
			const dir = await guardRepo(BARE_BUILD.replace(STALE_PIN, PINS.proto ?? ''), {
				group: false,
			});
			const r = await run(['check'], dir, tools);
			expect(r.out).toBe(NO_DRIFT);
			expect(r.err).not.toContain('workflow-hygiene');
			expect(r.code).toBe(0);
		},
		TIMEOUT,
	);

	test(
		'sync правит копию пина в том же файле и не трогает гигиену',
		async () => {
			const dir = await guardRepo(BARE_BUILD);
			const before = await run(['check'], dir, tools);
			expect(before.code).toBe(1);
			expect(before.err).toContain('toolchain-pin');
			expect(before.err).toContain(LINE);
			expect((await run(['sync'], dir, tools)).code).toBe(0);
			const text = readFileSync(join(dir, BUILD), 'utf8');
			expect(text).toContain(`proto-version: ${PINS.proto}`);
			expect(text).not.toContain(STALE_PIN);
			for (const key of ['timeout-minutes', 'permissions', 'concurrency'])
				expect(text).not.toContain(key);
			git(dir, 'add', '-A');
			git(dir, 'commit', '-m', 'synced');
			const after = await run(['check'], dir, tools);
			expect(after.code).toBe(1);
			expect(after.err).toContain(LINE);
			expect(after.err).not.toContain('toolchain-pin');
		},
		TIMEOUT,
	);
});
