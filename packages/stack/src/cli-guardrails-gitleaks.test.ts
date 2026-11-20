import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { parsePins } from './canon.ts';
import {
	BARE,
	git,
	gitRepo,
	historyStep,
	isolateGitConfig,
	protoBin,
	put,
	ROOT,
	runCli as run,
	shallowPrCheckout,
} from './testkit.ts';

// Приёмка gitleaks группы guardrails через настоящий cli на пиннутых бинарниках.
describe('check с группой guardrails: gitleaks через настоящий cli', () => {
	// 64 hex собираются во время выполнения; в имени нет слов key, secret, token (generic-api-key).
	const HEX = '0123456789abcdef'.repeat(4);
	const LINE = `ETH_PRIV=0x${HEX}\n`;
	const RULE = 'eth-private-key-no-prefix';
	const DESCRIPTION = 'Ethereum private key (32 bytes hex, with or without 0x prefix)';
	const NO_DRIFT = 'canon: no drift\n';
	const VIOLATION_LINE = 'guardrails-violation: ';
	const LOCAL = { GITHUB_ACTIONS: '', GITHUB_EVENT_NAME: '', GITHUB_BASE_REF: '' };
	const PR = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request', GITHUB_BASE_REF: 'main' };
	const PUSH = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push', GITHUB_BASE_REF: '' };
	const TIMEOUT = 60_000;
	const PINS = parsePins(readFileSync(join(ROOT, 'packages/stack/canon/files/prototools'), 'utf8'));
	const ignores = '*.local\n.worktrees/\n';

	let restore: () => void;
	let tools: Record<string, string>;
	beforeAll(() => {
		restore = isolateGitConfig();
		tools = {
			ACTIONLINT_BIN: protoBin('actionlint'),
			SHELLCHECK_BIN: protoBin('shellcheck'),
			GITLEAKS_BIN: protoBin('gitleaks'),
		};
	});
	afterAll(() => restore());

	// Репозиторий под git: init с группой (или без), sync, всё закоммичено и отправлено в origin/main.
	async function guardRepo(
		files: Record<string, string>,
		opts: { group?: boolean } = {},
	): Promise<{ dir: string; remote: string }> {
		const made = gitRepo({ ...BARE, ...files });
		const withGroup = opts.group === false ? [] : ['--with', 'guardrails'];
		expect((await run(['init', '--profile', 'node', ...withGroup], made.dir)).code).toBe(0);
		expect((await run(['sync'], made.dir)).code).toBe(0);
		git(made.dir, 'add', '-A');
		git(made.dir, 'commit', '-m', 'canon');
		git(made.dir, 'push', 'origin', 'main');
		return made;
	}

	const violations = (err: string) => err.split('\n').filter((l) => l.startsWith(VIOLATION_LINE));
	const noValue = (r: { out: string; err: string }) => {
		for (const text of [r.out, r.err]) {
			expect(text).not.toContain(HEX);
			expect(text).not.toContain(HEX.slice(0, 16));
		}
	};
	const finding = (path: string) =>
		`guardrails-violation: ${path}:1 — gitleaks ${RULE}: ${DESCRIPTION}`;

	// Ветка feature добавляет секрет коммитом и удаляет следующим; main ушёл вперёд; merge-коммит в refs/pull/1/merge.
	// Возвращает sha добавившего коммита и путь bare-remote.
	async function prOrigin(): Promise<{ added: string; remote: string; dir: string }> {
		const { dir, remote } = await guardRepo({ '.gitignore': ignores });
		git(dir, 'checkout', '-b', 'feature');
		put(dir, 'leak.ts', LINE);
		git(dir, 'add', 'leak.ts');
		git(dir, 'commit', '-m', 'add leak');
		const added = git(dir, 'rev-parse', 'HEAD').trim();
		git(dir, 'rm', '-q', 'leak.ts');
		git(dir, 'commit', '-m', 'remove leak');
		git(dir, 'checkout', 'main');
		put(dir, 'later.txt', 'main moved on\n');
		git(dir, 'add', 'later.txt');
		git(dir, 'commit', '-m', 'main moves on');
		git(dir, 'push', 'origin', 'main');
		git(dir, 'checkout', '--detach', 'main');
		git(dir, 'merge', '--no-ff', 'feature', '-m', 'merge pr');
		git(dir, 'push', 'origin', 'HEAD:refs/pull/1/merge');
		git(remote, 'config', 'uploadpack.allowFilter', 'true');
		return { added, remote, dir };
	}

	test(
		'приёмка 6: закоммиченный секрет — одна находка по файлу, значения в выводе нет',
		async () => {
			const { dir } = await guardRepo({ 'src/a.ts': LINE });
			const r = await run(['check'], dir, { ...tools, ...LOCAL });
			expect(r.code).toBe(1);
			expect(violations(r.err)).toStrictEqual([finding('src/a.ts')]);
			expect(r.err).toContain(`guardrails gitleaks ${PINS.gitleaks}: `);
			expect(r.err).toContain(
				'guardrails gitleaks commits: skipped (no --base outside GitHub Actions)',
			);
			noValue(r);
		},
		TIMEOUT,
	);

	test(
		'приёмка 6 и 8: секрет вне отслеживаемых файлов (.env, игнорируемый, чужой worktree) не виден',
		async () => {
			const { dir } = await guardRepo({ '.gitignore': ignores });
			put(dir, '.env', LINE);
			put(dir, 'x.local', LINE);
			git(dir, 'worktree', 'add', '--detach', '.worktrees/wt');
			put(dir, '.worktrees/wt/untracked.ts', LINE);
			const r = await run(['check'], dir, { ...tools, ...LOCAL });
			expect(r.code).toBe(0);
			expect(r.out).toBe(NO_DRIFT);
			noValue(r);
		},
		TIMEOUT,
	);

	test(
		'приёмка 6: PR-джоб — секрет, добавленный и удалённый в ветке, находится в коммите',
		async () => {
			const { added, remote } = await prOrigin();
			const work = shallowPrCheckout(remote);
			const s = historyStep(work);
			expect(s.code).toBe(0);
			const r = await run(['check'], work, { ...tools, ...PR });
			expect(r.code).toBe(1);
			expect(violations(r.err)).toStrictEqual([
				`${finding('leak.ts')} (commit ${added.slice(0, 12)})`,
			]);
			expect(r.err).toMatch(/guardrails gitleaks commits [0-9a-f]{12}\.\.HEAD: 1 finding\(s\)/);
			noValue(r);
		},
		TIMEOUT,
	);

	test(
		'приёмка 6: без истории тот же мелкий checkout — guardrails-unavailable, не no drift',
		async () => {
			const { remote } = await prOrigin();
			const work = shallowPrCheckout(remote);
			const r = await run(['check'], work, { ...tools, ...PR });
			expect(r.code).toBe(1);
			expect(r.err).toContain(
				'guardrails-unavailable: gitleaks commits — git merge-base origin/main HEAD: ',
			);
			expect(r.out).not.toContain('canon: no drift');
			noValue(r);
		},
		TIMEOUT,
	);

	test(
		'базы нет среди веток origin — guardrails-unavailable',
		async () => {
			const { remote } = await prOrigin();
			const work = shallowPrCheckout(remote);
			expect(historyStep(work).code).toBe(0);
			const r = await run(['check'], work, { ...tools, ...PR, GITHUB_BASE_REF: 'gone' });
			expect(r.code).toBe(1);
			expect(r.err).toContain(
				'guardrails-unavailable: gitleaks commits — git merge-base origin/gone HEAD: ',
			);
			expect(r.out).not.toContain('canon: no drift');
		},
		TIMEOUT,
	);

	test(
		'приёмка 6: вне PR (push) — пропуск с пометкой, код 0',
		async () => {
			const { dir } = await guardRepo({ '.gitignore': ignores });
			const r = await run(['check'], dir, { ...tools, ...PUSH });
			expect(r.code).toBe(0);
			expect(r.out).toBe(NO_DRIFT);
			expect(r.err).toContain('guardrails gitleaks commits: skipped (not a pull request)');
		},
		TIMEOUT,
	);

	test(
		'--base локально: коммиты ветки от базы сканируются',
		async () => {
			const { dir } = await guardRepo({ '.gitignore': ignores });
			git(dir, 'checkout', '-b', 'feature');
			put(dir, 'leak.ts', LINE);
			git(dir, 'add', 'leak.ts');
			git(dir, 'commit', '-m', 'add leak');
			const added = git(dir, 'rev-parse', 'HEAD').trim();
			git(dir, 'rm', '-q', 'leak.ts');
			git(dir, 'commit', '-m', 'remove leak');
			const r = await run(['check', '--base', 'main'], dir, { ...tools, ...LOCAL });
			expect(r.code).toBe(1);
			expect(violations(r.err)).toStrictEqual([
				`${finding('leak.ts')} (commit ${added.slice(0, 12)})`,
			]);
			noValue(r);
		},
		TIMEOUT,
	);

	test(
		'сломанный конфиг gitleaks — guardrails-unavailable и canon-not-extended, не no drift',
		async () => {
			const { dir } = await guardRepo({
				'.gitignore': ignores,
				'.gitleaks.toml': '[extend\npath = ".gitleaks.canon.toml"\n',
			});
			const r = await run(['check'], dir, { ...tools, ...LOCAL });
			expect(r.code).toBe(1);
			expect(r.err).toContain(
				'guardrails-unavailable: gitleaks — FTL unable to load gitleaks config, err: While parsing config: toml: ',
			);
			expect(r.err).toContain('canon-not-extended');
			expect(r.out).not.toContain('canon: no drift');
		},
		TIMEOUT,
	);

	test(
		'.gitleaks.toml без [extend] — canon-not-extended, gitleaks отработал',
		async () => {
			const { dir } = await guardRepo({
				'.gitignore': ignores,
				'.gitleaks.toml': 'title = "own"\n',
			});
			const r = await run(['check'], dir, { ...tools, ...LOCAL });
			expect(r.code).toBe(1);
			expect(r.err).toContain('canon-not-extended');
			expect(r.err).not.toContain('guardrails-unavailable');
		},
		TIMEOUT,
	);

	test(
		'без группы: gitleaks не запускается, секрет не мешает',
		async () => {
			const { dir } = await guardRepo({ 'src/a.ts': LINE }, { group: false });
			const r = await run(['check'], dir, { GITLEAKS_BIN: '/nonexistent/gitleaks', ...LOCAL });
			expect(r.code).toBe(0);
			expect(r.out).toBe(NO_DRIFT);
			expect(r.err).not.toContain('guardrails');
		},
		TIMEOUT,
	);
});
