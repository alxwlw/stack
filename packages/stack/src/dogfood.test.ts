import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'bun:test';
import JSON5 from 'json5';
import { parse as parseYaml } from 'yaml';

import { releasePackages } from '../../../scripts/release.ts';
import { loadCanon, loadCatalogs } from './canon.ts';
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
	const canonDev = loadCatalogs().dev ?? {};
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

// Канон-файл потребителя и корневой reusable должны сходиться по контракту: with — только объявленные
// inputs, secrets — только объявленные secrets. Иначе у потребителя workflow падает при запуске.
test('канон-файл workflow-renovate.yml зовёт корневой reusable @v1 в рамках его inputs и secrets', () => {
	type Workflow = {
		on?: {
			workflow_call?: { inputs?: Record<string, unknown>; secrets?: Record<string, unknown> };
		};
		jobs?: Record<
			string,
			{ uses?: string; with?: Record<string, unknown>; secrets?: Record<string, string> }
		>;
	};
	const reusable = parseYaml(
		readFileSync(join(ROOT, '.github', 'workflows', 'renovate.yml'), 'utf8'),
	) as Workflow;
	const consumer = parseYaml(canonFile('.github/workflows/renovate.yml')) as Workflow;
	const job = consumer.jobs?.renovate;
	expect(job?.uses).toBe('alxwlw/stack/.github/workflows/renovate.yml@v1');
	const inputs = Object.keys(reusable.on?.workflow_call?.inputs ?? {});
	const secrets = Object.keys(reusable.on?.workflow_call?.secrets ?? {});
	expect(inputs).toContain('log-level');
	expect(secrets).toContain('token');
	const passedWith = Object.keys(job?.with ?? {});
	const passedSecrets = Object.keys(job?.secrets ?? {});
	// Непустые: пустое множество тривиально входит в любое, и тест молчал бы.
	expect(passedWith).not.toEqual([]);
	expect(passedSecrets).not.toEqual([]);
	for (const k of passedWith) expect(inputs).toContain(k);
	for (const k of passedSecrets) expect(secrets).toContain(k);
	expect(job?.secrets?.token).toBe('${{ secrets.RENOVATE_TOKEN }}');
});

// Канон-файл stack-sync.yml зовёт reusable sync.yml: каждый ключ with должен быть объявленным input,
// иначе rollout у потребителя падает до первого шага.
test('канон-файл workflow-stack-sync.yml передаёт reusable sync.yml только объявленные inputs, включая base', () => {
	type Workflow = {
		on?: { workflow_call?: { inputs?: Record<string, unknown> } };
		jobs?: Record<string, { uses?: string; with?: Record<string, unknown> }>;
	};
	const reusable = parseYaml(
		readFileSync(join(ROOT, '.github', 'workflows', 'sync.yml'), 'utf8'),
	) as Workflow;
	const consumer = parseYaml(canonFile('.github/workflows/stack-sync.yml')) as Workflow;
	const job = consumer.jobs?.sync;
	expect(job?.uses).toBe('alxwlw/stack/.github/workflows/sync.yml@v1');
	const inputs = Object.keys(reusable.on?.workflow_call?.inputs ?? {});
	const passed = Object.keys(job?.with ?? {});
	expect(passed).toContain('base');
	for (const k of passed) expect(inputs).toContain(k);
	expect(job?.with?.base).toBe("${{ vars.STACK_SYNC_BASE || '' }}");
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
	Object.values(loadCatalogs()).flatMap((group) =>
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
		matchFileNames?: string[];
		matchPackageNames?: string[];
		enabled?: boolean;
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

test('свой renovate.json5: фикстуры Renovate не трогает', () => {
	expect(ownRenovate.ignorePaths ?? []).toContain('fixtures/**');
	// ignorePaths заменяет, а не дополняет config:recommended — node_modules надо вернуть явно.
	expect(ownRenovate.ignorePaths ?? []).toContain('**/node_modules/**');
});
