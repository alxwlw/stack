import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'bun:test';
import { parse as parseYaml } from 'yaml';

const ROOT = join(import.meta.dir, '..', '..', '..');

// Reusable workflow, который зовёт канон-файл packages/stack/canon/files/workflow-stack-check.yml.
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

test('reusable check.yml: шаг history — только pull_request, между checkout и setup, входы прежние', () => {
	const wf = parseYaml(readFileSync(join(ROOT, '.github', 'workflows', 'check.yml'), 'utf8')) as {
		on?: { workflow_call?: { inputs?: Record<string, unknown> } };
		jobs?: Record<string, { steps?: { id?: string; uses?: string; if?: string; run?: string }[] }>;
	};
	expect(Object.keys(wf.on?.workflow_call?.inputs ?? {})).toStrictEqual([
		'install',
		'version',
		'gitleaks',
		'registry',
	]);
	const steps = Object.values(wf.jobs ?? {}).flatMap((j) => j.steps ?? []);
	const history = steps.find((s) => s.id === 'history');
	expect(history?.if).toBe("github.event_name == 'pull_request'");
	const at = steps.findIndex((s) => s.id === 'history');
	const checkout = steps.findIndex((s) => s.uses?.startsWith('actions/checkout@'));
	const setup = steps.findIndex((s) => s.uses?.startsWith('alxwlw/stack/.github/actions/setup@'));
	expect(checkout).toBeGreaterThanOrEqual(0);
	expect(at).toBeGreaterThan(checkout);
	expect(setup).toBeGreaterThan(at);
	expect(history?.run).not.toContain('${{');
});

// Reusable workflow, который зовёт канон-файл packages/stack/canon/files/workflow-renovate.yml.
test('reusable renovate.yml: секреты необязательны, action на полной версии', () => {
	const wf = parseYaml(
		readFileSync(join(ROOT, '.github', 'workflows', 'renovate.yml'), 'utf8'),
	) as {
		on?: { workflow_call?: { secrets?: Record<string, { required?: boolean }> } };
		jobs?: Record<string, { steps?: { uses?: string; env?: Record<string, string> }[] }>;
	};
	const secrets = wf.on?.workflow_call?.secrets ?? {};
	expect(Object.keys(secrets)).toStrictEqual([
		'token',
		'app-id',
		'app-private-key',
		'registry-token',
	]);
	for (const [name, secret] of Object.entries(secrets))
		expect({ name, required: secret.required }).toEqual({ name, required: false });
	const steps = Object.values(wf.jobs ?? {}).flatMap((j) => j.steps ?? []);
	const action = steps.find((s) => s.uses?.startsWith('renovatebot/github-action@'));
	// У action нет плавающего мажорного тега: @v46 не резолвится.
	expect(action?.uses).toMatch(/^renovatebot\/github-action@v\d+\.\d+\.\d+$/);
	expect(action?.env?.RENOVATE_REPOSITORIES).toBe('${{ github.repository }}');
});

test('reusable renovate.yml: токен GitHub App при непустом app-id, иначе token', () => {
	const wf = parseYaml(
		readFileSync(join(ROOT, '.github', 'workflows', 'renovate.yml'), 'utf8'),
	) as {
		jobs?: Record<
			string,
			{
				env?: Record<string, string>;
				steps?: {
					id?: string;
					uses?: string;
					if?: string;
					run?: string;
					with?: Record<string, string>;
					env?: Record<string, string>;
				}[];
			}
		>;
	};
	const job = Object.values(wf.jobs ?? {})[0];
	const steps = job?.steps ?? [];
	expect(job?.env?.APP_ID).toBe('${{ secrets.app-id }}');
	const app = steps.find((s) => s.uses?.startsWith('actions/create-github-app-token@'));
	expect(app?.uses).toBe('actions/create-github-app-token@v3');
	expect(app?.id).toBe('app-token');
	expect(app?.if).toBe("env.APP_ID != ''");
	expect(app?.with).toEqual({
		'app-id': '${{ secrets.app-id }}',
		'private-key': '${{ secrets.app-private-key }}',
		owner: '${{ github.repository_owner }}',
		repositories: '${{ github.event.repository.name }}',
	});
	const action = steps.find((s) => s.uses?.startsWith('renovatebot/github-action@'));
	expect(action?.with?.token).toBe('${{ steps.app-token.outputs.token || secrets.token }}');
	// Шаг-проверку выполняем: ошибка только когда нет ни app-id, ни token.
	expect(job?.env?.PAT).toBe('${{ secrets.token }}');
	const guard = steps.findIndex((s) => s.run?.includes('exit 1'));
	expect(guard).toBeGreaterThanOrEqual(0);
	expect(guard).toBeLessThan(steps.findIndex((s) => s.id === 'app-token'));
	const run = (appId: string, pat: string) => {
		const r = spawnSync('bash', ['-e', '-c', steps[guard]?.run ?? ''], {
			env: { PATH: process.env.PATH ?? '', APP_ID: appId, PAT: pat },
			encoding: 'utf8',
		});
		return { rc: r.status, error: r.stdout.includes('::error::') };
	};
	expect(run('x', 'y')).toEqual({ rc: 0, error: false });
	expect(run('x', '')).toEqual({ rc: 0, error: false });
	expect(run('', 'y')).toEqual({ rc: 0, error: false });
	expect(run('', '')).toEqual({ rc: 1, error: true });
	// Без App auto-merge выключен принудительно: RENOVATE_FORCE — последнее packageRule и перекрывает пресет.
	const off = steps.find((s) => s.run?.includes('RENOVATE_FORCE'));
	expect(off?.if).toBe("steps.app-token.outputs.token == ''");
	expect(off?.run).toContain('echo \'RENOVATE_FORCE={"automerge":false}\' >> "$GITHUB_ENV"');
	expect(off?.run).toContain('::warning::');
	expect(steps.indexOf(off as never)).toBeGreaterThan(steps.findIndex((s) => s.id === 'app-token'));
	expect(steps.indexOf(off as never)).toBeLessThan(
		steps.findIndex((s) => s.uses?.startsWith('renovatebot/github-action@')),
	);
	// Токен репо меняется между App и PAT: PR и issues прежней учётной записи остаются под управлением.
	expect(action?.env?.RENOVATE_IGNORE_PR_AUTHOR).toBe('true');
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
