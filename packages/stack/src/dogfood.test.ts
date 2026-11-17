import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';
import JSON5 from 'json5';
import { parse as parseYaml } from 'yaml';

import { loadCanon, readCanonSource } from './canon.ts';
import { canonBundles, canonFile } from './testkit.ts';

// Репозиторий канона сознательно не вызывает `stack sync` на себе (его каталог dev называет
// версии @alxwlw/* как workspace:*, sync их сломает) — поэтому ничто не мешает корневым файлам
// разъехаться с канон-сидом молча. Ruling 34 закрывает carry явными тестами.
const ROOT = join(import.meta.dir, '..', '..', '..');

function pinLines(text: string): string[] {
	return text
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line !== '' && !line.startsWith('#'));
}

test('корневой .oxfmtrc.jsonc — байт-в-байт копия canon/files/oxfmtrc.jsonc', () => {
	const root = readFileSync(join(ROOT, '.oxfmtrc.jsonc'), 'utf8');
	const canon = canonFile('.oxfmtrc.jsonc');
	expect(root).toBe(canon);
});

test('корневой .prototools — строки-пины совпадают с canon/files/prototools', () => {
	const root = pinLines(readFileSync(join(ROOT, '.prototools'), 'utf8'));
	const canon = pinLines(canonFile('.prototools'));
	expect(root).toEqual(canon);
});

// Task 13 нашёл именно этот carry вживую: canon/catalogs.json откатил dev.oxlint на 1.74.0, а
// корневой pnpm-workspace.yaml (ручное зеркало — @alxwlw/* здесь не публикуются через catalog,
// это сам канон, workspace:*) чуть не остался на 1.83.0 молча.
test('корневой pnpm-workspace.yaml catalogs.dev — версии инструментов совпадают с canon/catalogs.json', () => {
	const root = parseYaml(readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8')) as {
		catalogs?: { dev?: Record<string, unknown> };
	};
	const rootDev = root.catalogs?.dev ?? {};
	expect(Object.keys(rootDev).length).toBeGreaterThan(0);
	const canonDev = readCanonSource().catalogs.dev ?? {};
	for (const [name, version] of Object.entries(rootDev)) {
		const expected: string | undefined = canonDev[name];
		expect(expected).toBeDefined();
		expect(String(version)).toBe(expected as string);
	}
});

test('корневой package.json#packageManager — pnpm на пине канона', () => {
	const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
		packageManager?: string;
	};
	const pin = loadCanon({ profile: 'node', with: [], exceptions: [] }).pins.pnpm;
	expect(pin).toBeDefined();
	expect(pkg.packageManager).toBe(`pnpm@${pin}`);
});

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

// sync.yml ждёт версию stack в реестре до bunx: rollout стартует сразу после publish, и в 1.6.0 все
// sync упали на «No version matching». Шаг гоняется в bash с curl-заглушкой, а не сверяется текстом.
type SyncStep = {
	name?: string;
	uses?: string;
	id?: string;
	if?: string;
	run?: string;
	env?: Record<string, string>;
};
const syncSteps = (
	parseYaml(readFileSync(join(ROOT, '.github', 'workflows', 'sync.yml'), 'utf8')) as {
		jobs?: Record<string, { steps?: SyncStep[] }>;
	}
).jobs?.sync?.steps;
const waitIdx = syncSteps?.findIndex((s) => s.name === 'дождаться версии в npm') ?? -1;
const waitStep = syncSteps?.[waitIdx];
const callIdx = syncSteps?.findIndex((s) => s.name === 'открыть sync-PR') ?? -1;
const callStep = syncSteps?.[callIdx];

/** `body` — тело ответа реестра для stack; `undefined` — curl падает, как `curl -f` на 404/5xx. */
function runWait(
	body: string | undefined,
	attempts: string,
	interval = '0',
): { status: number | null; calls: string[]; out: string; sleeps: string[] } {
	const dir = mkdtempSync(join(tmpdir(), 'sync-wait-'));
	const calls = join(dir, 'calls');
	const reply = body === undefined ? 'exit 22' : `cat '${join(dir, 'body.json')}'`;
	if (body !== undefined) writeFileSync(join(dir, 'body.json'), body);
	writeFileSync(
		join(dir, 'curl'),
		`#!/usr/bin/env bash\np="\${!#}"; p="\${p##*%2f}"\necho "$p" >> '${calls}'\n${reply}\n`,
	);
	chmodSync(join(dir, 'curl'), 0o755);
	// Заглушка sleep пишет аргумент и не спит: паузы проверяются значением, а не временем.
	const sleeps = join(dir, 'sleeps');
	writeFileSync(join(dir, 'sleep'), `#!/usr/bin/env bash\necho "$1" >> '${sleeps}'\n`);
	chmodSync(join(dir, 'sleep'), 0o755);
	// Как раннер GitHub без `shell:`: `bash -e {0}`, без pipefail.
	const res = spawnSync('bash', ['-e', '-c', waitStep?.run ?? 'exit 99'], {
		env: {
			...process.env,
			PATH: `${dir}:${process.env.PATH}`,
			VERSION: '1.2.3',
			ATTEMPTS: attempts,
			INTERVAL: interval,
		},
		encoding: 'utf8',
	});
	const n = existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean) : [];
	const slept = existsSync(sleeps) ? readFileSync(sleeps, 'utf8').split('\n').filter(Boolean) : [];
	rmSync(dir, { recursive: true, force: true });
	return { status: res.status, calls: n, out: res.stdout, sleeps: slept };
}

/** Шаг вызова с заглушкой bunx: аргументы пишутся в файл по строке, код выхода — `exit`. */
function runCall(
	env: { INSTALL: string; BASE: string },
	exit = 0,
): { status: number | null; args: string[] } {
	const dir = mkdtempSync(join(tmpdir(), 'sync-call-'));
	const argsFile = join(dir, 'args');
	writeFileSync(
		join(dir, 'bunx'),
		`#!/usr/bin/env bash\nprintf '%s\\n' "$@" > '${argsFile}'\nexit ${exit}\n`,
	);
	chmodSync(join(dir, 'bunx'), 0o755);
	const res = spawnSync('bash', ['-e', '-c', callStep?.run ?? 'exit 99'], {
		env: {
			...process.env,
			PATH: `${dir}:${process.env.PATH}`,
			VERSION: '1.2.3',
			GH_TOKEN: 't',
			STACK_APP_SLUG: 'app',
			...env,
		},
		encoding: 'utf8',
	});
	const args = existsSync(argsFile) ? readFileSync(argsFile, 'utf8').split('\n').slice(0, -1) : [];
	rmSync(dir, { recursive: true, force: true });
	return { status: res.status, args };
}

const has = '{"versions":{"1.2.2":{},"1.2.3":{}}}';
// dist-tags с той же строкой не должны сойти за версию.
const lacks = '{"dist-tags":{"latest":"1.2.3"},"versions":{"1.2.2":{}}}';

test('sync.yml: токен приложения, checkout, setup, ожидание stack, вызов sync-pr — и ничего больше', () => {
	expect(syncSteps).toHaveLength(5);
	expect(syncSteps?.map((s) => s.uses?.replace(/@.*$/, '') ?? s.name)).toStrictEqual([
		'actions/create-github-app-token',
		'actions/checkout',
		'alxwlw/stack/.github/actions/setup',
		'дождаться версии в npm',
		'открыть sync-PR',
	]);
});

test('sync.yml: в run нет git, gh и чтения package.json', () => {
	for (const s of (syncSteps ?? []).filter((x) => x.run !== undefined)) {
		expect(s.run).not.toMatch(/\b(git|gh)\b/);
		expect(s.run).not.toContain('package.json');
	}
});

test('шаг вызова: окружение — версия, base, install, токен и slug приложения', () => {
	expect(callStep?.env).toEqual({
		VERSION: '${{ inputs.version }}',
		BASE: '${{ inputs.base }}',
		INSTALL: '${{ inputs.install }}',
		GH_TOKEN: '${{ steps.app-token.outputs.token }}',
		STACK_APP_SLUG: '${{ steps.app-token.outputs.app-slug }}',
	});
	expect(callStep?.if).toBeUndefined();
});

test('sync.yml ждёт версию stack до bunx и с тем же VERSION', () => {
	expect(waitIdx).toBeGreaterThanOrEqual(0);
	expect(callIdx).toBeGreaterThan(waitIdx);
	expect(waitStep?.env?.VERSION).toBe('${{ inputs.version }}');
	expect(callStep?.env?.VERSION).toBe('${{ inputs.version }}');
});

test('шаг ожидания — короткая страховка: ATTEMPTS 12', () => {
	expect(waitStep?.env?.ATTEMPTS).toBe('12');
});

test('шаг ожидания выходит на первой попытке, когда версия stack уже в реестре', () => {
	const r = runWait(has, '3');
	expect(r.status).toBe(0);
	expect(r.calls).toEqual(['stack']);
	expect(r.sleeps).toEqual([]);
});

test('шаг ожидания спит INTERVAL только между попытками', () => {
	const r = runWait(lacks, '3', '7');
	expect(r.status).toBe(1);
	expect(r.sleeps).toEqual(['7', '7']);
});

test('шаг ожидания падает после ATTEMPTS попыток и называет версию', () => {
	const r = runWait(lacks, '3');
	expect(r.status).toBe(1);
	expect(r.calls).toEqual(['stack', 'stack', 'stack']);
	expect(r.out).toContain('@alxwlw/stack@1.2.3');
});

test('шаг ожидания не принимает упавший запрос к реестру за наличие версии', () => {
	const r = runWait(undefined, '2');
	expect(r.status).toBe(1);
	expect(r.calls).toHaveLength(2);
});

test('шаг вызова: base пустой, install true — bunx @alxwlw/stack@1.2.3 sync-pr --base=', () => {
	const r = runCall({ INSTALL: 'true', BASE: '' });
	expect(r.status).toBe(0);
	expect(r.args).toEqual(['@alxwlw/stack@1.2.3', 'sync-pr', '--base=']);
});

test('шаг вызова: install false от старой копии канон-файла — --no-install', () => {
	const r = runCall({ INSTALL: 'false', BASE: 'staging' });
	expect(r.args).toEqual(['@alxwlw/stack@1.2.3', 'sync-pr', '--base=staging', '--no-install']);
});

test('шаг вызова: bunx вышел с 2 — шаг вышел с 2', () => {
	expect(runCall({ INSTALL: 'true', BASE: '' }, 2).status).toBe(2);
});

// Renovate самого стека двигает пины канона. Пресет канона он подключать не должен: тот выключает
// proto и каталог dev — ровно то, что здесь нужно поднимать.
const ownRenovate = JSON5.parse(readFileSync(join(ROOT, 'renovate.json5'), 'utf8')) as {
	extends?: string[];
	proto?: { managerFilePatterns?: string[] };
	customManagers?: {
		customType?: string;
		managerFilePatterns?: string[];
		matchStrings?: string[];
	}[];
	ignorePaths?: string[];
	packageRules?: {
		groupName?: string;
		separateMajorMinor?: boolean;
		matchFileNames?: string[];
		matchPackageNames?: string[];
		enabled?: boolean;
		allowedVersions?: string;
	}[];
};

// Паттерн Renovate вида '/regex/' → проверка, что он попадает в существующий файл (ловит переименование).
function hits(pattern: string, file: string): boolean {
	const m = /^\/(.*)\/$/.exec(pattern);
	expect(m).not.toBeNull();
	return new RegExp(m?.[1] ?? '').test(file) && existsSync(join(ROOT, file));
}

test('свой renovate.json5: без пресета канона', () => {
	// Любая ссылка на репо стека в extends (с тегом или без) — это пресет канона.
	expect((ownRenovate.extends ?? []).some((e) => e.includes('alxwlw/stack'))).toBe(false);
});

test('свой renovate.json5: свои пакеты и ссылки на стек выключены одним правилом', () => {
	const rule = (ownRenovate.packageRules ?? []).find(
		(r) =>
			r.enabled === false &&
			(r.matchPackageNames ?? []).includes('@alxwlw/**') &&
			(r.matchPackageNames ?? []).includes('alxwlw/stack'),
	);
	expect(rule).toBeDefined();
	// Точный список: '!alxwlw/stack' в нём отменил бы отключение для ссылок на стек, а includes это пропустит.
	expect(rule?.matchPackageNames).toEqual(['@alxwlw/**', 'alxwlw/stack']);
	// match* внутри правила Renovate склеивает через И, exclude* вычитает: лишний matchManagers или
	// excludePackageNames сузил бы правило, и ссылки alxwlw/stack@v1 в github-actions остались бы включёнными.
	expect(Object.keys(rule ?? {}).filter((k) => /^(match|exclude)/.test(k))).toEqual([
		'matchPackageNames',
	]);
});

test('свой renovate.json5: proto видит канон-prototools, jsonata — catalogs.json', () => {
	expect(
		(ownRenovate.proto?.managerFilePatterns ?? []).some((p) =>
			hits(p, 'packages/stack/canon/files/prototools'),
		),
	).toBe(true);
	const jsonata = (ownRenovate.customManagers ?? []).find((c) => c.customType === 'jsonata');
	expect(
		(jsonata?.managerFilePatterns ?? []).some((p) => hits(p, 'packages/stack/canon/catalogs.json')),
	).toBe(true);
});

test('свой renovate.json5: канон и корень — одна группа canon pins', () => {
	const group = (ownRenovate.packageRules ?? []).find((r) => r.groupName === 'canon pins');
	for (const f of [
		'packages/stack/canon/files/prototools',
		'packages/stack/canon/catalogs.json',
		'.prototools',
		'pnpm-workspace.yaml',
		'package.json',
	]) {
		expect(existsSync(join(ROOT, f))).toBe(true);
		expect((group?.matchFileNames ?? []).some((g) => new Bun.Glob(g).match(f))).toBe(true);
	}
	// Лишний match*/exclude* сузил бы группу: часть файлов ушла бы из canon pins в отдельные PR.
	expect(Object.keys(group ?? {}).filter((k) => /^(match|exclude)/.test(k))).toEqual([
		'matchFileNames',
	]);
});

// Связка из canon/bundles.json бампается одной веткой: своё правило 'bundle <имя>' с тем же matchPackageNames.
// Правило стоит ниже canon pins: Renovate применяет совпавшие правила по порядку, поздний groupName перекрывает ранний.
describe('renovate.json5: правила связок canon/bundles.json', () => {
	const bundles = canonBundles();
	const rules = ownRenovate.packageRules ?? [];
	const canonIdx = rules.findIndex((r) => r.groupName === 'canon pins');

	test.each(Object.keys(bundles))(
		'bundle %s: одно правило, тот же matchPackageNames, ниже canon pins',
		(name) => {
			expect(canonIdx).toBeGreaterThanOrEqual(0);
			const idx = rules.flatMap((r, i) => (r.groupName === `bundle ${name}` ? [i] : []));
			// Своя группа, ни с кем не общая: общая слила бы мажор одной связки с другой.
			expect(idx).toHaveLength(1);
			const rule = rules[idx[0] ?? -1];
			expect(rule?.matchPackageNames).toStrictEqual(bundles[name]?.match);
			// Лишний match*/exclude* сузил бы правило: часть пакетов связки ушла бы из ветки.
			expect(Object.keys(rule ?? {}).filter((k) => /^(match|exclude)/.test(k))).toStrictEqual([
				'matchPackageNames',
			]);
			expect(rule?.separateMajorMinor).toBe(false);
			expect(idx[0]).toBeGreaterThan(canonIdx);
		},
	);

	test('правило группы по именам пакетов — правило связки из canon/bundles.json', () => {
		// Правило с groupName и matchPackageNames группирует пакеты в одну ветку — это связка, и её запись обязана быть.
		const orphans = rules
			.filter((r) => r.groupName !== undefined && r.matchPackageNames !== undefined)
			.map((r) => r.groupName)
			.filter((g) => !Object.keys(bundles).some((n) => g === `bundle ${n}`));
		expect(orphans).toStrictEqual([]);
	});
});

test('свой renovate.json5: фикстуры Renovate не трогает', () => {
	expect(ownRenovate.ignorePaths ?? []).toContain('fixtures/**');
	// ignorePaths заменяет, а не дополняет config:recommended — node_modules надо вернуть явно.
	expect(ownRenovate.ignorePaths ?? []).toContain('**/node_modules/**');
});

test('renovate.json5: typescript не поднимается на ночные сборки', () => {
	const rule = (ownRenovate.packageRules ?? []).find(
		(r) => JSON.stringify(r.matchPackageNames) === JSON.stringify(['typescript']),
	);
	expect(rule?.allowedVersions).toBeDefined();
	// allowedVersions вида '!/regex/': версия, подходящая под regex, отвергается.
	const m = /^!\/(.*)\/$/.exec(rule?.allowedVersions ?? '');
	expect(m).not.toBeNull();
	const night = new RegExp(m?.[1] ?? '');
	expect(night.test('7.1.0-dev.20261104.1')).toBe(true);
	for (const v of ['7.1.0-beta', '7.1.0-rc', '7.1.0', '7.1.1']) expect(night.test(v)).toBe(false);
});
