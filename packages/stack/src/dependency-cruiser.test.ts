import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

import { canonFile, repoDir, runTool, toolJson } from './testkit.ts';

const ROOT = join(import.meta.dir, '..', '..', '..');
const DEPCRUISE_BIN = join(ROOT, 'node_modules', '.bin', 'depcruise');

const TREE: Record<string, string> = {
	'package.json': '{ "name": "fixture", "private": true, "type": "module" }\n',
	// Канон задаёт options.tsConfig.fileName: без tsconfig.json depcruise падает с TS5083.
	'tsconfig.json': JSON.stringify({
		compilerOptions: {
			target: 'es2022',
			module: 'nodenext',
			moduleResolution: 'nodenext',
			allowImportingTsExtensions: true,
			noEmit: true,
			strict: true,
		},
		include: ['apps', 'packages'],
	}),
	'apps/web/index.ts':
		"import { api } from '../api/index.ts';\nimport { util } from './util.ts';\nexport const web = api + util;\n",
	'apps/web/util.ts': 'export const util = 1;\n',
	'apps/api/index.ts': 'export const api = 1;\n',
	'apps/__e2e__/run.ts': "import { web } from '../web/index.ts';\nexport const run = web;\n",
	'packages/core/index.ts':
		"import { api } from '../../apps/api/index.ts';\nexport const core = api;\n",
	'packages/core/a.ts':
		"import { b } from './b.ts';\nexport const a = 1;\nexport const ab = () => b;\n",
	'packages/core/b.ts':
		"import { a } from './a.ts';\nexport const b = 2;\nexport const ba = () => a;\n",
};

// Закреплены три правила, которые срабатывают на малом дереве: no-app-to-app (обратная ссылка на
// своё app и исключение для e2e), no-package-to-app и no-circular. Остальные правила канона целятся
// в node_modules или core, а канон ограничивает граф includeOnly каталогами apps и packages, поэтому
// на таком входе они молчат и тест их не закрепляет. Сравнивается полный отсортированный список
// нарушений: лишняя запись про своё app или e2e краснит тест так же, как пропавшая.
test('канон dependency-cruiser: app→app, package→app и цикл ловятся; своё app и e2e — нет', () => {
	const dir = repoDir({
		...TREE,
		'.dependency-cruiser.base.cjs': canonFile('.dependency-cruiser.base.cjs'),
	});
	try {
		const run = runTool(
			DEPCRUISE_BIN,
			['apps', 'packages', '--config', '.dependency-cruiser.base.cjs', '--output-type', 'json'],
			dir,
		);
		// json-репортер отдаёт 0 при любых нарушениях; не 0 — ошибка конфигурации или разбора.
		expect(run.status, run.ctx).toBe(0);
		type Violation = { rule: { name: string; severity: string }; from: string; to: string };
		const found = toolJson<{ summary: { violations: Violation[] } }>(run)
			.summary.violations.map((v) => `${v.rule.severity} ${v.rule.name} ${v.from} → ${v.to}`)
			.sort();
		expect(found).toStrictEqual([
			'error no-app-to-app apps/web/index.ts → apps/api/index.ts',
			'error no-circular packages/core/a.ts → packages/core/b.ts',
			'error no-package-to-app packages/core/index.ts → apps/api/index.ts',
		]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 30_000);
