import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';
import { parse as parseYaml } from 'yaml';

import { DISPATCH_WORKFLOW, dispatchRequest } from '../../../scripts/rollout.ts';
import { readCanonSource } from './canon.ts';
import { PROFILES } from './config.ts';
import { canonFile } from './testkit.ts';

// Вызов reusable workflow стека должен укладываться в on.workflow_call цели: иначе у потребителя
// workflow падает при запуске. Таблицу вызовов строит обход файлов (корень + канон-файлы), а не список
// в тесте: новый `uses:` попадает под проверку сам. Таблица держит и вызовы своего action из шагов:
// actionlint сверяет входы локального `./.github/actions/…`, но молчит на `alxwlw/stack/.github/actions/…@v1`,
// а именно такой вызов исполняет потребитель.
const ROOT = join(import.meta.dir, '..', '..', '..');
const WORKFLOWS = '.github/workflows/';
const ACTIONS = '.github/actions/';

type Call = {
	/** Корневой файл — путь от корня репо; канон-файл — `canon:<src из манифеста>` (dest у двух stack-check общий). */
	from: string;
	job: string;
	/** Индекс шага в `jobs.<job>.steps`; `null` у вызова reusable workflow. */
	step: number | null;
	/** Путь от корня репо к файлу контракта: `.github/workflows/<файл>.yml` или `.github/actions/<имя>/action.yml`. */
	target: string;
	/** `v1` у вызова по имени репо стека; `null` у локального `./`. */
	ref: string | null;
	with: string[];
	secrets: string[] | 'inherit';
	/** `jobs.<job>.env` job, в котором стоит вызов, или `{}`. */
	env: Record<string, unknown>;
};

type Contract = {
	inputs: Record<string, { required?: boolean; default?: unknown }>;
	secrets: Record<string, { required?: boolean }>;
};

type ActionManifest = { inputs?: Contract['inputs'] };

type Workflow = {
	on?: string | string[] | { workflow_call?: Partial<Contract> | null } | null;
	jobs?: Record<
		string,
		{
			uses?: string;
			with?: Record<string, unknown>;
			env?: Record<string, unknown>;
			secrets?: Record<string, unknown> | string;
			steps?: { uses?: string; with?: Record<string, unknown> }[];
		}
	>;
};

const USES = /^(?:alxwlw\/stack\/|\.\/)\.github\/workflows\/([\w.-]+\.yml)(?:@(.+))?$/;
const ACTION_USES = /^(?:alxwlw\/stack\/|\.\/)\.github\/actions\/([\w.-]+)(?:@(.+))?$/;

function callsOf(from: string, text: string): Call[] {
	const wf = parseYaml(text) as Workflow;
	return Object.entries(wf.jobs ?? {}).flatMap(([job, j]) => {
		const calls: Call[] = [];
		const m = j.uses == null ? null : USES.exec(j.uses);
		if (m?.[1] != null) {
			calls.push({
				from,
				job,
				step: null,
				target: `${WORKFLOWS}${m[1]}`,
				ref: m[2] ?? null,
				with: Object.keys(j.with ?? {}),
				secrets: typeof j.secrets === 'string' ? 'inherit' : Object.keys(j.secrets ?? {}),
				env: j.env ?? {},
			});
		}
		for (const [step, s] of (j.steps ?? []).entries()) {
			const am = s.uses == null ? null : ACTION_USES.exec(s.uses);
			if (am?.[1] == null) continue;
			calls.push({
				from,
				job,
				step,
				target: `${ACTIONS}${am[1]}/action.yml`,
				ref: am[2] ?? null,
				with: Object.keys(s.with ?? {}),
				secrets: [],
				env: j.env ?? {},
			});
		}
		return calls;
	});
}

// Файл reusable, если ключ workflow_call есть в любой из форм `on`: пустой `workflow_call:` (null), `{}`,
// строка `on: workflow_call`, список `on: [workflow_call]`. Проверка значения на null их теряет.
function declaresWorkflowCall(on: Workflow['on']): boolean {
	if (typeof on === 'string') return on === 'workflow_call';
	if (Array.isArray(on)) return on.includes('workflow_call');
	return on != null && Object.hasOwn(on, 'workflow_call');
}

function workflowCallOf(on: Workflow['on']): Partial<Contract> | null {
	return on != null && typeof on === 'object' && !Array.isArray(on)
		? (on.workflow_call ?? null)
		: null;
}

function contractOf(target: string): Contract {
	const text = readFileSync(join(ROOT, target), 'utf8');
	if (target.endsWith('/action.yml')) {
		return { inputs: (parseYaml(text) as ActionManifest).inputs ?? {}, secrets: {} };
	}
	const on = (parseYaml(text) as Workflow).on;
	// Цель без workflow_call нельзя звать вовсе: падаем, а не считаем контракт пустым.
	if (!declaresWorkflowCall(on)) throw new Error(`${target}: нет on.workflow_call`);
	const wc = workflowCallOf(on);
	return { inputs: wc?.inputs ?? {}, secrets: wc?.secrets ?? {} };
}

function callProblems(call: Call, contract: Contract): string[] {
	const problems: string[] = [];
	for (const k of call.with) {
		if (!(k in contract.inputs)) problems.push(`with.${k}: у ${call.target} нет такого input`);
	}
	for (const [k, spec] of Object.entries(contract.inputs)) {
		// Обязательный input с default GitHub подставит сам.
		if (spec.required === true && spec.default === undefined && !call.with.includes(k)) {
			problems.push(`with.${k}: обязательный input не передан`);
		}
	}
	// `secrets: inherit` отдаёт все секреты вызывающего — сверять нечего.
	if (call.secrets !== 'inherit') {
		for (const k of call.secrets) {
			if (!(k in contract.secrets))
				problems.push(`secrets.${k}: у ${call.target} нет такого секрета`);
		}
		for (const [k, spec] of Object.entries(contract.secrets)) {
			if (spec.required === true && !call.secrets.includes(k)) {
				problems.push(`secrets.${k}: обязательный секрет не передан`);
			}
		}
	}
	return problems;
}

const rootFiles = [...new Bun.Glob(`${WORKFLOWS}*.yml`).scanSync({ cwd: ROOT })].toSorted();
const rootCalls = rootFiles.flatMap((f) => callsOf(f, readFileSync(join(ROOT, f), 'utf8')));
const canonEntries = readCanonSource().entries.filter((e) => e.dest.startsWith(WORKFLOWS));
const canonCalls = canonEntries.flatMap((e) => callsOf(`canon:${e.src}`, e.content));
const calls = [...rootCalls, ...canonCalls];

test('обход находит вызовы reusable workflow и своего action', () => {
	expect(calls.length).toBeGreaterThanOrEqual(5);
	const pairs = calls.map((c) => [c.from, c.target]);
	for (const pair of [
		['canon:files/workflow-renovate.yml', '.github/workflows/renovate.yml'],
		['canon:files/workflow-stack-sync.yml', '.github/workflows/sync.yml'],
		['canon:files/workflow-stack-check.yml', '.github/workflows/check.yml'],
		['canon:files/workflow-stack-check-infra.yml', '.github/workflows/check.yml'],
		['.github/workflows/renovate-self.yml', '.github/workflows/renovate.yml'],
		['.github/workflows/check.yml', '.github/actions/setup/action.yml'],
		['.github/workflows/sync.yml', '.github/actions/setup/action.yml'],
		['.github/workflows/ci.yml', '.github/actions/setup/action.yml'],
		['.github/workflows/publish.yml', '.github/actions/setup/action.yml'],
		['.github/workflows/rollout.yml', '.github/actions/setup/action.yml'],
	]) {
		expect(pairs).toContainEqual(pair);
	}
	// Пол: вызовы setup, что уже стояли в корне (check 1, ci 6, publish 2, rollout 1, sync 1); новые его только поднимают.
	expect(calls.filter((c) => c.step !== null).length).toBeGreaterThanOrEqual(11);
});

describe('вызовы в рамках контракта цели', () => {
	test.each(
		calls.map(
			(c) =>
				[`${c.from}#${c.job}${c.step === null ? '' : `[${c.step}]`} → ${c.target}`, c] as const,
		),
	)('%s', (_name, call) => {
		expect(callProblems(call, contractOf(call.target))).toEqual([]);
	});
});

test('канон-файлы зовут reusable workflow стека на @v1', () => {
	expect(canonCalls.length).toBeGreaterThan(0);
	for (const c of canonCalls)
		expect({ from: c.from, ref: c.ref }).toEqual({ from: c.from, ref: 'v1' });
});

test('reusable workflow стека зовёт свой action по alxwlw/stack/…@v1: ./ у потребителя — его репозиторий', () => {
	const reusable = rootFiles.filter((f) =>
		declaresWorkflowCall((parseYaml(readFileSync(join(ROOT, f), 'utf8')) as Workflow).on),
	);
	expect(reusable.length).toBeGreaterThan(0);
	const stepCalls = rootCalls.filter((c) => c.step !== null && reusable.includes(c.from));
	expect(stepCalls.length).toBeGreaterThan(0);
	for (const c of stepCalls)
		expect({ from: c.from, ref: c.ref }).toEqual({ from: c.from, ref: 'v1' });
});

test('проводка канон-файлов: токен Renovate и базовая ветка sync', () => {
	const job = (src: string, name: string) =>
		(parseYaml(canonEntries.find((e) => e.src === src)?.content ?? '') as Workflow).jobs?.[name];
	expect(job('files/workflow-renovate.yml', 'renovate')?.secrets).toEqual({
		token: '${{ secrets.RENOVATE_TOKEN }}',
		'registry-token': '${{ secrets.STACK_REGISTRY_TOKEN }}',
	});
	for (const [src, name] of [
		['files/workflow-stack-check.yml', 'check'],
		['files/workflow-stack-sync.yml', 'sync'],
		['files/workflow-renovate.yml', 'renovate'],
	] as const) {
		expect(job(src, name)?.with?.registry).toBe("${{ vars.STACK_REGISTRY || '' }}");
	}
	for (const [src, name] of [
		['files/workflow-stack-check.yml', 'check'],
		['files/workflow-stack-sync.yml', 'sync'],
	] as const) {
		expect(job(src, name)?.secrets).toMatchObject({
			'registry-token': '${{ secrets.STACK_REGISTRY_TOKEN }}',
		});
	}
	expect(job('files/workflow-stack-sync.yml', 'sync')?.with?.base).toBe(
		"${{ vars.STACK_SYNC_BASE || '' }}",
	);
	expect(Object.keys(job('files/workflow-stack-sync.yml', 'sync')?.with ?? {}).toSorted()).toEqual([
		'base',
		'registry',
		'version',
	]);
});

test('свой setup с registry без registry-token-var: job несёт переменную умолчания action', () => {
	const action = parseYaml(readFileSync(join(ROOT, `${ACTIONS}setup/action.yml`), 'utf8')) as {
		runs?: { steps?: { env?: Record<string, unknown> }[] };
	};
	const defaults = (action.runs?.steps ?? []).flatMap((s) =>
		s.env?.DEFAULT_TOKEN_VAR === undefined ? [] : [s.env.DEFAULT_TOKEN_VAR],
	);
	// Умолчание задано в action.yml ровно одним шагом; тест не держит свою копию имени.
	expect(defaults).toHaveLength(1);
	const DEFAULT = defaults[0] as string;
	const rows = calls.filter(
		(c) =>
			c.target === `${ACTIONS}setup/action.yml` &&
			c.with.includes('registry') &&
			!c.with.includes('registry-token-var'),
	);
	const froms = rows.map((c) => c.from);
	expect(froms).toContain(`${WORKFLOWS}check.yml`);
	expect(froms).toContain(`${WORKFLOWS}sync.yml`);
	for (const c of rows) {
		expect({ from: c.from, has: Object.hasOwn(c.env, DEFAULT) }).toStrictEqual({
			from: c.from,
			has: true,
		});
	}
	// Умолчание получает секрет, который объявляет сам workflow.
	for (const c of rows.filter(
		(r) => r.from === `${WORKFLOWS}check.yml` || r.from === `${WORKFLOWS}sync.yml`,
	)) {
		expect({ from: c.from, value: c.env[DEFAULT] }).toStrictEqual({
			from: c.from,
			value: '${{ secrets.registry-token }}',
		});
	}
});

test('проводка registry: свой setup в check.yml и sync.yml получает input registry самого workflow', () => {
	for (const f of ['check.yml', 'sync.yml']) {
		const wf = parseYaml(readFileSync(join(ROOT, WORKFLOWS, f), 'utf8')) as Workflow;
		const withs = Object.values(wf.jobs ?? {}).flatMap((j) =>
			(j.steps ?? []).flatMap((s) =>
				s.uses != null && ACTION_USES.exec(s.uses)?.[1] === 'setup' ? [s.with?.registry] : [],
			),
		);
		expect({ f, withs }).toStrictEqual({ f, withs: ['${{ inputs.registry }}'] });
	}
});

// rollout шлёт workflow_dispatch каждому потребителю, какой бы у него ни был Profile: канон-файл с этим именем
// есть в каждом Profile, и тело dispatch укладывается в его on.workflow_dispatch.inputs — иначе GitHub отвечает 422.
describe('dispatch из scripts/rollout.ts в рамках workflow_dispatch канон-файла', () => {
	test.each(PROFILES)('%s', (profile) => {
		const dest = `${WORKFLOWS}${DISPATCH_WORKFLOW}`;
		const text = canonFile(dest, profile);
		const wd = (
			parseYaml(text) as {
				on?: { workflow_dispatch?: { inputs?: Contract['inputs'] } | null };
			}
		).on?.workflow_dispatch;
		if (wd == null) throw new Error(`${dest} (${profile}): нет on.workflow_dispatch`);
		const contract: Contract = { inputs: wd.inputs ?? {}, secrets: {} };
		const call: Call = {
			from: 'scripts/rollout.ts',
			job: 'dispatch',
			step: null,
			target: dest,
			ref: null,
			with: Object.keys(dispatchRequest('1.2.3').inputs),
			secrets: [],
			env: {},
		};
		expect(callProblems(call, contract)).toStrictEqual([]);
	});
});

test('sync.yml: вход install объявлен — его передают копии канон-файла до 1.12.0', () => {
	const wf = parseYaml(readFileSync(join(ROOT, WORKFLOWS, 'sync.yml'), 'utf8')) as Workflow;
	expect(workflowCallOf(wf.on)?.inputs?.install).toMatchObject({ type: 'boolean', default: true });
});

describe('declaresWorkflowCall', () => {
	test.each([
		['нет on', undefined, false],
		['on без workflow_call', { push: null }, false],
		['пустой workflow_call:', { workflow_call: null }, true],
		['workflow_call: {}', { workflow_call: {} }, true],
		['on: workflow_call', 'workflow_call', true],
		['on: push', 'push', false],
		['on: [workflow_call]', ['push', 'workflow_call'], true],
		['on: [push]', ['push'], false],
	] as const)('%s', (_name, on, expected) => {
		expect(declaresWorkflowCall(on as Workflow['on'])).toBe(expected);
	});

	test('ключ из прототипа не считается', () => {
		expect(declaresWorkflowCall({} as Workflow['on'])).toBe(false);
	});
});

describe('callProblems', () => {
	const call: Call = {
		from: 'f',
		job: 'j',
		step: null,
		target: 't.yml',
		ref: null,
		with: [],
		secrets: [],
		env: {},
	};
	const contract: Contract = {
		inputs: { a: { required: true }, b: { required: true, default: 1 }, c: {} },
		secrets: { s: { required: true }, o: {} },
	};
	const ok: Call = { ...call, with: ['a'], secrets: ['s'] };

	test('вызов в рамках контракта — без проблем', () => {
		expect(callProblems(ok, contract)).toEqual([]);
	});

	test('лишний ключ with — проблема с именем ключа', () => {
		const p = callProblems({ ...ok, with: ['a', 'zzz'] }, contract);
		expect(p).toHaveLength(1);
		expect(p[0]).toContain('with.zzz');
	});

	test('обязательный input без default не передан — проблема', () => {
		const p = callProblems({ ...ok, with: [] }, contract);
		expect(p).toHaveLength(1);
		expect(p[0]).toContain('with.a');
	});

	test('обязательный input с default можно не передавать', () => {
		expect(callProblems({ ...ok, with: ['a'] }, contract)).toEqual([]);
	});

	test('лишний секрет — проблема с именем секрета', () => {
		const p = callProblems({ ...ok, secrets: ['s', 'zzz'] }, contract);
		expect(p).toHaveLength(1);
		expect(p[0]).toContain('secrets.zzz');
	});

	test('обязательный секрет не передан — проблема', () => {
		const p = callProblems({ ...ok, secrets: [] }, contract);
		expect(p).toHaveLength(1);
		expect(p[0]).toContain('secrets.s');
	});

	test('secrets: inherit — секреты не сверяются', () => {
		expect(callProblems({ ...ok, secrets: 'inherit' }, contract)).toEqual([]);
	});

	test('inherit не отменяет сверку with', () => {
		expect(callProblems({ ...ok, secrets: 'inherit', with: ['a', 'zzz'] }, contract)).toHaveLength(
			1,
		);
	});
});

describe('callsOf', () => {
	test('находит jobs.*.uses и steps.*.uses своего репо обоих видов, сторонние пропускает', () => {
		const text = [
			'jobs:',
			'  a:',
			'    uses: alxwlw/stack/.github/workflows/check.yml@main',
			'    secrets: inherit',
			'  b:',
			'    uses: ./.github/workflows/sync.yml',
			'    with: { version: x }',
			'  c:',
			'    uses: other/repo/.github/workflows/check.yml@v1',
			'  d:',
			'    env: { T: x }',
			'    steps:',
			'      - uses: actions/checkout@v7',
			'      - uses: alxwlw/stack/.github/actions/setup@v1',
			'        with: { install: false, registry: r }',
			'      - run: echo',
			'      - uses: ./.github/actions/setup',
			'      - uses: other/repo/.github/actions/setup@v1',
		].join('\n');
		const got = callsOf('f', text);
		expect(got).toHaveLength(4);
		expect(got).toStrictEqual([
			{
				from: 'f',
				job: 'a',
				step: null,
				target: '.github/workflows/check.yml',
				ref: 'main',
				with: [],
				secrets: 'inherit',
				env: {},
			},
			{
				from: 'f',
				job: 'b',
				step: null,
				target: '.github/workflows/sync.yml',
				ref: null,
				with: ['version'],
				secrets: [],
				env: {},
			},
			{
				from: 'f',
				job: 'd',
				step: 1,
				target: '.github/actions/setup/action.yml',
				ref: 'v1',
				with: ['install', 'registry'],
				secrets: [],
				env: { T: 'x' },
			},
			{
				from: 'f',
				job: 'd',
				step: 3,
				target: '.github/actions/setup/action.yml',
				ref: null,
				with: [],
				secrets: [],
				env: { T: 'x' },
			},
		]);
	});
});

describe('contractOf', () => {
	test('action: inputs из action.yml, секретов нет', () => {
		const c = contractOf('.github/actions/setup/action.yml');
		expect(Object.keys(c.inputs).toSorted()).toStrictEqual([
			'install',
			'registry',
			'registry-token-var',
			'working-directory',
		]);
		expect(c.secrets).toStrictEqual({});
	});

	test('action, которого нет, — ошибка с путём, а не пустой контракт', () => {
		expect(() => contractOf('.github/actions/setpu/action.yml')).toThrow(
			'.github/actions/setpu/action.yml',
		);
	});
});
