import { planCatalogs } from './catalogs.ts';
import type { StackConfig } from './config.ts';
import { checkDependabotIgnore, checkEnginesNode, checkInlineVersions } from './deps.ts';
import { planFiles } from './files.ts';
import { applyExceptions, type Drift, type Finding } from './findings.ts';
import { canonDir } from './manifest.ts';

// План дрейфа: всё, что sync умеет закрыть, в порядке применения — файлы, затем каталоги.
export function planRepo(repoRoot: string, cfg: StackConfig, dir: string = canonDir()): Drift[] {
	return [...planFiles(repoRoot, cfg, dir), ...planCatalogs(repoRoot, cfg, dir)];
}

// Тот же план плюс правила «только отчёт» из deps.ts, пропущенные через исключения.
export function checkRepo(repoRoot: string, cfg: StackConfig, dir: string = canonDir()): Finding[] {
	return applyExceptions(
		[
			...planRepo(repoRoot, cfg, dir),
			...checkInlineVersions(repoRoot, cfg, dir),
			...checkEnginesNode(repoRoot, cfg, dir),
			...checkDependabotIgnore(repoRoot, cfg),
		],
		cfg.exceptions,
	);
}
