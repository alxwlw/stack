import type { Canon } from './canon.ts';
import { planCatalogs } from './catalogs.ts';
import type { Exception } from './config.ts';
import {
	checkDependabotIgnore,
	checkEnginesNode,
	checkInlineVersions,
	checkRenovateIgnore,
} from './deps.ts';
import { planFiles } from './files.ts';
import { applyExceptions, covers, type Drift, type Finding } from './findings.ts';
import { planPackageManager } from './package-manager.ts';

// План дрейфа: всё, что sync умеет закрыть, в порядке применения — файлы, каталоги, packageManager.
export function planRepo(repoRoot: string, canon: Canon): Drift[] {
	return [
		...planFiles(repoRoot, canon),
		...planCatalogs(repoRoot, canon),
		...planPackageManager(repoRoot, canon),
	];
}

export interface SyncResult {
	applied: Drift[];
	held: Finding[];
}

// sync — тот же план, но удержанное исключением не применяется: иначе исключению после sync
// нечего покрывать, и следующий check краснеет на stale-exception. Исключение держит и check, и sync.
export function syncRepo(repoRoot: string, canon: Canon, exceptions: Exception[]): SyncResult {
	const result: SyncResult = { applied: [], held: [] };
	for (const d of planRepo(repoRoot, canon)) {
		const e = exceptions.find((e) => covers(e, d));
		if (e) {
			result.held.push({ ...d, suppressedBy: e });
			continue;
		}
		d.apply();
		result.applied.push(d);
	}
	return result;
}

// Тот же план плюс правила «только отчёт» из deps.ts, пропущенные через исключения.
export function checkRepo(repoRoot: string, canon: Canon, exceptions: Exception[]): Finding[] {
	return applyExceptions(
		[
			...planRepo(repoRoot, canon),
			...checkInlineVersions(repoRoot, canon),
			...checkEnginesNode(repoRoot, canon),
			...checkDependabotIgnore(repoRoot),
			...(canon.bot === 'renovate' ? checkRenovateIgnore(repoRoot) : []),
		],
		exceptions,
	);
}
