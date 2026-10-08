import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'bun:test';
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
