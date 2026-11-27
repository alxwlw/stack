import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { COMMANDS, PASS_THROUGH } from './command.ts';
import { ownVersion } from './own-packages.ts';
import {
	BARE,
	fakeCommandPorts,
	gitRepo,
	isolateGitConfig,
	NODE_PKG,
	PR_URL,
	repoDir,
	repoRulesRun,
	runStack,
	UNMET_PEER_LOCK,
} from './testkit.ts';
import { testSource } from './testkit-sources.ts';

// Функция команды на подставных портах: argv, флаги, проводка портов, печать и коды выхода — без процесса.
describe('runCommand', () => {
	let restore: () => void;
	beforeAll(() => {
		restore = isolateGitConfig();
	});
	afterAll(() => restore());

	const TOKEN_ENV = { GH_TOKEN: 'secret-token', STACK_APP_SLUG: 'acme-bot' };
	const NODE = '{ "profile": "node" }';
	const AVAILABLE = 'init, sync, check, sync-pr, peers-baseline, repo-rules';
	const REPORT = repoRulesRun(0, { violations: [], stale: [], notes: [] });

	test('таблица: флаги заданы по командам', () => {
		expect(
			Object.fromEntries(Object.entries(COMMANDS).map(([name, c]) => [name, c.flags])),
		).toStrictEqual({
			init: ['profile', 'with'],
			sync: [],
			check: ['base'],
			'sync-pr': ['base', 'no-install'],
			'peers-baseline': ['init', 'allow-grow'],
		});
	});

	test('неизвестная команда: код 2, список — ключи таблицы и проводник, текст прежний', async () => {
		const r = await runStack(['помой-посуду'], repoDir(BARE));
		expect([...Object.keys(COMMANDS), PASS_THROUGH].join(', ')).toBe(AVAILABLE);
		expect(r).toMatchObject({
			code: 2,
			out: '',
			err: `unknown command "помой-посуду". Available: ${AVAILABLE}\n`,
		});
	});

	test.each(['constructor', '__proto__', 'toString'])(
		'имя из прототипа объекта — неизвестная команда, не вызов: %s',
		async (name) => {
			const r = await runStack([name], repoDir(BARE));
			expect(r).toMatchObject({
				code: 2,
				out: '',
				err: `unknown command "${name}". Available: ${AVAILABLE}\n`,
			});
		},
	);

	test.each([[[] as string[]], [['--repo', '/nowhere']]])(
		'argv без команды (%j) — неизвестная команда с пустым именем, код 2',
		async (argv) => {
			const r = await runStack(argv, repoDir(BARE));
			expect(r).toMatchObject({
				code: 2,
				out: '',
				err: `unknown command "". Available: ${AVAILABLE}\n`,
			});
		},
	);

	test('repo-rules среди позиционных — отказ с подсказкой, не «неизвестная команда»', async () => {
		const r = await runStack(['check', 'repo-rules'], repoDir(BARE));
		expect(r).toMatchObject({
			code: 2,
			out: '',
			err: 'repo-rules takes its own arguments and must come first: stack repo-rules [-C <dir>] <command>\n',
		});
	});

	test.each<[string, string[], string]>([
		['sync --base', ['sync', '--base', 'main'], '--base'],
		['check --no-install', ['check', '--no-install'], '--no-install'],
		['init --allow-grow', ['init', '--profile', 'node', '--allow-grow'], '--allow-grow'],
		['peers-baseline --profile', ['peers-baseline', '--profile', 'node'], '--profile'],
		['флаг до имени команды', ['--init', 'check'], '--init'],
		['рядом со своим флагом', ['sync-pr', '--base', 'main', '--init'], '--init'],
	])(
		'флаг чужой команды — код 2, строка называет флаг, команда не начала работу: %s',
		async (_name, argv, flag) => {
			const dir = repoDir({ ...BARE, 'pnpm-lock.yaml': UNMET_PEER_LOCK });
			const before = readdirSync(dir).toSorted();
			const r = await runStack(argv, dir, { env: TOKEN_ENV });
			expect(r.code).toBe(2);
			expect(r.out).toBe('');
			expect(r.err).toStartWith(`Unknown option '${flag}'`);
			expect(r.journal).toStrictEqual([]);
			expect(readdirSync(dir).toSorted()).toStrictEqual(before);
		},
	);

	test('--repo до имени команды и форма --флаг=значение доходят до обработчика', async () => {
		const dir = repoDir(BARE);
		const init = await runStack(
			['--repo', dir, 'init', '--profile=node', '--with=repo-rules'],
			repoDir({}),
		);
		expect(init).toMatchObject({ code: 0, out: `created ${join(dir, '.stack.jsonc')}\n`, err: '' });
		const calls: string[] = [];
		const checked = await runStack(['--base=origin/main', 'check'], dir, {
			ports: {
				repoRules: (argv) => {
					calls.push(argv.join(' '));
					return REPORT;
				},
			},
		});
		expect(calls).toStrictEqual([
			`-C ${dir} check --json`,
			`-C ${dir} diff --json --base origin/main`,
		]);
		expect(checked.code).toBe(1); // репозиторий без sync: дрейф канона
	});

	test('check: порты групп приходят из входа, порт Guardrails — фабрикой от корня', async () => {
		const dir = repoDir({
			...BARE,
			'.stack.jsonc': '{ "profile": "node", "with": ["peers", "repo-rules", "guardrails"] }',
			'pnpm-lock.yaml': UNMET_PEER_LOCK,
		});
		const tools: string[] = [];
		const r = await runStack(['check'], dir, {
			ports: {
				repoRules: () => REPORT,
				guardrails: (root) => (cmd) => {
					tools.push(`${root}: ${cmd}`);
					return { code: 1, out: '', err: 'fatal: stub' };
				},
			},
		});
		expect(r.journal).toContain(`peers ${dir}`);
		expect(tools[0]).toBe(`${dir}: git`);
		expect(r.err).toContain('guardrails-unavailable: git ls-files — fatal: stub\n');
		expect(r.code).toBe(1);
	});

	test('sync: удержанные в err идут раньше правок в out — порядок между каналами', async () => {
		const dir = repoDir({
			...BARE,
			'.editorconfig': 'свой\n',
			'.stack.jsonc':
				'{ "profile": "node", "exceptions": [{ "file": ".editorconfig", "reason": "свой отступ" }] }',
		});
		const r = await runStack(['sync'], dir);
		expect(r.code).toBe(0);
		expect(r.lines[0]?.stream).toBe('err');
		expect(r.lines[0]?.text).toStartWith('allowed (свой отступ): .editorconfig — ');
		expect(r.lines.slice(1).every((l) => l.stream === 'out')).toBe(true);
		expect(r.lines.at(-1)).toStrictEqual({ stream: 'out', text: 'canon applied' });
	});

	test.each([
		[{}],
		[{ GH_TOKEN: '', STACK_APP_SLUG: 'acme-bot' }],
		[{ GH_TOKEN: 't', STACK_APP_SLUG: '' }],
	])(
		'sync-pr без GH_TOKEN или STACK_APP_SLUG (%j) — код 2 до sync, порты не вызваны',
		async (env) => {
			const dir = repoDir({ '.stack.jsonc': NODE });
			const r = await runStack(['sync-pr'], dir, { env });
			expect(r).toMatchObject({
				code: 2,
				out: '',
				err: 'sync-pr needs GH_TOKEN and STACK_APP_SLUG in the environment\n',
			});
			expect(r.journal).toStrictEqual([]);
			expect(readdirSync(dir)).toStrictEqual(['.stack.jsonc']);
		},
	);

	test('sync-pr: --base и --no-install доходят до syncPr, VERSION хука — версия пакета', async () => {
		const { dir } = gitRepo({ '.stack.jsonc': NODE, 'package.json': NODE_PKG });
		const r = await runStack(['sync-pr', '--base', 'staging', '--no-install'], dir, {
			env: TOKEN_ENV,
		});
		expect(r.code, r.err).toBe(0);
		expect(r.journal).toContain(`github ${dir}`);
		expect(r.journal).toContain('proto install');
		expect(r.journal).toContain(`pnpm run stack:post-sync|VERSION=${ownVersion()}`);
		expect(
			r.journal.filter((l) => l.startsWith('pnpm install') || l.startsWith('served ')),
		).toStrictEqual([]);
		expect(r.github.created.map((pr) => pr.base)).toStrictEqual(['staging']);
		expect(r.out).toContain(`opened PR ${PR_URL}\n`);
	});

	test('sync-pr: порты реестра, peers и repo-rules доходят до syncPr', async () => {
		const { dir } = gitRepo({
			'.stack.jsonc': '{ "profile": "node", "with": ["peers", "repo-rules"] }',
			'package.json': NODE_PKG,
			'pnpm-lock.yaml': 'lockfileVersion: x\n',
			'.stack-peers-baseline.json': `${JSON.stringify({ version: 1, peers: [] }, null, '\t')}\n`,
		});
		const r = await runStack(['sync-pr'], dir, { env: TOKEN_ENV });
		expect(r.code, r.err).toBe(0);
		expect(r.journal.filter((l) => l.startsWith('served ')).length).toBeGreaterThan(0);
		expect(r.journal).toContain(`peers ${dir}`);
		expect(r.journal.some((l) => l.startsWith(`repo-rules -C ${dir} `))).toBe(true);
	});

	test('peers-baseline: --init и --allow-grow вместе — код 2 до чтения конфигурации', async () => {
		const r = await runStack(['peers-baseline', '--init', '--allow-grow'], repoDir(BARE));
		expect(r).toMatchObject({
			code: 2,
			out: '',
			err: '--init and --allow-grow do not go together\n',
		});
	});

	test('peers-baseline: режим из флагов, порт peers — из входа, out раньше err', async () => {
		const dir = repoDir({
			...BARE,
			'.stack.jsonc': '{ "profile": "node", "with": ["peers"] }',
			'pnpm-lock.yaml': UNMET_PEER_LOCK,
		});
		const r = await runStack(['peers-baseline', '--init'], dir);
		expect(r).toMatchObject({
			code: 0,
			out: 'wrote .stack-peers-baseline.json: 0 entr(ies)\n',
			err: '',
		});
		expect(r.journal).toStrictEqual([`peers ${dir}`]);
	});

	test.each(['sync', 'check', 'sync-pr', 'peers-baseline'])(
		'StackConfigError в %s — одна строка в err и код 2',
		async (command) => {
			const dir = repoDir({ ...BARE, '.stack.jsonc': '{ "profile": "node", "wiht": [] }' });
			const r = await runStack([command], dir, { env: TOKEN_ENV });
			expect(r).toMatchObject({ code: 2, out: '' });
			expect(r.err.trimEnd().split('\n')).toHaveLength(1);
			expect(r.err).toContain('unknown key "wiht"');
		},
	);

	test('StackConfigError в init (файл уже есть) — одна строка в err и код 2', async () => {
		const dir = repoDir({ ...BARE, '.stack.jsonc': NODE });
		const r = await runStack(['init', '--profile', 'node'], dir);
		expect(r).toMatchObject({ code: 2, out: '', err: '.stack.jsonc already exists\n' });
	});

	test('исключение порта выходит из runCommand как есть', async () => {
		const dir = repoDir({
			...BARE,
			'.stack.jsonc': '{ "profile": "node", "with": ["peers"] }',
			'pnpm-lock.yaml': UNMET_PEER_LOCK,
		});
		const boom = new Error('pnpm exploded');
		const peers = (): never => {
			throw boom;
		};
		await expect(runStack(['check'], dir, { ports: { peers } })).rejects.toBe(boom);
	});

	test('команда работает на каноне из контекста, а не читает свой', async () => {
		const dir = repoDir({ '.stack.jsonc': '{ "profile": "node" }' });
		const base = testSource();
		const source = testSource({
			entries: [
				...base.entries,
				{ src: 'files/x', dest: 'x.txt', appliesTo: ['node'], content: 'X\n' },
			],
		});
		const { ports } = fakeCommandPorts();
		expect(await COMMANDS.sync.run({ repoRoot: dir, flags: {}, env: {}, ports, source })).toBe(0);
		expect(readFileSync(join(dir, 'x.txt'), 'utf8')).toBe('X\n');
		expect(existsSync(join(dir, '.editorconfig'))).toBe(false); // файл настоящего канона не пришёл
	});
});
