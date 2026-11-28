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
import { guardrailsGroup } from './guardrails-rule.ts';
import { checkMoonToolchains, checkMoonV1Toolchain } from './moon-toolchains.ts';
import { checkMoonDefaultBranch, planMoonDefaultBranch } from './moon-workspace.ts';
import { planPackageManager } from './package-manager.ts';
import { peersGroup } from './peers-rule.ts';
import { prBase } from './pr-base.ts';
import { planReleaseAgeExcludes } from './release-age.ts';
import { loadRepo, type Repo } from './repo.ts';
import { repoRulesGroup } from './repo-rules-rule.ts';
import { planRules, reportRules, type RuleTable } from './rule.ts';
import { type GroupPorts, type RuleGroupModule, runGroups } from './rule-group.ts';
import type { RuleGroup } from './rule-settings.ts';
import { checkSeedExtends } from './seed-extends.ts';
import { planToolchainPins } from './toolchain-pins-rule.ts';

/** Таблица правил вне групп: имя из RULE_NAMES → модуль; имя без записи не компилируется. */
export const RULE_MODULES = {
	'release-age-exclude': { plan: (repo, canon) => planReleaseAgeExcludes(repo, canon) },
	'package-manager': { plan: (repo, canon) => planPackageManager(repo, canon) },
	'inline-version': { report: (repo, canon) => checkInlineVersions(repo, canon) },
	'engines-node': { report: (repo, canon) => checkEnginesNode(repo, canon) },
	'renovate-preset': {
		report: (repo, canon, params) => checkRenovatePreset(repo, canon, params.preset),
	},
	'dependabot-config': { report: (repo) => checkDependabot(repo) },
	'canon-not-extended': { report: (repo, canon) => checkSeedExtends(repo, canon) },
	'moon-toolchain-version': { report: (repo, canon) => checkMoonToolchains(repo, canon) },
	'moon-v1-toolchain': { report: (repo) => checkMoonV1Toolchain(repo) },
	'moon-default-branch': {
		plan: (repo) => planMoonDefaultBranch(repo),
		report: (repo) => checkMoonDefaultBranch(repo),
	},
	'toolchain-pin': {
		plan: (repo, canon, _params, exceptions) => planToolchainPins(repo, canon, exceptions),
	},
} satisfies RuleTable;

// План дрейфа: всё, что sync умеет закрыть, в порядке применения — файлы, каталоги, затем правки включённых
// правил в порядке RULE_NAMES (release-age, packageManager, ветка по умолчанию moon, копии пинов тулчейна).
// Правки одного файла друг от друга не зависят: sync применяет любое их подмножество. Исключения нужны
// правилу копий пинов: удержанный .prototools меняет, с какими пинами оно сверяется; сами находки гасит resolve.
export function plan(repo: Repo, canon: Canon, exceptions: readonly Exception[] = []): Drift[] {
	return [
		...planFiles(repo, canon),
		...planCatalogs(repo, canon),
		...planRules(RULE_MODULES, repo, canon, exceptions),
	];
}

// Находки над снимком репозитория в порядке: план, нечитаемые файлы загрузчика, находки «только отчёт»
// включённых правил в порядке RULE_NAMES. Находки групп правил добавляет checkRepo; все вместе проходят
// через исключения, после них идут протухшие исключения.
export function check(repo: Repo, canon: Canon, exceptions: Exception[]): Finding[] {
	return resolveWith(repo, canon, exceptions, []);
}

function resolveWith(
	repo: Repo,
	canon: Canon,
	exceptions: Exception[],
	groupFindings: Finding[],
): Finding[] {
	const r = resolve(
		[
			...plan(repo, canon, exceptions),
			...repo.unreadable,
			...reportRules(RULE_MODULES, repo, canon),
			...groupFindings,
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

/** Таблица групп правил: имя из RULE_GROUPS → функция группы; имя без записи не компилируется. */
export const RULE_GROUP_MODULES = {
	peers: peersGroup,
	'repo-rules': repoRulesGroup,
	guardrails: guardrailsGroup,
} satisfies Record<RuleGroup, RuleGroupModule<never>>;
/** Порты `checkRepo`: порт группы выводится из её функции, нужен только включённой группе. */
export type CheckPorts = GroupPorts<typeof RULE_GROUP_MODULES>;
/** Входы прогона для групп правил: порты, окружение и значение --base. */
export interface CheckInputs {
	ports: CheckPorts;
	env: NodeJS.ProcessEnv;
	base?: string;
}
/** Итог check: находки (блокируют, если не удержаны) и пометки (выход не меняют). */
export interface CheckReport {
	findings: Finding[];
	notes: string[];
}

// Группы обходит runGroups в порядке canon.rules: каждая читает свой порт и отдаёт находки и пометки;
// включённая группа без порта — ошибка. Находки групп проходят тот же resolve, что и правила над снимком.
export function checkRepo(
	repoRoot: string,
	canon: Canon,
	exceptions: Exception[],
	inputs: CheckInputs = { ports: {}, env: {} },
): CheckReport {
	const repo = loadRepo(repoRoot, canon);
	// База PR — одно значение на прогон: группы читают её готовой.
	const ctx = { repoRoot, repo, env: inputs.env, prBase: prBase(inputs.base, inputs.env), canon };
	const groups = runGroups(RULE_GROUP_MODULES, canon.rules, ctx, inputs.ports);
	return {
		findings: resolveWith(repo, canon, exceptions, groups.findings),
		notes: groups.notes,
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
