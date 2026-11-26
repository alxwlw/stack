import * as fs from 'node:fs';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { expect, spyOn, test } from 'bun:test';

import type { Canon } from './canon.ts';
import { check, checkRepo, syncOutput, syncRepo } from './check.ts';
import { STACK_RENOVATE_PRESET } from './deps.ts';
import { allowedLine, type Held } from './exceptions.ts';
import type { Drift, Finding, FindingCode } from './findings.ts';
import type { PeersReader, PeersRun } from './peers.ts';
import type { RepoRulesReader, RepoRulesRun } from './repo-rules.ts';
import { repoDir, testCanon, testRepo } from './testkit.ts';

// Конфиг Renovate на пресете канона: тесты исключений и каталогов не про бота.
const RENOVATE = { 'renovate.json5': `{ extends: ['${STACK_RENOVATE_PRESET}'] }\n` };

const realWrite = fs.writeFileSync;

const canon = testCanon({
	files: [{ dest: '.editorconfig', content: 'root = true\n' }],
	catalogs: { dev: { oxlint: '1.83.0' } },
});

test('стенд: согласованный с каноном репозиторий — без находок', () => {
	const canon = testCanon({
		files: [{ dest: '.editorconfig', content: 'root = true\n' }],
		catalogs: { dev: { oxlint: '1.83.0' }, libs: { react: '19.2.7' } },
	});
	expect(check(testRepo(canon), canon, [])).toEqual([]);
});

// Канон сам кладёт конфиг Renovate: стенд не добавляет второй, и содержимое — из канона.
test('стенд: конфиг Renovate из канона вытесняет свой, в репозитории ровно одна версия файла', () => {
	const seeded = testCanon({
		files: [
			{
				dest: 'renovate.json5',
				content: `{ extends: ['${STACK_RENOVATE_PRESET}', 'из канона'] }\n`,
				strategy: 'create-if-absent',
			},
		],
	});
	const repo = testRepo(seeded);
	expect(repo.renovate?.config).toEqual({ extends: [STACK_RENOVATE_PRESET, 'из канона'] });
	expect(check(repo, seeded, [])).toEqual([]);
});

test('стенд: null в правках удаляет файл — правило, которому он нужен, подаёт голос', () => {
	expect(check(testRepo(canon, { 'renovate.json5': null }), canon, []).map((f) => f.code)).toEqual([
		'renovate-preset',
	]);
	expect(check(testRepo(canon, { '.editorconfig': null }), canon, []).map((f) => f.code)).toEqual([
		'file-missing',
	]);
});

test('исключение на .prototools держит и packageManager — в sync и в check', () => {
	const repo = repoDir({
		...RENOVATE,
		'.prototools': 'pnpm = "11.1.2"\n',
		'package.json': '{ "name": "r", "packageManager": "pnpm@11.1.2" }',
	});
	const withPrototools: Canon = {
		...canon,
		files: [{ dest: '.prototools', content: 'pnpm = "10.99.0"\n' }],
	};
	const exceptions = [{ file: '.prototools', reason: 'новый пин ещё не проверен' }];

	const { applied, held } = syncRepo(repo, withPrototools, exceptions);
	expect(applied).toEqual([]);
	expect(held.map((f) => f.code).sort()).toEqual(['file-drift', 'package-manager']);
	expect(readFileSync(join(repo, 'package.json'), 'utf8')).toContain('pnpm@11.1.2');

	const { findings } = checkRepo(repo, withPrototools, exceptions);
	expect(findings.filter((f) => !f.suppressedBy)).toEqual([]);
	expect(findings.map((f) => f.code).sort()).toEqual(['file-drift', 'package-manager']);
});

test('исключение, которое ни к чему не подошло, — единственная находка: stale-exception', () => {
	const empty = testCanon();
	const codes = check(testRepo(empty), empty, [{ file: '.нет-такого', reason: 'протухло' }]).map(
		(f) => f.code,
	);
	expect(codes).toEqual(['stale-exception']);
});

test('исключение, подошедшее к находке, не мешает другому остаться протухшим', () => {
	const findings = check(testRepo(canon, { '.editorconfig': null }), canon, [
		{ file: '.editorconfig', reason: 'легитимный отступ' },
		{ file: '.нет-такого', reason: 'протухло' },
	]);
	const editorconfig = findings.find((f) => f.target === '.editorconfig');
	expect(editorconfig?.code).toBe('file-missing');
	expect(editorconfig?.suppressedBy?.reason).toBe('легитимный отступ');
	const stale = findings.filter((f) => f.code === 'stale-exception');
	expect(stale).toHaveLength(1);
	expect(stale[0]?.target).toBe('.нет-такого');
});

const OVERRIDES = `overrides:
  "pkg>dep": "git+https://github.com/example/some-long-fork-name.git#${'a'.repeat(40)}"
  # длинный plain-скаляр
  plain: some very long plain scalar value that goes well past the eighty column limit of yaml
`;
const WS_BEFORE = `packages:
  - packages/*

catalogs:
  # из канона
  dev:
    oxlint: 1.70.0

${OVERRIDES}`;

test('check агрегирует находки из разных источников: файл и каталог одновременно', () => {
	const codes = check(
		testRepo(canon, { '.editorconfig': 'сломали\n', 'pnpm-workspace.yaml': WS_BEFORE }),
		canon,
		[],
	).map((f) => f.code);
	expect(codes).toContain('file-drift');
	expect(codes).toContain('catalog-drift');
});

// Порядок находок — часть вывода CLI: план (файлы, каталоги, packageManager), нечитаемые файлы,
// inline-version, engines-node, renovate-preset, dependabot-config; протухшие исключения — в конце.
test('check: порядок находок — план, unreadable-file, правила deps.ts, stale-exception', () => {
	const findings = check(
		testRepo(canon, {
			'.editorconfig': null,
			'package.json': '{ "packageManager": "pnpm@1.0.0", "engines": { "node": "^24" } }',
			'packages/a/package.json': '{ "devDependencies": { "oxlint": "1.70.0" } }',
			'packages/b/package.json': '{',
			'renovate.json5': null,
			'.github/dependabot.yml': 'version: 2\n',
		}),
		canon,
		[{ file: '.нет-такого', reason: 'протухло' }],
	);
	expect(findings.map((f) => f.code)).toEqual([
		'file-missing',
		'package-manager',
		'unreadable-file',
		'inline-version',
		'engines-node',
		'renovate-preset',
		'dependabot-config',
		'stale-exception',
	]);
});

test('sync не трогает файл, удержанный исключением, и check после него без stale-exception', () => {
	const repo = repoDir({ ...RENOVATE, '.editorconfig': 'свой отступ\n' });
	const exceptions = [{ file: '.editorconfig', reason: 'легитимный отступ' }];
	const { applied, held } = syncRepo(repo, canon, exceptions);
	expect(applied).toEqual([]);
	expect(held.map((f) => [f.code, f.suppressedBy?.reason])).toEqual([
		['file-drift', 'легитимный отступ'],
	]);
	expect(readFileSync(join(repo, '.editorconfig'), 'utf8')).toBe('свой отступ\n');
	expect(checkRepo(repo, canon, exceptions).findings.filter((f) => !f.suppressedBy)).toEqual([]);
});

test('sync оставляет запись каталога, удержанную catalog+name, и применяет остальное', () => {
	const repo = repoDir({ ...RENOVATE, 'pnpm-workspace.yaml': WS_BEFORE });
	// Вторая запись dev-каталога: соседняя запись в том же файле не должна затереть удержанную
	// (применитель пишет pnpm-workspace.yaml целиком, один раз).
	const twoEntries: Canon = {
		...canon,
		catalogs: { dev: { oxlint: '1.83.0', typescript: '7.0.2' } },
	};
	const exceptions = [{ catalog: 'dev', name: 'oxlint', reason: 'ждём апстрим-фикс' }];
	const { applied, held } = syncRepo(repo, twoEntries, exceptions);
	expect(applied.map((d) => d.target).sort()).toEqual(['.editorconfig', 'catalogs.dev.typescript']);
	expect(held.map((f) => f.target)).toEqual(['catalogs.dev.oxlint']);
	expect(readFileSync(join(repo, '.editorconfig'), 'utf8')).toBe('root = true\n');
	const workspace = readFileSync(join(repo, 'pnpm-workspace.yaml'), 'utf8');
	expect(workspace).toContain('oxlint: 1.70.0');
	expect(workspace).toContain('typescript: 7.0.2');
	expect(workspace).toContain('  # из канона\n  dev:');
	expect(workspace.slice(workspace.indexOf('overrides:'))).toBe(OVERRIDES);
	expect(checkRepo(repo, twoEntries, exceptions).findings.filter((f) => !f.suppressedBy)).toEqual(
		[],
	);
});

test('sync без исключений применяет весь план — как раньше', () => {
	const repo = repoDir({ '.editorconfig': 'сломали\n' });
	const { applied, held } = syncRepo(repo, canon, []);
	expect(applied.map((d) => d.code)).toEqual(['file-drift']);
	expect(held).toEqual([]);
	expect(readFileSync(join(repo, '.editorconfig'), 'utf8')).toBe('root = true\n');
});

test('check: renovate-preset проверяется у каждого репо — без групп и без pnpm-workspace', () => {
	const bare = testCanon();
	const codes = check(
		testRepo(bare, { 'renovate.json5': null, 'pnpm-workspace.yaml': null }),
		bare,
		[],
	).map((f) => f.code);
	expect(codes).toContain('renovate-preset');
});

test('renovate-preset и dependabot-config не подавляются исключением — исключения выходят stale-exception', () => {
	const bare = testCanon();
	const findings = check(
		testRepo(bare, {
			'renovate.json5': null,
			'.github/dependabot.yml':
				'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n',
		}),
		bare,
		[
			{ file: 'renovate.json5', reason: 'r' },
			{ file: '.github/dependabot.yml', reason: 'r' },
		],
	);
	for (const code of ['renovate-preset', 'dependabot-config'] as const) {
		const f = findings.find((x) => x.code === code);
		expect(f).toBeDefined();
		expect(f?.suppressedBy).toBeUndefined();
	}
	expect(findings.filter((f) => f.code === 'stale-exception')).toHaveLength(2);
});

test('сломанный корневой package.json — одна находка unreadable-file, с pnpm-workspace.yaml и без', () => {
	const bare = testCanon();
	for (const withWorkspace of [true, false]) {
		const unreadable = check(
			testRepo(bare, {
				'package.json': '{ "name": "r", ',
				'pnpm-workspace.yaml': withWorkspace ? 'packages:\n  - packages/*\n' : null,
			}),
			bare,
			[],
		).filter((f) => f.code === 'unreadable-file');
		expect(
			unreadable.map((f) => f.target),
			`workspace: ${withWorkspace}`,
		).toEqual(['package.json']);
	}
});

// DX-17: sync пишет каждый файл один раз, сколько бы находок в нём ни было.
test('syncRepo: два дрейфа каталога, packageManager и файл — по одной записи на путь', () => {
	const repo = repoDir({
		...RENOVATE,
		'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
		'package.json': '{ "packageManager": "pnpm@1.0.0" }\n',
	});
	const twoEntries: Canon = {
		...canon,
		catalogs: { dev: { oxlint: '1.83.0', typescript: '7.0.2' } },
	};
	const writes: string[] = [];
	const spy = spyOn(fs, 'writeFileSync').mockImplementation(((path: string, data: string) => {
		writes.push(relative(repo, path));
		return realWrite(path, data);
	}) as typeof fs.writeFileSync);
	try {
		expect(syncRepo(repo, twoEntries, []).applied).toHaveLength(4);
	} finally {
		spy.mockRestore();
	}
	expect(writes.toSorted()).toEqual(['.editorconfig', 'package.json', 'pnpm-workspace.yaml']);
});

// Ответ `pnpm peers check --lockfile-only --json` с одной записью bad, в форме настоящего pnpm.
const ONE_BAD = JSON.stringify({
	'.': {
		bad: {
			peer: [
				{
					parents: [{ name: 'decl', version: '1.0.0' }],
					optional: false,
					wantedRange: '^2.0.0',
					foundVersion: '1.0.0',
					resolvedFrom: [],
				},
			],
		},
		missing: {},
		conflicts: [],
		intersections: {},
	},
});

// Порт, который записывает каталог каждого вызова и отдаёт заданный запуск pnpm.
function fakePeers(run: PeersRun): { read: PeersReader; calls: string[] } {
	const calls: string[] = [];
	return {
		read: (root) => {
			calls.push(root);
			return run;
		},
		calls,
	};
}

const throwingPeers: PeersReader = () => {
	throw new Error('порт pnpm не должен вызываться');
};

const LOCK = { 'pnpm-lock.yaml': 'lockfileVersion: x\n' };
const peersCanon: Canon = { ...canon, rules: ['peers'] };

test('группа peers выключена — порт не зовётся', () => {
	const repo = repoDir({ ...RENOVATE, ...LOCK, '.editorconfig': 'root = true\n' });
	expect(checkRepo(repo, canon, [], { ports: { peers: throwingPeers }, env: {} })).toStrictEqual({
		findings: [],
		notes: [],
	});
});

test('группа peers включена без pnpm-lock.yaml — порт не зовётся, peers-unavailable', () => {
	const repo = repoDir({ ...RENOVATE, '.editorconfig': 'root = true\n' });
	expect(
		checkRepo(repo, peersCanon, [], { ports: { peers: throwingPeers }, env: {} }).findings,
	).toStrictEqual([
		{ code: 'peers-unavailable', target: 'pnpm peers check', message: 'no pnpm-lock.yaml' },
	]);
});

test('группа peers включена, лок есть, порта нет — Error', () => {
	const repo = repoDir({ ...RENOVATE, ...LOCK, '.editorconfig': 'root = true\n' });
	expect(() => checkRepo(repo, peersCanon, [])).toThrow(
		new Error('checkRepo: peers group needs a PeersReader'),
	);
});

test('группа peers включена — находки peers последние и исключением не гасятся', () => {
	// Находки плана, deps.ts и moon (последнее правило перед peers — checkMoonDefaultBranch).
	const repo = repoDir({
		...RENOVATE,
		...LOCK,
		'.github/dependabot.yml': 'version: 2\n',
		'.moon/workspace.yml': 'vcs: git\n',
	});
	const port = fakePeers({ status: 1, signal: null, stdout: ONE_BAD, stderr: '' });
	const { findings } = checkRepo(
		repo,
		peersCanon,
		[{ file: '.stack-peers-baseline.json', reason: 'x' }],
		{ ports: { peers: port.read }, env: {} },
	);
	expect(port.calls).toStrictEqual([repo]);
	expect(findings.map((f) => f.code)).toStrictEqual([
		'file-missing',
		'dependabot-config',
		'moon-default-branch',
		'peer-dependency',
		'stale-exception',
	]);
	expect(findings[3]).toStrictEqual({
		code: 'peer-dependency',
		target: 'peer in .',
		message: 'decl@1.0.0 wants ^2.0.0, found 1.0.0; not in .stack-peers-baseline.json',
	});
	expect(findings[4]).toMatchObject({
		code: 'stale-exception',
		target: '.stack-peers-baseline.json',
	});
});

test('stale-peer-baseline и peers-unavailable тоже не гасятся исключением на baseline', () => {
	const stale = JSON.stringify({
		version: 1,
		peers: [{ importer: '.', peer: 'zod', kind: 'conflict' }],
	});
	const cases: [Record<string, string>, string, FindingCode][] = [
		[{ '.stack-peers-baseline.json': stale }, '{}', 'stale-peer-baseline'],
		[{}, 'Usage: pnpm [command]', 'peers-unavailable'],
	];
	for (const [files, stdout, code] of cases) {
		const repo = repoDir({ ...RENOVATE, ...LOCK, '.editorconfig': 'root = true\n', ...files });
		const { findings } = checkRepo(
			repo,
			peersCanon,
			[{ file: '.stack-peers-baseline.json', reason: 'x' }],
			{
				ports: { peers: fakePeers({ status: 0, signal: null, stdout, stderr: '' }).read },
				env: {},
			},
		);
		expect(
			findings.map((f) => [f.code, f.suppressedBy]),
			code,
		).toStrictEqual([
			[code, undefined],
			['stale-exception', undefined],
		]);
	}
});

const rulesCanon: Canon = { ...canon, rules: ['repo-rules'] };
const CLEAN_REPO = { ...RENOVATE, '.editorconfig': 'root = true\n' };
const rr = (code: number, o: unknown): RepoRulesRun => ({ code, out: JSON.stringify(o), err: '' });
const RR_EMPTY = rr(0, { violations: [], stale: [], notes: [] });
const RR_LONG = rr(1, {
	violations: [{ rule: 'max-lines', path: 'src/a.ts', line: 801, message: '812 lines' }],
	stale: [],
	notes: [],
});
const RR_REMOVED = rr(1, {
	violations: [
		{ rule: 'removed-assertions', path: 'a.test.ts', line: 0, message: '−1 / +0 assertions' },
	],
	stale: [],
	notes: [],
});
const LONG: Finding = {
	code: 'repo-rules-violation',
	target: 'src/a.ts:801',
	message: 'max-lines: 812 lines',
};
const REMOVED: Finding = {
	code: 'repo-rules-violation',
	target: 'a.test.ts',
	message: 'removed-assertions: −1 / +0 assertions',
};
const SKIP_NOTE = 'repo-rules diff: skipped (no --base outside GitHub Actions)';
const HINT =
	'repo-rules diff: intended? add a commit trailer "Tests-Removed: <reason>" in the range';

// Порт repo-rules: записывает argv каждого вызова и отвечает по очереди.
function fakeRules(...runs: RepoRulesRun[]) {
	const calls: string[][] = [];
	const envs: NodeJS.ProcessEnv[] = [];
	const read: RepoRulesReader = (argv, env) => {
		calls.push(argv);
		envs.push(env);
		const run = runs[calls.length - 1];
		if (!run) throw new Error('лишний вызов порта repo-rules');
		return run;
	};
	return { read, calls, envs };
}

const throwingRules: RepoRulesReader = () => {
	throw new Error('порт repo-rules не должен вызываться');
};
const LOCAL = { GITHUB_ACTIONS: '' };
const PR_JOB = {
	GITHUB_ACTIONS: 'true',
	GITHUB_EVENT_NAME: 'pull_request',
	GITHUB_BASE_REF: 'main',
};

test('группа repo-rules выключена — порт не зовётся, пометок нет', () => {
	const repo = repoDir(CLEAN_REPO);
	expect(
		checkRepo(repo, canon, [], { ports: { 'repo-rules': throwingRules }, env: PR_JOB }),
	).toStrictEqual({
		findings: [],
		notes: [],
	});
});

test('группа repo-rules включена, порта нет — Error', () => {
	expect(() => checkRepo(repoDir(CLEAN_REPO), rulesCanon, [])).toThrow(
		new Error('checkRepo: repo-rules group needs a RepoRulesReader'),
	);
});

test('repo-rules вне GitHub Actions без --base: находки check, diff пропущен с пометкой', () => {
	const repo = repoDir(CLEAN_REPO);
	const f = fakeRules(RR_LONG);
	expect(
		checkRepo(repo, rulesCanon, [], { ports: { 'repo-rules': f.read }, env: LOCAL }),
	).toStrictEqual({
		findings: [LONG],
		notes: [SKIP_NOTE],
	});
	expect(f.calls).toStrictEqual([['-C', repo, 'check', '--json']]);
});

test('repo-rules: --base доходит до diff, нарушение diff — находка и подсказка пометкой', () => {
	const repo = repoDir(CLEAN_REPO);
	const f = fakeRules(RR_EMPTY, RR_REMOVED);
	expect(
		checkRepo(repo, rulesCanon, [], {
			ports: { 'repo-rules': f.read },
			env: LOCAL,
			base: 'origin/main',
		}),
	).toStrictEqual({
		findings: [REMOVED],
		notes: [HINT],
	});
	expect(f.calls[1]).toStrictEqual(['-C', repo, 'diff', '--json', '--base', 'origin/main']);
	expect(f.envs).toStrictEqual([LOCAL, LOCAL]);
	expect(f.envs.every((e) => e === LOCAL)).toBe(true);
});

test('repo-rules: сбой вызова — repo-rules-unavailable, а не пустой список', () => {
	const f = fakeRules({
		code: 2,
		out: '',
		err: 'repo-rules: baseline: not JSON (x)',
	});
	expect(
		checkRepo(repoDir(CLEAN_REPO), rulesCanon, [], {
			ports: { 'repo-rules': f.read },
			env: LOCAL,
		}).findings,
	).toStrictEqual([
		{
			code: 'repo-rules-unavailable',
			target: 'repo-rules check',
			message: 'baseline: not JSON (x)',
		},
	]);
});

test('repo-rules: исключение на файл нарушения не удерживает находку и становится stale-exception', () => {
	const f = fakeRules(RR_LONG, RR_REMOVED);
	const exceptions = [
		{ file: 'src/a.ts', reason: 'legacy' },
		{ file: 'a.test.ts', reason: 'moved' },
	];
	const { findings } = checkRepo(repoDir(CLEAN_REPO), rulesCanon, exceptions, {
		ports: { 'repo-rules': f.read },
		env: PR_JOB,
	});
	expect(findings).toStrictEqual([
		LONG,
		REMOVED,
		{
			code: 'stale-exception',
			target: 'src/a.ts',
			message: 'exception no longer covers anything: legacy',
		},
		{
			code: 'stale-exception',
			target: 'a.test.ts',
			message: 'exception no longer covers anything: moved',
		},
	]);
});

test('обе группы: находки repo-rules идут после находок peers', () => {
	const repo = repoDir({ ...CLEAN_REPO, ...LOCK });
	const peers = fakePeers({ status: 1, signal: null, stdout: ONE_BAD, stderr: '' });
	const f = fakeRules(RR_LONG);
	const both: Canon = { ...canon, rules: ['peers', 'repo-rules'] };
	const { findings } = checkRepo(repo, both, [], {
		ports: { peers: peers.read, 'repo-rules': f.read },
		env: LOCAL,
	});
	expect(findings.map((x) => x.code)).toStrictEqual(['peer-dependency', 'repo-rules-violation']);
});

test('check: группа repo-rules включена, исхода нет — Error', () => {
	expect(() => check(testRepo(rulesCanon), rulesCanon, [])).toThrow(
		new Error('checkRepoRules: no repo-rules outcome'),
	);
});

test('syncOutput: удержанные — в stderr, правки и итог — в stdout', () => {
	const drift: Drift = {
		code: 'file-drift',
		file: 'a.txt',
		target: 'a.txt',
		message: 'm',
		fix: 'fixed a.txt',
		change: { file: 'a.txt', kind: 'write', content: 'x' },
	};
	const held: Held<Drift> = {
		...drift,
		file: 'b.txt',
		target: 'b.txt',
		suppressedBy: { file: 'b.txt', reason: 'нужен свой' },
	};
	expect(syncOutput({ applied: [drift], held: [held] })).toEqual({
		stderr: [allowedLine(held)],
		stdout: ['fixed a.txt', 'canon applied'],
	});
	expect(syncOutput({ applied: [], held: [] })).toEqual({
		stderr: [],
		stdout: ['canon already up to date'],
	});
});
