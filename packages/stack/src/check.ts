import { applyChanges } from './apply.ts';
import type { Canon } from './canon.ts';
import { planCatalogs } from './catalogs.ts';
import {
	checkDependabot,
	checkEnginesNode,
	checkInlineVersions,
	checkRenovatePreset,
} from './deps.ts';
import { allowedLine, type Exception, type Held, isHeld, resolve } from './exceptions.ts';
import { planFiles } from './files.ts';
import type { Drift, Finding } from './findings.ts';
import { checkMoonToolchains } from './moon-toolchains.ts';
import { checkMoonDefaultBranch, planMoonDefaultBranch } from './moon-workspace.ts';
import { planPackageManager } from './package-manager.ts';
import { planReleaseAgeExcludes } from './release-age.ts';
import { loadRepo, type Repo } from './repo.ts';

// План дрейфа: всё, что sync умеет закрыть, в порядке применения — файлы, каталоги, release-age,
// packageManager, ветка по умолчанию moon. Правки одного файла друг от друга не зависят: sync применяет любое их подмножество.
export function plan(repo: Repo, canon: Canon): Drift[] {
	return [
		...planFiles(repo, canon),
		...planCatalogs(repo, canon),
		...planReleaseAgeExcludes(repo, canon),
		...planPackageManager(repo, canon),
		...planMoonDefaultBranch(repo),
	];
}

// Находки в порядке: план, нечитаемые файлы загрузчика, правила «только отчёт» из deps.ts; затем
// протухшие исключения. Все они проходят через исключения.
export function check(repo: Repo, canon: Canon, exceptions: Exception[]): Finding[] {
	const r = resolve(
		[
			...plan(repo, canon),
			...repo.unreadable,
			...checkInlineVersions(repo, canon),
			...checkEnginesNode(repo, canon),
			...checkRenovatePreset(repo),
			...checkDependabot(repo),
			...checkMoonToolchains(repo, canon),
			...checkMoonDefaultBranch(repo),
		],
		exceptions,
	);
	return [...r.findings, ...r.stale];
}

export function planRepo(repoRoot: string, canon: Canon): Drift[] {
	return plan(loadRepo(repoRoot, canon), canon);
}

export function checkRepo(repoRoot: string, canon: Canon, exceptions: Exception[]): Finding[] {
	return check(loadRepo(repoRoot, canon), canon, exceptions);
}

export interface SyncResult {
	applied: Drift[];
	held: Held<Drift>[];
}

// sync — тот же план, но удержанное исключением не применяется (почему — см. resolve):
// исключение держит и check, и sync, сопоставление у них одно. Диск читается один раз, загрузчиком:
// применитель берёт текущее содержимое из того же снимка.
export function syncRepo(repoRoot: string, canon: Canon, exceptions: Exception[]): SyncResult {
	const repo = loadRepo(repoRoot, canon);
	const result: SyncResult = { applied: [], held: [] };
	for (const d of resolve(plan(repo, canon), exceptions).findings) {
		if (isHeld(d)) result.held.push(d);
		else result.applied.push(d);
	}
	// Правки собираются по файлу: применитель пишет файл не больше одного раза.
	applyChanges(
		repoRoot,
		result.applied.map((d) => d.change),
		repo.files,
	);
	return result;
}

// Строки вывода sync: удержанные — в stderr, правки и итог — в stdout. Общее для `stack sync` и `stack sync-pr`.
export function syncOutput(result: SyncResult): { stdout: string[]; stderr: string[] } {
	return {
		stderr: result.held.map((h) => allowedLine(h)),
		stdout: [
			...result.applied.map((d) => d.fix),
			`canon ${result.applied.length === 0 ? 'already up to date' : 'applied'}`,
		],
	};
}
