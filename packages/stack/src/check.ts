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
import { checkMoonToolchains, checkMoonV1Toolchain } from './moon-toolchains.ts';
import { checkMoonDefaultBranch, planMoonDefaultBranch } from './moon-workspace.ts';
import { planPackageManager } from './package-manager.ts';
import { type PeersOutcome, peersOutcome, type PeersReader } from './peers.ts';
import { checkPeers } from './peers-rule.ts';
import { planReleaseAgeExcludes } from './release-age.ts';
import { loadRepo, LOCKFILE, type Repo } from './repo.ts';
import { readRepoRules, type RepoRulesOutcome, type RepoRulesPort } from './repo-rules.ts';
import { checkRepoRules, repoRulesNotes } from './repo-rules-rule.ts';
import { checkSeedExtends } from './seed-extends.ts';
import { planToolchainPins } from './toolchain-pins-rule.ts';

// План дрейфа: всё, что sync умеет закрыть, в порядке применения — файлы, каталоги, release-age,
// packageManager, ветка по умолчанию moon, копии пинов тулчейна. Правки одного файла друг от друга не
// зависят: sync применяет любое их подмножество. Исключения нужны правилу копий пинов: удержанный
// .prototools меняет, с какими пинами оно сверяется; сами находки гасит resolve.
export function plan(repo: Repo, canon: Canon, exceptions: readonly Exception[] = []): Drift[] {
	return [
		...planFiles(repo, canon),
		...planCatalogs(repo, canon),
		...planReleaseAgeExcludes(repo, canon),
		...planPackageManager(repo, canon),
		...planMoonDefaultBranch(repo),
		...planToolchainPins(repo, canon, exceptions),
	];
}

// Находки в порядке: план, нечитаемые файлы загрузчика, правила «только отчёт» из deps.ts, засевы и moon,
// правила групп peers и repo-rules, если они включены (в этом порядке); затем протухшие исключения.
// Все они проходят через исключения. peers — исход `pnpm peers check`, repoRules — исход двух вызовов
// repo-rules; оба получает checkRepo.
export function check(
	repo: Repo,
	canon: Canon,
	exceptions: Exception[],
	peers?: PeersOutcome,
	repoRules?: RepoRulesOutcome,
): Finding[] {
	const r = resolve(
		[
			...plan(repo, canon, exceptions),
			...repo.unreadable,
			...checkInlineVersions(repo, canon),
			...checkEnginesNode(repo, canon),
			...checkRenovatePreset(repo),
			...checkDependabot(repo),
			...checkSeedExtends(repo, canon),
			...checkMoonToolchains(repo, canon),
			...checkMoonV1Toolchain(repo),
			...checkMoonDefaultBranch(repo),
			...(canon.rules.includes('peers') ? checkPeers(repo, peers) : []),
			...(canon.rules.includes('repo-rules') ? checkRepoRules(repoRules) : []),
		],
		exceptions,
	);
	return [...r.findings, ...r.stale];
}

export function planRepo(
	repoRoot: string,
	canon: Canon,
	exceptions: readonly Exception[] = [],
): Drift[] {
	return plan(loadRepo(repoRoot, canon), canon, exceptions);
}

/** Порты `checkRepo`: каждый нужен только своей группе. */
export interface CheckPorts {
	peers?: PeersReader;
	repoRules?: RepoRulesPort;
}
/** Итог check: находки (блокируют, если не удержаны) и пометки (выход не меняют). */
export interface CheckReport {
	findings: Finding[];
	notes: string[];
}

// pnpm запускается, только если группа peers включена и лок есть: без лока правило отвечает само.
// repo-rules — только если включена группа: два вызова через порт, пометки идут отдельно от находок.
export function checkRepo(
	repoRoot: string,
	canon: Canon,
	exceptions: Exception[],
	ports: CheckPorts = {},
): CheckReport {
	const repo = loadRepo(repoRoot, canon);
	let peers: PeersOutcome | undefined;
	if (canon.rules.includes('peers') && repo.paths.has(LOCKFILE)) {
		if (ports.peers === undefined) throw new Error('checkRepo: peers group needs a PeersReader');
		peers = peersOutcome(ports.peers(repoRoot));
	}
	let repoRules: RepoRulesOutcome | undefined;
	if (canon.rules.includes('repo-rules')) {
		if (ports.repoRules === undefined) {
			throw new Error('checkRepo: repo-rules group needs a RepoRulesPort');
		}
		repoRules = readRepoRules(repoRoot, ports.repoRules);
	}
	return {
		findings: check(repo, canon, exceptions, peers, repoRules),
		notes: repoRulesNotes(repoRules),
	};
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
	for (const d of resolve(plan(repo, canon, exceptions), exceptions).findings) {
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
