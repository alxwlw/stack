import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';
import { parse as parseYaml } from 'yaml';

import { readCanonSource } from './canon.ts';

// Вызов reusable workflow стека должен укладываться в on.workflow_call цели: иначе у потребителя
// workflow падает при запуске. Таблицу вызовов строит обход файлов (корень + канон-файлы), а не список
// в тесте: новый `uses:` попадает под проверку сам.
const ROOT = join(import.meta.dir, '..', '..', '..');
const WORKFLOWS = '.github/workflows/';

type Call = {
	/** Корневой файл — путь от корня репо; канон-файл — `canon:<src из манифеста>` (dest у двух stack-check общий). */
	from: string;
	job: string;
	/** Имя файла цели в `.github/workflows/`. */
	target: string;
	/** `v1` у вызова по имени репо стека; `null` у локального `./`. */
	ref: string | null;
	with: string[];
	secrets: string[] | 'inherit';
};

type Contract = {
	inputs: Record<string, { required?: boolean; default?: unknown }>;
	secrets: Record<string, { required?: boolean }>;
};

type Workflow = {
	on?: { workflow_call?: Partial<Contract> | null };
	jobs?: Record<
		string,
		{ uses?: string; with?: Record<string, unknown>; secrets?: Record<string, unknown> | string }
	>;
};

const USES = /^(?:alxwlw\/stack\/|\.\/)\.github\/workflows\/([\w.-]+\.yml)(?:@(.+))?$/;

function callsOf(from: string, text: string): Call[] {
	const wf = parseYaml(text) as Workflow;
	return Object.entries(wf.jobs ?? {}).flatMap(([job, j]) => {
		const m = j.uses == null ? null : USES.exec(j.uses);
		if (m?.[1] == null) return [];
		return [
			{
				from,
				job,
				target: m[1],
				ref: m[2] ?? null,
				with: Object.keys(j.with ?? {}),
				secrets: typeof j.secrets === 'string' ? 'inherit' : Object.keys(j.secrets ?? {}),
			},
		];
	});
}

function contractOf(target: string): Contract {
	const wf = parseYaml(readFileSync(join(ROOT, WORKFLOWS, target), 'utf8')) as Workflow;
	const wc = wf.on?.workflow_call;
	// Цель без workflow_call нельзя звать вовсе: падаем, а не считаем контракт пустым.
	if (wc == null) throw new Error(`${target}: нет on.workflow_call`);
	return { inputs: wc.inputs ?? {}, secrets: wc.secrets ?? {} };
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

test('обход находит вызовы reusable workflow', () => {
	expect(calls.length).toBeGreaterThanOrEqual(5);
	const pairs = calls.map((c) => [c.from, c.target]);
	for (const pair of [
		['canon:files/workflow-renovate.yml', 'renovate.yml'],
		['canon:files/workflow-stack-sync.yml', 'sync.yml'],
		['canon:files/workflow-stack-check.yml', 'check.yml'],
		['canon:files/workflow-stack-check-infra.yml', 'check.yml'],
		['.github/workflows/renovate-self.yml', 'renovate.yml'],
	]) {
		expect(pairs).toContainEqual(pair);
	}
});

describe('вызовы в рамках workflow_call цели', () => {
	test.each(calls.map((c) => [`${c.from}#${c.job} → ${c.target}`, c] as const))(
		'%s',
		(_name, call) => {
			expect(callProblems(call, contractOf(call.target))).toEqual([]);
		},
	);
});

test('канон-файлы зовут reusable workflow стека на @v1', () => {
	expect(canonCalls.length).toBeGreaterThan(0);
	for (const c of canonCalls)
		expect({ from: c.from, ref: c.ref }).toEqual({ from: c.from, ref: 'v1' });
});

test('проводка канон-файлов: токен Renovate и базовая ветка sync', () => {
	const job = (src: string, name: string) =>
		(parseYaml(canonEntries.find((e) => e.src === src)?.content ?? '') as Workflow).jobs?.[name];
	expect(job('files/workflow-renovate.yml', 'renovate')?.secrets).toEqual({
		token: '${{ secrets.RENOVATE_TOKEN }}',
	});
	expect(job('files/workflow-stack-sync.yml', 'sync')?.with?.base).toBe(
		"${{ vars.STACK_SYNC_BASE || '' }}",
	);
});

describe('callProblems', () => {
	const call: Call = { from: 'f', job: 'j', target: 't.yml', ref: null, with: [], secrets: [] };
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
	test('находит jobs.*.uses обоих видов, шаги и сторонние actions пропускает', () => {
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
			'    steps:',
			'      - uses: alxwlw/stack/.github/actions/setup@v1',
		].join('\n');
		expect(callsOf('f', text)).toEqual([
			{ from: 'f', job: 'a', target: 'check.yml', ref: 'main', with: [], secrets: 'inherit' },
			{ from: 'f', job: 'b', target: 'sync.yml', ref: null, with: ['version'], secrets: [] },
		]);
	});
});
