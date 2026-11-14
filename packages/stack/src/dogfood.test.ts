import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'bun:test';
import JSON5 from 'json5';
import { parse as parseYaml } from 'yaml';

import { releasePackages } from '../../../scripts/release.ts';
import { loadCanon, readCanonSource } from './canon.ts';
import { canonFile } from './testkit.ts';

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

test.each(['check.yml', 'sync.yml'])(
	'%s: setup получает реестр только при непустом registry',
	(name) => {
		const job = Object.values(readWf(name).jobs ?? {})[0];
		const setup = job?.steps?.find((s) =>
			s.uses?.startsWith('alxwlw/stack/.github/actions/setup@'),
		);
		expect(setup?.with?.registry).toBe('${{ inputs.registry }}');
		expect(setup?.with?.['registry-token-var']).toBe(
			"${{ inputs.registry != '' && 'STACK_REGISTRY_TOKEN' || '' }}",
		);
		expect(job?.env?.STACK_REGISTRY_TOKEN).toBe('${{ secrets.registry-token }}');
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

// sync.yml ждёт версию в реестре до bunx: rollout стартует сразу после publish, и в 1.6.0 все
// sync упали на «No version matching»; в 1.7.0 — pnpm install на tsconfig, опубликованной позже
// stack. Шаг гоняется в bash с curl-заглушкой, отдающей тело по имени пакета, а не сверяется текстом.
type SyncStep = { name?: string; run?: string; env?: Record<string, string> };
const syncSteps = (
	parseYaml(readFileSync(join(ROOT, '.github', 'workflows', 'sync.yml'), 'utf8')) as {
		jobs?: Record<string, { steps?: SyncStep[] }>;
	}
).jobs?.sync?.steps;
const waitIdx = syncSteps?.findIndex((s) => s.name === 'дождаться версии в npm') ?? -1;
const waitStep = syncSteps?.[waitIdx];

// Пакеты, без которых sync не обойдётся: stack (bunx) и @alxwlw/*-записи каталога (pnpm install).
// Остальные опубликованные (repo-rules) sync не тянет; их ожидание живёт в job publish.
const catalogNames = new Set(
	Object.values(readCanonSource().catalogs).flatMap((group) =>
		Object.keys(group).filter((n) => n.startsWith('@alxwlw/')),
	),
);
const NEEDED = [
	...new Set([
		'stack',
		...releasePackages(ROOT)
			.filter((p) => catalogNames.has(p.name))
			.map((p) => p.dir),
	]),
].toSorted();

/** `bodies` — тело ответа реестра по имени пакета без скоупа; пакета нет в карте — curl падает. */
function runWait(
	bodies: Record<string, string>,
	attempts: string,
): { status: number | null; calls: string[]; out: string } {
	const dir = mkdtempSync(join(tmpdir(), 'sync-wait-'));
	const calls = join(dir, 'calls');
	for (const [p, body] of Object.entries(bodies)) writeFileSync(join(dir, `${p}.json`), body);
	writeFileSync(
		join(dir, 'curl'),
		`#!/usr/bin/env bash\np="\${!#}"; p="\${p##*%2f}"\necho "$p" >> '${calls}'\ncat '${dir}'/"$p.json"\n`,
	);
	chmodSync(join(dir, 'curl'), 0o755);
	const res = spawnSync('bash', ['-eo', 'pipefail', '-c', waitStep?.run ?? 'exit 99'], {
		env: {
			...process.env,
			PATH: `${dir}:${process.env.PATH}`,
			VERSION: '1.2.3',
			PACKAGES: waitStep?.env?.PACKAGES ?? '',
			ATTEMPTS: attempts,
			INTERVAL: '0',
		},
		encoding: 'utf8',
	});
	const n = existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean) : [];
	rmSync(dir, { recursive: true, force: true });
	return { status: res.status, calls: n, out: res.stdout };
}

const has = '{"versions":{"1.2.2":{},"1.2.3":{}}}';
// dist-tags с той же строкой не должны сойти за версию.
const lacks = '{"dist-tags":{"latest":"1.2.3"},"versions":{"1.2.2":{}}}';
const all = (body: string) => Object.fromEntries(NEEDED.map((p) => [p, body]));

test('sync.yml ждёт версию в npm до bunx и с тем же VERSION', () => {
	expect(waitIdx).toBeGreaterThanOrEqual(0);
	const bunxIdx =
		syncSteps?.findIndex((s) => s.run?.includes('bunx "@alxwlw/stack@$VERSION"')) ?? -1;
	expect(bunxIdx).toBeGreaterThan(waitIdx);
	expect(waitStep?.env?.VERSION).toBe(syncSteps?.[bunxIdx]?.env?.VERSION);
	expect(waitStep?.env?.VERSION).toBe('${{ inputs.version }}');
});

test('шаг ожидания ждёт stack и пакеты каталога, а не все опубликованные', () => {
	expect(NEEDED.length).toBeGreaterThan(1);
	expect((waitStep?.env?.PACKAGES ?? '').split(' ').toSorted()).toEqual(NEEDED);
	expect(NEEDED).not.toContain('repo-rules');
});

test('шаг ожидания — короткая страховка: ATTEMPTS 12', () => {
	expect(waitStep?.env?.ATTEMPTS).toBe('12');
});

test('шаг ожидания выходит на первой попытке, когда все версии уже в реестре', () => {
	const r = runWait(all(has), '3');
	expect(r.status).toBe(0);
	expect(r.calls.toSorted()).toEqual(NEEDED);
});

test('шаг ожидания падает после ATTEMPTS попыток и называет пакет, которого нет', () => {
	const r = runWait({ ...all(has), tsconfig: lacks }, '3');
	expect(r.status).toBe(1);
	// Найденные пакеты не опрашиваются повторно: первый круг — все, дальше — только tsconfig.
	expect(r.calls.filter((p) => p === 'tsconfig')).toHaveLength(3);
	expect(r.calls).toHaveLength(NEEDED.length + 2);
	expect(r.out).toContain('tsconfig');
});

test('шаг ожидания не принимает упавший запрос к реестру за наличие версии', () => {
	// Тела для oxlint-config нет — заглушка curl выходит с ошибкой, как curl -f на 404/5xx.
	const { 'oxlint-config': _, ...rest } = all(has);
	const r = runWait(rest, '2');
	expect(r.status).toBe(1);
	expect(r.out).toContain('oxlint-config');
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

test('renovate: связки libs бампаются одной веткой', () => {
	const rules = ownRenovate.packageRules ?? [];
	const canonIdx = rules.findIndex((r) => r.groupName === 'canon pins');
	expect(canonIdx).toBeGreaterThanOrEqual(0);
	const bundles = [['@opentelemetry/**'], ['@nats-io/**'], ['@prisma/**', 'prisma']];
	for (const names of bundles) {
		const idx = rules.findIndex(
			(r) => JSON.stringify(r.matchPackageNames) === JSON.stringify(names),
		);
		// Правило связки стоит ниже canon pins: Renovate применяет совпавшие правила по порядку, последнее побеждает.
		expect([names, idx > canonIdx]).toEqual([names, true]);
		expect([names, typeof rules[idx]?.groupName]).toEqual([names, 'string']);
		expect([names, rules[idx]?.separateMajorMinor]).toEqual([names, false]);
	}
	// Три связки — три разных группы: общая группа слила бы мажор NATS с OTel.
	const groups = new Set(
		rules.filter((r, i) => i > canonIdx && r.separateMajorMinor === false).map((r) => r.groupName),
	);
	expect(groups.size).toBe(3);
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

// Шаг доводки: репо-свой скрипт stack:post-sync. bash шага гоняется в каталоге «потребителя» с
// заглушками proto и pnpm в PATH (порядок вызовов пишется в один файл); node настоящий.
const postIdx = syncSteps?.findIndex((s) => s.name === 'доводка репозитория') ?? -1;
const postStep = syncSteps?.[postIdx] as (SyncStep & { if?: string }) | undefined;

function runPostSync(
	pkg: object | null,
	failing?: 'proto' | 'pnpm',
): { status: number | null; calls: string[] } {
	const dir = mkdtempSync(join(tmpdir(), 'sync-post-'));
	const stubs = join(dir, 'bin');
	const work = join(dir, 'repo');
	const calls = join(dir, 'calls');
	mkdirSync(stubs);
	mkdirSync(work);
	if (pkg) writeFileSync(join(work, 'package.json'), JSON.stringify(pkg));
	for (const tool of ['proto', 'pnpm']) {
		writeFileSync(
			join(stubs, tool),
			`#!/usr/bin/env bash\necho "${tool} $*|$VERSION" >> '${calls}'\n${failing === tool ? 'exit 1' : 'exit 0'}\n`,
		);
		chmodSync(join(stubs, tool), 0o755);
	}
	const res = spawnSync('bash', ['-eo', 'pipefail', '-c', postStep?.run ?? 'exit 99'], {
		cwd: work,
		env: { ...process.env, PATH: `${stubs}:${process.env.PATH}`, VERSION: '1.2.3' },
		encoding: 'utf8',
	});
	const n = existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean) : [];
	rmSync(dir, { recursive: true, force: true });
	return { status: res.status, calls: n };
}

test('sync.yml: шаг доводки стоит после pnpm install и до проверки изменений', () => {
	const installIdx =
		syncSteps?.findIndex((s) => s.run?.includes('pnpm install --no-frozen-lockfile')) ?? -1;
	const diffIdx = syncSteps?.findIndex((s) => (s as { id?: string }).id === 'diff') ?? -1;
	expect(installIdx).toBeGreaterThanOrEqual(0);
	expect(postIdx).toBeGreaterThan(installIdx);
	expect(diffIdx).toBeGreaterThan(postIdx);
	expect(postStep?.if).toBeUndefined();
	expect(postStep?.env?.VERSION).toBe('${{ inputs.version }}');
});

test('шаг доводки: proto install, затем pnpm run stack:post-sync с VERSION, когда скрипт есть', () => {
	const r = runPostSync({ scripts: { 'stack:post-sync': 'echo hi' } });
	expect(r.status).toBe(0);
	expect(r.calls).toEqual(['proto install|1.2.3', 'pnpm run stack:post-sync|1.2.3']);
});

test('шаг доводки молчит без скрипта и без package.json', () => {
	for (const pkg of [{ scripts: { build: 'x' } }, {}, null]) {
		const r = runPostSync(pkg);
		expect(r.status).toBe(0);
		expect(r.calls).toEqual([]);
	}
});

test('падение хука роняет шаг', () => {
	const r = runPostSync({ scripts: { 'stack:post-sync': 'x' } }, 'pnpm');
	expect(r.status).not.toBe(0);
});

test('падение proto install роняет шаг до хука', () => {
	const r = runPostSync({ scripts: { 'stack:post-sync': 'x' } }, 'proto');
	expect(r.status).not.toBe(0);
	expect(r.calls).toEqual(['proto install|1.2.3']);
});
