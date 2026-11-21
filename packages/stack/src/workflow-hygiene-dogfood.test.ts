import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterAll, describe, expect, test } from 'bun:test';
import { parse as parseYaml } from 'yaml';

import { readCanonSource } from './canon.ts';
import { protoBin, ROOT, runTool } from './testkit.ts';
import { checkWorkflowHygiene, WORKFLOW_FILE } from './workflow-hygiene.ts';

// Правило гигиены (permissions, concurrency, timeout-minutes) видит один файл. Согласованность вызывающего
// и вызываемого reusable не видит ни оно, ни actionlint: право, которого вызывающий не даёт, делает workflow
// недействительным целиком («Error calling workflow … is requesting …»), а равные группы concurrency —
// тупик или отмену вызывающего. Эти проверки держит файл ниже (probe-4, §1, §2).

const WORKFLOWS = '.github/workflows/';

type Perms = string | Record<string, string> | null | undefined;
type Job = {
	uses?: string;
	permissions?: Perms;
	concurrency?: unknown;
	'timeout-minutes'?: unknown;
};
type Workflow = { permissions?: Perms; concurrency?: unknown; jobs?: Record<string, Job> };

const own = new Map(
	[...new Bun.Glob(`${WORKFLOWS}*.{yml,yaml}`).scanSync({ cwd: ROOT })]
		.toSorted()
		.map((p) => [p, readFileSync(join(ROOT, p), 'utf8')] as const),
);
const canonEntries = readCanonSource().entries.filter((e) => WORKFLOW_FILE.test(e.dest));
const ownWf = (name: string): Workflow =>
	parseYaml(own.get(`${WORKFLOWS}${name}`) ?? '') as Workflow;

// Уровни права: none < read < write; read-all и write-all раскрываются по списку прав GITHUB_TOKEN.
const LEVEL = { none: 0, read: 1, write: 2 } as const;
const SCOPES = [
	'actions',
	'attestations',
	'checks',
	'contents',
	'deployments',
	'discussions',
	'id-token',
	'issues',
	'models',
	'packages',
	'pages',
	'pull-requests',
	'security-events',
	'statuses',
];

function levels(p: Perms): Record<string, number> {
	if (p === 'read-all') return Object.fromEntries(SCOPES.map((s) => [s, LEVEL.read]));
	if (p === 'write-all') return Object.fromEntries(SCOPES.map((s) => [s, LEVEL.write]));
	if (p === null || p === undefined || typeof p === 'string') return {};
	return Object.fromEntries(
		Object.entries(p).map(([k, v]) => [k, LEVEL[v as keyof typeof LEVEL] ?? Number.NaN]),
	);
}

// Что вызываемый просит сверх потолка: по каждому праву запроса, у которого уровень выше.
function excess(ceiling: Perms, request: Perms): string[] {
	const have = levels(ceiling);
	return Object.entries(levels(request))
		.filter(([scope, lvl]) => !(lvl <= (have[scope] ?? LEVEL.none)))
		.map(([scope]) => scope);
}

const CALL = /^(?:alxwlw\/stack\/|\.\/)\.github\/workflows\/([\w.-]+\.yml)(?:@.+)?$/;

type Call = { from: string; job: string; callee: string; ceiling: Perms; callerGroups: string[] };

function groupOf(c: unknown): string[] {
	if (typeof c === 'string') return [c];
	if (typeof c === 'object' && c !== null && 'group' in c && typeof c.group === 'string')
		return [c.group];
	return [];
}

function callsOf(from: string, text: string): Call[] {
	const wf = parseYaml(text) as Workflow;
	return Object.entries(wf.jobs ?? {}).flatMap(([job, j]) => {
		const m = j.uses === undefined ? null : CALL.exec(j.uses);
		if (m?.[1] === undefined) return [];
		return [
			{
				from,
				job,
				callee: m[1],
				// Потолок вызываемого — permissions джоба с `uses:`, иначе верхние вызывающего.
				ceiling: j.permissions ?? wf.permissions,
				callerGroups: [...groupOf(wf.concurrency), ...groupOf(j.concurrency)],
			},
		];
	});
}

const calls = [
	...[...own].flatMap(([p, t]) => callsOf(p, t)),
	...canonEntries.flatMap((e) => callsOf(`canon:${e.src}`, e.content)),
];

// Запросы вызываемого: верхние permissions и permissions каждого джоба.
function requests(callee: string): Perms[] {
	const wf = ownWf(callee);
	return [wf.permissions, ...Object.values(wf.jobs ?? {}).map((j) => j.permissions)].filter(
		(p) => p !== undefined,
	);
}

function calleeGroups(callee: string): string[] {
	const wf = ownWf(callee);
	return [
		...groupOf(wf.concurrency),
		...Object.values(wf.jobs ?? {}).flatMap((j) => groupOf(j.concurrency)),
	];
}

test('workflow самого stack проходят гигиену', () => {
	expect(own.size).toBeGreaterThanOrEqual(7);
	expect(checkWorkflowHygiene(own)).toEqual([]);
});

describe('канонные workflow проходят гигиену', () => {
	test('их четыре', () => {
		expect(canonEntries.map((e) => e.src).toSorted()).toEqual([
			'files/workflow-renovate.yml',
			'files/workflow-stack-check-infra.yml',
			'files/workflow-stack-check.yml',
			'files/workflow-stack-sync.yml',
		]);
	});
	test.each(canonEntries.map((e) => [e.src, e] as const))('%s', (_src, e) => {
		expect(checkWorkflowHygiene(new Map([[e.dest, e.content]]))).toEqual([]);
	});
});

describe('права вызываемого reusable не шире прав вызывающего', () => {
	test('вызовов не меньше пяти: четыре канонных и renovate-self.yml', () => {
		expect(calls.length).toBeGreaterThanOrEqual(5);
		expect(
			calls.map((c) => `${c.from} → ${c.callee}`).filter((s) => s.includes('renovate-self.yml')),
		).toEqual(['.github/workflows/renovate-self.yml → renovate.yml']);
	});
	test.each(calls.map((c) => [`${c.from}#${c.job} → ${c.callee}`, c] as const))(
		'%s',
		(_name, call) => {
			// Без потолка (нет ни прав джоба, ни верхних) тест не проверяет ничего.
			expect(call.ceiling).not.toBeUndefined();
			for (const request of requests(call.callee)) {
				expect(excess(call.ceiling, request)).toEqual([]);
			}
		},
	);
});

describe('excess: уровни прав', () => {
	test('{} — none, read-all — read, write-all — write', () => {
		expect(excess({}, { contents: 'read' })).toEqual(['contents']);
		expect(excess('read-all', { contents: 'read' })).toEqual([]);
		expect(excess('read-all', { contents: 'write' })).toEqual(['contents']);
		expect(excess('write-all', { 'id-token': 'write', contents: 'read' })).toEqual([]);
		expect(excess('write-all', 'read-all')).toEqual([]);
		expect(excess({ contents: 'write' }, 'read-all')).toContain('actions');
		expect(excess({ contents: 'read' }, 'write-all')).toContain('contents');
		expect(excess({ contents: 'read' }, { contents: 'none' })).toEqual([]);
	});
});

test.each(['check.yml', 'sync.yml', 'renovate.yml'])(
	'права %s — в пределах ограниченной политики по умолчанию',
	(callee) => {
		// Копия канона без `permissions` у потребителя, пока sync-PR не смержен, а `v1` уже перенесён,
		// получает политику по умолчанию: contents: read и packages: read.
		const policy = { contents: 'read', packages: 'read' };
		const reqs = requests(callee);
		expect(reqs.length).toBeGreaterThan(0);
		for (const request of reqs) expect(excess(policy, request)).toEqual([]);
	},
);

test.each(calls.map((c) => [`${c.from}#${c.job} → ${c.callee}`, c] as const))(
	'группа concurrency вызывающего не совпадает с группами вызываемого: %s',
	(_name, call) => {
		const callee = calleeGroups(call.callee).map((g) => g.toLowerCase());
		expect(call.callerGroups.length).toBeGreaterThan(0);
		for (const g of call.callerGroups) expect(callee).not.toContain(g.toLowerCase());
	},
);

describe('stack-check и ci.yml: PR отменяет, push — нет', () => {
	const EXPECTED = {
		group:
			"${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.ref || github.run_id }}",
		'cancel-in-progress': "${{ github.event_name == 'pull_request' }}",
	};
	test.each(
		canonEntries
			.filter((e) => e.dest === `${WORKFLOWS}stack-check.yml`)
			.map((e) => [e.src, e.content] as const),
	)('%s', (_src, content) => {
		expect((parseYaml(content) as Workflow).concurrency).toStrictEqual(EXPECTED);
	});
	test('ci.yml', () => {
		expect(ownWf('ci.yml').concurrency).toStrictEqual(EXPECTED);
	});
});

describe('у джоба с uses: нет timeout-minutes', () => {
	const files = [...own, ...canonEntries.map((e) => [`canon:${e.src}`, e.content] as const)];
	test('есть что проверять', () => {
		const usesJobs = files.flatMap(([, text]) =>
			Object.values((parseYaml(text) as Workflow).jobs ?? {}).filter((j) => j.uses !== undefined),
		);
		expect(usesJobs.length).toBeGreaterThanOrEqual(5);
	});
	test.each(files.map(([p, t]) => [p, t] as const))('%s', (_p, text) => {
		for (const j of Object.values((parseYaml(text) as Workflow).jobs ?? {})) {
			if (j.uses !== undefined) expect(j['timeout-minutes']).toBeUndefined();
		}
	});
});

describe('actionlint принимает канонные workflow', () => {
	const dirs: string[] = [];
	afterAll(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
	});
	test('каждый файл под своим dest, второй stack-check — под другим именем', () => {
		const dir = mkdtempSync(join(tmpdir(), 'stack-dogfood-'));
		dirs.push(dir);
		mkdirSync(join(dir, WORKFLOWS), { recursive: true });
		const names = canonEntries.map((e) =>
			e.src === 'files/workflow-stack-check-infra.yml' ? 'stack-check-infra.yml' : basename(e.dest),
		);
		expect(new Set(names).size).toBe(canonEntries.length);
		for (const [i, e] of canonEntries.entries()) {
			writeFileSync(join(dir, WORKFLOWS, names[i] ?? ''), e.content);
		}
		const files = names.map((n) => `${WORKFLOWS}${n}`);
		const r = runTool(protoBin('actionlint'), ['-no-color', ...files], dir);
		expect({ status: r.status, stdout: r.stdout }, r.ctx).toEqual({ status: 0, stdout: '' });
	}, 30_000);
});
