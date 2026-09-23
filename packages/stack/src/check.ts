import type { Canon } from './canon.ts';
import { planCatalogs } from './catalogs.ts';
import type { Exception } from './config.ts';
import { checkDependabotIgnore, checkEnginesNode, checkInlineVersions } from './deps.ts';
import { planFiles } from './files.ts';
import { applyExceptions, type Drift, type Finding } from './findings.ts';

// План дрейфа: всё, что sync умеет закрыть, в порядке применения — файлы, затем каталоги.
export function planRepo(repoRoot: string, canon: Canon): Drift[] {
	return [...planFiles(repoRoot, canon), ...planCatalogs(repoRoot, canon)];
}

// Тот же план плюс правила «только отчёт» из deps.ts, пропущенные через исключения.
export function checkRepo(repoRoot: string, canon: Canon, exceptions: Exception[]): Finding[] {
	return applyExceptions(
		[
			...planRepo(repoRoot, canon),
			...checkInlineVersions(repoRoot, canon),
			...checkEnginesNode(repoRoot, canon),
			...checkDependabotIgnore(repoRoot),
		],
		exceptions,
	);
}
