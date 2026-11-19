import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { parse as parseYaml } from 'yaml';

import {
	BARE,
	CLI,
	git,
	gitRepo,
	isolateGitConfig,
	repoDir,
	runCli as run,
	spawnIn,
} from './testkit.ts';

describe('check с группой repo-rules через настоящий cli', () => {
	const LOCAL = { GITHUB_ACTIONS: '', GITHUB_EVENT_NAME: '', GITHUB_BASE_REF: '' };
	const PR = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request', GITHUB_BASE_REF: 'main' };
	const PUSH = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push', GITHUB_BASE_REF: '' };
	const ONLY = "test.only('x', () => {});\n";
	const TWO_EXPECTS = 'expect(1).toBe(1);\nexpect(2).toBe(2);\n';
	const TWO_DISABLES =
		'// eslint-disable-next-line\nexport const a = 1;\n// eslint-disable-next-line\nexport const b = 2;\n';
	const BASELINE = '.repo-rules-baseline.json';
	const NO_DRIFT = 'canon: no drift\n';
	const REMOVED_LINE = 'repo-rules-violation: a.test.ts — removed-assertions: −1 / +0 assertions';

	let restore: () => void;
	beforeAll(() => {
		restore = isolateGitConfig();
	});
	afterAll(() => restore());

	// Репозиторий под git: init (с группой или без), sync, по желанию baseline repo-rules; всё закоммичено и
	// отправлено в origin/main. Пакета @alxwlw/repo-rules в манифестах нет.
	async function rulesRepo(
		files: Record<string, string>,
		opts: { group?: boolean; baseline?: boolean } = {},
	): Promise<string> {
		const { dir } = gitRepo({ ...BARE, ...files });
		const withGroup = opts.group === false ? [] : ['--with', 'repo-rules'];
		expect((await run(['init', '--profile', 'node', ...withGroup], dir)).code).toBe(0);
		expect((await run(['sync'], dir)).code).toBe(0);
		git(dir, 'add', '-A');
		if (opts.baseline !== false) {
			expect((await spawnIn(['bun', CLI, 'repo-rules', 'baseline', '--init'], dir)).code).toBe(0);
			git(dir, 'add', '-A');
		}
		git(dir, 'commit', '-m', 'canon');
		git(dir, 'push', 'origin', 'main');
		return dir;
	}

	// Ветка PR: удалена одна из двух проверок, коммит не отправлен.
	async function removedAssertion(): Promise<string> {
		const dir = await rulesRepo({ 'a.test.ts': TWO_EXPECTS });
		writeFileSync(join(dir, 'a.test.ts'), 'expect(1).toBe(1);\n');
		git(dir, 'add', '-A');
		git(dir, 'commit', '-m', 'drop a check');
		return dir;
	}

	test('приёмка 1: чистый baseline — no drift и пометка о пропуске diff', async () => {
		const dir = await rulesRepo({ 'src/a.ts': TWO_DISABLES });
		const r = await run(['check'], dir, LOCAL);
		expect(r.code).toBe(0);
		expect(r.out).toBe(NO_DRIFT);
		expect(r.err).toContain('repo-rules diff: skipped (no --base outside GitHub Actions)');
	});

	test('приёмка 1: новое нарушение и устаревшая запись baseline — код 1', async () => {
		const dir = await rulesRepo({ 'src/a.ts': TWO_DISABLES });
		writeFileSync(join(dir, 'src/a.ts'), '// eslint-disable-next-line\nexport const a = 1;\n');
		writeFileSync(join(dir, 'c.test.ts'), ONLY);
		git(dir, 'add', '-A');
		const r = await run(['check'], dir, LOCAL);
		expect(r.code).toBe(1);
		expect(r.err).toContain('repo-rules-violation: c.test.ts:1 — focused-skipped-tests: ');
		expect(r.err).toContain(
			'stale-repo-rules-baseline: src/a.ts — suppression-reason: recorded 2, now 1; lower it with: stack repo-rules baseline',
		);
		expect(r.err).toContain('stack sync does not fix these');
		expect(r.out).not.toContain('canon: no drift');
	});

	test('приёмка 2: PR-джоб сообщает удалённую проверку', async () => {
		const dir = await removedAssertion();
		const r = await run(['check'], dir, PR);
		expect(r.code).toBe(1);
		expect(r.err).toContain(REMOVED_LINE);
		expect(r.err).toContain(
			'repo-rules diff: intended? add a commit trailer "Tests-Removed: <reason>" in the range',
		);
	});

	test('приёмка 2: вне PR — пропуск с пометкой, код 0', async () => {
		const dir = await removedAssertion();
		const r = await run(['check'], dir, PUSH);
		expect(r.code).toBe(0);
		expect(r.err).toContain('repo-rules diff: skipped (not a pull request)');
		expect(r.out).toBe(NO_DRIFT);
	});

	test('--base локально: с базой — нарушение, без неё — пометка', async () => {
		const dir = await removedAssertion();
		const withBase = await run(['check', '--base', 'origin/main'], dir, LOCAL);
		expect(withBase.code).toBe(1);
		expect(withBase.err).toContain(REMOVED_LINE);
		const without = await run(['check'], dir, LOCAL);
		expect(without.code).toBe(0);
		expect(without.err).toContain('skipped (no --base outside GitHub Actions)');
	});

	test('baseline не разбирается — repo-rules-unavailable, не no drift', async () => {
		const dir = await rulesRepo({});
		writeFileSync(join(dir, BASELINE), 'not json');
		const r = await run(['check'], dir, LOCAL);
		expect(r.code).toBe(1);
		expect(r.err).toContain('repo-rules-unavailable: repo-rules check — ');
		expect(r.err).toContain('not JSON');
		expect(r.out).not.toContain('canon: no drift');
	});

	test('базовой ветки нет — repo-rules-unavailable у diff, check отработал', async () => {
		const dir = await rulesRepo({});
		const r = await run(['check'], dir, { ...PR, GITHUB_BASE_REF: 'gone' });
		expect(r.code).toBe(1);
		expect(r.err).toContain('repo-rules-unavailable: repo-rules diff — git merge-base failed');
		expect(r.err).not.toContain('repo-rules check');
	});

	test('каталог не под git — repo-rules-unavailable', async () => {
		const dir = repoDir(BARE);
		expect((await run(['init', '--profile', 'node', '--with', 'repo-rules'], dir)).code).toBe(0);
		expect((await run(['sync'], dir)).code).toBe(0);
		const r = await run(['check'], dir, LOCAL);
		expect(r.code).toBe(1);
		expect(r.err).toContain('repo-rules-unavailable: repo-rules check — git rev-parse failed');
	});

	test('группа без файла baseline — нарушения становятся находками', async () => {
		const dir = await rulesRepo({ 'c.test.ts': ONLY }, { baseline: false });
		const r = await run(['check'], dir, LOCAL);
		expect(r.code).toBe(1);
		expect(r.err).toContain('repo-rules-violation: c.test.ts:1 — focused-skipped-tests: ');
	});

	test('группа выключена: repo-rules не запускается, --base не мешает', async () => {
		const dir = await rulesRepo({ 'c.test.ts': ONLY }, { group: false, baseline: false });
		const cfg = join(dir, '.stack.jsonc');
		writeFileSync(cfg, `// repo-rules: not yet\n${readFileSync(cfg, 'utf8')}`);
		const r = await run(['check', '--base', 'origin/main'], dir, PR);
		expect(r.code).toBe(0);
		expect(r.out).toBe(NO_DRIFT);
		expect(r.err).not.toContain('repo-rules');
		// Без базы и вне Actions включённая группа дала бы пометку о пропуске diff: её нет.
		const local = await run(['check'], dir, LOCAL);
		expect(local.code).toBe(0);
		expect(local.err).not.toContain('repo-rules');
	});

	test('--repo на подкаталог git: проверяется весь репозиторий, пути от его корня', async () => {
		const { dir } = gitRepo({
			'x.test.ts': ONLY,
			'app/package.json': BARE['package.json'],
			'app/pnpm-workspace.yaml': BARE['pnpm-workspace.yaml'],
		});
		const app = join(dir, 'app');
		expect((await run(['init', '--profile', 'node', '--with', 'repo-rules'], app)).code).toBe(0);
		expect((await run(['sync'], app)).code).toBe(0);
		git(dir, 'add', '-A');
		const r = await run(['check'], app, LOCAL);
		expect(r.code).toBe(1);
		expect(r.err).toContain('repo-rules-violation: x.test.ts:1 — focused-skipped-tests: ');
	});

	describe('check.yml: история для diff группы repo-rules', () => {
		// Скрипт шага history берётся из check.yml и исполняется как на runner: bash -e -c в корне checkout.
		const historyScript = (): string => {
			const wf = parseYaml(
				readFileSync(join(import.meta.dir, '../../../.github/workflows/check.yml'), 'utf8'),
			) as { jobs: Record<string, { steps: { id?: string; run?: string }[] }> };
			const step = Object.values(wf.jobs)
				.flatMap((j) => j.steps)
				.find((s) => s.id === 'history');
			if (!step?.run) throw new Error('check.yml has no history step');
			return step.run;
		};
		const step = (cwd: string, baseRef = 'main') => {
			const r = spawnSync('bash', ['-e', '-c', historyScript()], {
				cwd,
				encoding: 'utf8',
				env: { ...process.env, GITHUB_BASE_REF: baseRef },
			});
			return { code: r.status, err: r.stderr };
		};
		const probe = (cwd: string, ...args: string[]) => {
			const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
			return { code: r.status, out: r.stdout.trim() };
		};

		// origin с PR: feature убирает одну проверку из тестового файла фикстуры, main после ответвления ушёл на коммит вперёд,
		// merge-коммит лежит в refs/pull/1/merge, как у GitHub. Возвращает путь bare-remote.
		async function prOrigin(opts: { group?: boolean; baseline?: boolean } = {}): Promise<string> {
			const dir = await rulesRepo({ 'a.test.ts': TWO_EXPECTS }, opts);
			git(dir, 'checkout', '-b', 'feature');
			writeFileSync(join(dir, 'a.test.ts'), 'expect(1).toBe(1);\n');
			git(dir, 'commit', '-am', 'drop a check');
			git(dir, 'checkout', 'main');
			writeFileSync(join(dir, 'later.txt'), 'main moved on\n');
			git(dir, 'add', 'later.txt');
			git(dir, 'commit', '-m', 'main moves on');
			git(dir, 'push', 'origin', 'main');
			git(dir, 'checkout', '--detach', 'main');
			git(dir, 'merge', '--no-ff', 'feature', '-m', 'merge pr');
			git(dir, 'push', 'origin', 'HEAD:refs/pull/1/merge');
			const remote = git(dir, 'remote', 'get-url', 'origin').trim();
			git(remote, 'config', 'uploadpack.allowFilter', 'true');
			return remote;
		}

		// Каталог, каким его оставляет actions/checkout в PR-джобе с fetch-depth 1: один коммит, HEAD — merge-коммит,
		// origin/<база> нет.
		function shallowPrCheckout(remote: string): string {
			const work = mkdtempSync(join(tmpdir(), 'stack-pr-'));
			git(work, 'init', '-b', 'main');
			git(work, 'remote', 'add', 'origin', `file://${remote}`);
			git(
				work,
				'fetch',
				'--no-tags',
				'--depth=1',
				'origin',
				'+refs/pull/1/merge:refs/remotes/pull/1/merge',
			);
			git(work, 'checkout', '--force', 'refs/remotes/pull/1/merge');
			return work;
		}

		test('группа включена: после шага stack check видит удалённую проверку', async () => {
			const work = shallowPrCheckout(await prOrigin());
			expect(probe(work, 'rev-parse', '--is-shallow-repository').out).toBe('true');
			const s = step(work);
			expect(s.code).toBe(0);
			expect(probe(work, 'rev-parse', '--is-shallow-repository').out).toBe('false');
			expect(probe(work, 'merge-base', 'origin/main', 'HEAD').code).toBe(0);
			const r = await run(['check'], work, PR);
			expect(r.code).toBe(1);
			expect(r.err).toContain(REMOVED_LINE);
		});

		test('контроль: без шага тот же checkout — repo-rules-unavailable', async () => {
			const work = shallowPrCheckout(await prOrigin());
			const r = await run(['check'], work, PR);
			expect(r.code).toBe(1);
			expect(r.err).toContain('repo-rules-unavailable: repo-rules diff — git merge-base failed');
		});

		test('группа выключена: шаг ничего не скачивает', async () => {
			const work = shallowPrCheckout(await prOrigin({ group: false, baseline: false }));
			expect(step(work).code).toBe(0);
			expect(probe(work, 'rev-parse', '--is-shallow-repository').out).toBe('true');
			expect(probe(work, 'rev-parse', '--verify', '-q', 'origin/main').code).toBe(1);
		});

		test('нет .stack.jsonc: шаг проходит и ничего не скачивает', async () => {
			const work = shallowPrCheckout(await prOrigin({ group: false, baseline: false }));
			rmSync(join(work, '.stack.jsonc'));
			expect(step(work).code).toBe(0);
			expect(probe(work, 'rev-parse', '--is-shallow-repository').out).toBe('true');
		});

		test('слово repo-rules только в комментарии: лишний fetch, падения нет', async () => {
			const work = shallowPrCheckout(await prOrigin({ group: false, baseline: false }));
			const cfg = join(work, '.stack.jsonc');
			writeFileSync(cfg, `// "repo-rules" later\n${readFileSync(cfg, 'utf8')}`);
			expect(step(work).code).toBe(0);
			expect(probe(work, 'rev-parse', '--is-shallow-repository').out).toBe('false');
			const r = await run(['check'], work, PR);
			expect(r.code).toBe(0);
			expect(r.out).toBe(NO_DRIFT);
		});

		test('полный клон: шаг не зовёт --unshallow', async () => {
			const remote = await prOrigin();
			const work = mkdtempSync(join(tmpdir(), 'stack-full-'));
			git(work, 'clone', `file://${remote}`, '.');
			git(work, 'fetch', 'origin', '+refs/pull/1/merge:refs/remotes/pull/1/merge');
			git(work, 'checkout', '--force', 'refs/remotes/pull/1/merge');
			const s = step(work);
			expect(s.code).toBe(0);
			expect(s.err).toBe('');
		});

		test('базовой ветки нет на origin: шаг падает', async () => {
			const work = shallowPrCheckout(await prOrigin());
			const s = step(work, 'gone');
			expect(s.code).not.toBe(0);
			expect(s.err).toContain("couldn't find remote ref");
		});
	});
});
