import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'bun:test';
import JSON5 from 'json5';
import { parse as parseYaml } from 'yaml';

import { canonDir, loadCatalogs } from './canon.ts';

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
	const canon = readFileSync(join(canonDir(), 'files', 'oxfmtrc.jsonc'), 'utf8');
	expect(root).toBe(canon);
});

test('корневой .prototools — строки-пины совпадают с canon/files/prototools', () => {
	const root = pinLines(readFileSync(join(ROOT, '.prototools'), 'utf8'));
	const canon = pinLines(readFileSync(join(canonDir(), 'files', 'prototools'), 'utf8'));
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
	const pin = /^pnpm\s*=\s*"([^"]+)"/m.exec(
		readFileSync(join(canonDir(), 'files', 'prototools'), 'utf8'),
	)?.[1];
	expect(pin).toBeDefined();
	expect(pkg.packageManager).toBe(`pnpm@${pin}`);
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
	const consumer = parseYaml(
		readFileSync(join(canonDir(), 'files', 'workflow-renovate.yml'), 'utf8'),
	) as Workflow;
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
	const consumer = parseYaml(
		readFileSync(join(canonDir(), 'files', 'workflow-stack-sync.yml'), 'utf8'),
	) as Workflow;
	const job = consumer.jobs?.sync;
	expect(job?.uses).toBe('alxwlw/stack/.github/workflows/sync.yml@v1');
	const inputs = Object.keys(reusable.on?.workflow_call?.inputs ?? {});
	const passed = Object.keys(job?.with ?? {});
	expect(passed).toContain('base');
	for (const k of passed) expect(inputs).toContain(k);
	expect(job?.with?.base).toBe("${{ vars.STACK_SYNC_BASE || '' }}");
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

test('свой renovate.json5: канон, корень и фикстуры — одна группа canon pins', () => {
	const group = (ownRenovate.packageRules ?? []).find((r) => r.groupName === 'canon pins');
	for (const f of [
		'packages/stack/canon/files/prototools',
		'packages/stack/canon/catalogs.json',
		'.prototools',
		'pnpm-workspace.yaml',
		'package.json',
		'fixtures/node/.prototools',
		'fixtures/node/pnpm-workspace.yaml',
		'fixtures/contracts/.prototools',
		'fixtures/contracts/pnpm-workspace.yaml',
		'fixtures/infra/.prototools',
	]) {
		expect(existsSync(join(ROOT, f))).toBe(true);
		expect((group?.matchFileNames ?? []).some((g) => new Bun.Glob(g).match(f))).toBe(true);
	}
	// Лишний match*/exclude* сузил бы группу: часть файлов ушла бы из canon pins в отдельные PR.
	expect(Object.keys(group ?? {}).filter((k) => /^(match|exclude)/.test(k))).toEqual([
		'matchFileNames',
	]);
});

test('свой renovate.json5: inline-версия фикстуры под исключением не трогается', () => {
	expect(ownRenovate.ignorePaths ?? []).toContain('fixtures/node/packages/**');
	// ignorePaths заменяет, а не дополняет config:recommended — node_modules надо вернуть явно.
	expect(ownRenovate.ignorePaths ?? []).toContain('**/node_modules/**');
});
