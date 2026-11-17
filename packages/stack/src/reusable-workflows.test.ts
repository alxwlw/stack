import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'bun:test';
import { parse as parseYaml } from 'yaml';

const ROOT = join(import.meta.dir, '..', '..', '..');

// Reusable workflow, который зовёт канон-файл .github/workflows/stack-check.yml потребителя.
test('reusable check.yml: вход gitleaks выключен по умолчанию и включает скан всей истории', () => {
	const wf = parseYaml(readFileSync(join(ROOT, '.github', 'workflows', 'check.yml'), 'utf8')) as {
		on?: { workflow_call?: { inputs?: Record<string, { type?: string; default?: unknown }> } };
		jobs?: Record<
			string,
			{ steps?: { uses?: string; if?: string; run?: string; with?: Record<string, unknown> }[] }
		>;
	};
	const input = wf.on?.workflow_call?.inputs?.gitleaks;
	expect(input?.type).toBe('boolean');
	expect(input?.default).toBe(false);
	const steps = Object.values(wf.jobs ?? {}).flatMap((j) => j.steps ?? []);
	const scan = steps.find((s) => s.run?.includes('gitleaks git'));
	expect(scan?.if).toBe('inputs.gitleaks');
	const checkout = steps.find((s) => s.uses?.startsWith('actions/checkout@'));
	expect(checkout?.with?.['fetch-depth']).toBe("${{ inputs.gitleaks && '0' || '1' }}");
});

// Reusable workflow, который зовёт канон-файл .github/workflows/renovate.yml потребителя.
test('reusable renovate.yml: workflow_call с обязательным token, action на полной версии', () => {
	const wf = parseYaml(
		readFileSync(join(ROOT, '.github', 'workflows', 'renovate.yml'), 'utf8'),
	) as {
		on?: { workflow_call?: { secrets?: { token?: { required?: boolean } } } };
		jobs?: Record<string, { steps?: { uses?: string; env?: Record<string, string> }[] }>;
	};
	expect(wf.on?.workflow_call?.secrets?.token?.required).toBe(true);
	const steps = Object.values(wf.jobs ?? {}).flatMap((j) => j.steps ?? []);
	const action = steps.find((s) => s.uses?.startsWith('renovatebot/github-action@'));
	// У action нет плавающего мажорного тега: @v46 не резолвится.
	expect(action?.uses).toMatch(/^renovatebot\/github-action@v\d+\.\d+\.\d+$/);
	expect(action?.env?.RENOVATE_REPOSITORIES).toBe('${{ github.repository }}');
});

type RegistryWf = {
	on?: {
		workflow_call?: {
			inputs?: Record<string, unknown>;
			secrets?: Record<string, { required?: boolean }>;
		};
	};
	jobs?: Record<
		string,
		{
			env?: Record<string, string>;
			steps?: { uses?: string; with?: Record<string, unknown>; env?: Record<string, string> }[];
		}
	>;
};
const readWf = (name: string) =>
	parseYaml(readFileSync(join(ROOT, '.github', 'workflows', name), 'utf8')) as RegistryWf;

test.each(['check.yml', 'sync.yml', 'renovate.yml'])(
	'%s: вход registry с дефолтом "" и необязательный секрет registry-token',
	(name) => {
		const call = readWf(name).on?.workflow_call;
		expect(call?.inputs?.registry).toMatchObject({ type: 'string', default: '' });
		expect(call?.inputs?.registry).toHaveProperty('description');
		expect(call?.secrets?.['registry-token']?.required).toBe(false);
	},
);

test('renovate.yml: host rule приватного реестра только при непустом registry', () => {
	const job = Object.values(readWf('renovate.yml').jobs ?? {})[0];
	const action = job?.steps?.find((s) => s.uses?.startsWith('renovatebot/github-action@'));
	const rules = action?.env?.RENOVATE_HOST_RULES ?? '';
	expect(rules).toContain("inputs.registry != ''");
	// format('<шаблон>', host, token): порядок аргументов важен, шаблон исполняем как GitHub.
	const m = /format\('(.*)', inputs\.registry, secrets\.registry-token\)/.exec(rules);
	expect(m).not.toBeNull();
	const args = ['npm.example.com', 't'];
	const rendered = (m?.[1] ?? '').replace(/\{\{|\}\}|\{(\d+)\}|[{}]/g, (tok, n?: string) => {
		if (tok === '{{') return '{';
		if (tok === '}}') return '}';
		if (n === undefined) throw new Error(`неэкранированная скобка в format: ${tok}`);
		return args[Number(n)] ?? 'MISSING';
	});
	expect(JSON.parse(rendered)).toEqual([
		{ matchHost: 'npm.example.com', hostType: 'npm', token: 't' },
	]);
	expect(rules).toMatch(/\|\| '\[\]' \}\}$/);
});
