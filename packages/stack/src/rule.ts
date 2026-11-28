import type { Canon } from './canon.ts';
import type { Exception } from './exceptions.ts';
import type { Drift, Finding } from './findings.ts';
import type { Repo } from './repo.ts';
import { RULE_NAMES, type RuleName, type RuleParams } from './rule-settings.ts';

/** Встроенное правило вне групп: правка, которую sync умеет закрыть (`plan`), и/или находки «только отчёт» (`report`). */
export interface RuleModule<P> {
	plan?: (repo: Repo, canon: Canon, params: P, exceptions: readonly Exception[]) => Drift[];
	report?: (repo: Repo, canon: Canon, params: P) => Finding[];
}

/** Таблица правил: имя из RULE_NAMES → модуль; имя без записи не компилируется. */
export type RuleTable = { [K in RuleName]: RuleModule<RuleParams[K]> };

type AnyModule = RuleModule<RuleParams[RuleName]>;

// Обход идёт по RULE_NAMES, а не по ключам настроек: порядок находок не зависит от порядка в JSON.
// Правило, которого нет в canon.settings.rules, выключено.
function walk<T>(
	table: RuleTable,
	canon: Canon,
	run: (mod: AnyModule, params: RuleParams[RuleName]) => T[] | undefined,
): T[] {
	const out: T[] = [];
	for (const name of RULE_NAMES) {
		const params = canon.settings.rules[name];
		if (params === undefined) continue;
		// TS не связывает имя с типом параметров его записи (коррелированный union): params взят из настроек
		// по тому же имени, поэтому он принадлежит именно этому правилу.
		out.push(...(run(table[name] as AnyModule, params) ?? []));
	}
	return out;
}

export function planRules(
	table: RuleTable,
	repo: Repo,
	canon: Canon,
	exceptions: readonly Exception[],
): Drift[] {
	return walk(table, canon, (mod, params) => mod.plan?.(repo, canon, params, exceptions));
}

export function reportRules(table: RuleTable, repo: Repo, canon: Canon): Finding[] {
	return walk(table, canon, (mod, params) => mod.report?.(repo, canon, params));
}
