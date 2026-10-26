import { applyChanges } from './apply.ts';
import type { Canon } from './canon.ts';
import { planCatalogs } from './catalogs.ts';
import {
	checkDependabot,
	checkEnginesNode,
	checkInlineVersions,
	checkRenovatePreset,
} from './deps.ts';
import { type Exception, type Held, isHeld, resolve } from './exceptions.ts';
import { planFiles } from './files.ts';
import type { Drift, Finding } from './findings.ts';
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
	held: Held<Drift>[];
}

// sync — тот же план, но удержанное исключением не применяется (почему — см. resolve):
// исключение держит и check, и sync, сопоставление у них одно.
export function syncRepo(repoRoot: string, canon: Canon, exceptions: Exception[]): SyncResult {
	const result: SyncResult = { applied: [], held: [] };
	for (const d of resolve(planRepo(repoRoot, canon), exceptions).findings) {
		if (isHeld(d)) result.held.push(d);
		else result.applied.push(d);
	}
	// Правки собираются по файлу: каждый затронутый файл читается и пишется один раз.
	applyChanges(
		repoRoot,
		result.applied.map((d) => d.change),
	);
	return result;
}

// Тот же план плюс правила «только отчёт» из deps.ts, пропущенные через исключения.
export function checkRepo(repoRoot: string, canon: Canon, exceptions: Exception[]): Finding[] {
	const r = resolve(
		[
			...planRepo(repoRoot, canon),
			...checkInlineVersions(repoRoot, canon),
			...checkEnginesNode(repoRoot, canon),
			...checkRenovatePreset(repoRoot),
			...checkDependabot(repoRoot),
		],
		exceptions,
	);
	return [...r.findings, ...r.stale];
}
