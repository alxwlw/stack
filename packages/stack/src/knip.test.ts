import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

import { canonFile, repoDir, runTool, toolJson } from './testkit.ts';

const ROOT = join(import.meta.dir, '..', '..', '..');
const KNIP_BIN = join(ROOT, 'node_modules', '.bin', 'knip');

const PROJECT: Record<string, string> = {
	'package.json': `${JSON.stringify({
		name: 'fixture',
		private: true,
		type: 'module',
		scripts: { lint: 'moon run :lint', py: 'uv run x', other: 'zzztool --x' },
		dependencies: { 'left-pad': '1.3.0' },
	})}\n`,
	'tsconfig.json': JSON.stringify({
		compilerOptions: {
			module: 'nodenext',
			moduleResolution: 'nodenext',
			allowImportingTsExtensions: true,
			noEmit: true,
			strict: true,
		},
		include: ['src'],
	}),
	'src/index.ts':
		"import { used } from './lib.ts';\nimport x from './dupe.ts';\nimport { dd } from './dupe.ts';\nconsole.log(used, x, dd);\n",
	'src/lib.ts':
		'export const used = 1;\nexport const unusedFn = () => 2;\n/** @lintignore */\nexport const tagged = 3;\n',
	'src/dupe.ts': 'export const dd = 1;\nexport default dd;\n',
	'src/orphan.ts': 'export const x = 1;\n',
	'.claude/hook.ts': 'export const y = 1;\n',
	'dist/out.ts': 'export const z = 1;\n',
};

// Отчёт knip в одну отсортированную строку на находку: вид, файл, имя (у массива — имена через |).
function issues(report: { issues: ({ file: string } & Record<string, unknown>)[] }): string[] {
	const lines: string[] = [];
	for (const entry of report.issues) {
		for (const [kind, value] of Object.entries(entry)) {
			if (!Array.isArray(value)) continue;
			for (const item of value as ({ name: string } | { name: string }[])[]) {
				const name = Array.isArray(item) ? item.map((n) => n.name).join('|') : item.name;
				lines.push(`${kind} ${entry.file} ${name}`);
			}
		}
	}
	return lines.sort();
}

// В каноне нет конфига-наследника, потребитель строит свой поверх базы, поэтому тест запускает базу
// через --config. Каждый ключ базы убирает свою находку: ignore — файлы, ignoreBinaries — бинари,
// tags — экспорт с тегом, exclude — вид duplicates. Рядом лежит контроль того же вида (орфан, чужой
// бинарь, неиспользуемый экспорт), он обязан найтись; сравнивается полный список находок.
test('канон knip: ignore, ignoreBinaries, tags и exclude убирают своё, контроли того же вида находятся', () => {
	const dir = repoDir({ ...PROJECT, 'knip.base.json': canonFile('knip.base.json') });
	try {
		const run = runTool(KNIP_BIN, ['--config', 'knip.base.json', '--reporter', 'json'], dir);
		expect(run.status, run.ctx).toBe(1);
		expect(issues(toolJson(run))).toStrictEqual([
			'binaries package.json zzztool',
			'dependencies package.json left-pad',
			'exports src/lib.ts unusedFn',
			'files src/orphan.ts src/orphan.ts',
		]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 30_000);
