import type { Finding } from './findings.ts';
import type { PrBase } from './pr-base.ts';
import type { Repo } from './repo.ts';

/** Что прогон знает и отдаёт каждой группе правил. */
export interface GroupContext {
	repoRoot: string;
	repo: Repo;
	env: NodeJS.ProcessEnv;
	prBase: PrBase;
}

/** Что группа отдаёт: находки в своём порядке и пометки. */
export interface GroupReport {
	findings: Finding[];
	notes: string[];
}

/** Группа правил: читает исход через свой порт и отдаёт находки и пометки. */
export type RuleGroupModule<Port> = (ctx: GroupContext, port: Port) => GroupReport;

export type GroupTable = Record<string, RuleGroupModule<never>>;

/** Порты таблицы: по ключу группы — порт её функции, все необязательны. */
export type GroupPorts<T extends GroupTable> = {
	[K in keyof T]?: T[K] extends RuleGroupModule<infer P> ? P : never;
};

// Обход не знает имён групп: порядок задаёт `enabled`, порт берётся по ключу. Включённая группа
// без порта — ошибка, а не «находок нет»; исключение группы летит наружу как есть.
export function runGroups<T extends GroupTable>(
	table: T,
	enabled: readonly (keyof T & string)[],
	ctx: GroupContext,
	ports: GroupPorts<T>,
): GroupReport {
	const findings: Finding[] = [];
	const notes: string[] = [];
	for (const name of enabled) {
		const port = ports[name];
		if (port === undefined) throw new Error(`rule group "${name}" is enabled but has no port`);
		// TS не связывает ключ таблицы с типом порта его функции (коррелированный union): порт взят
		// из ports по тому же ключу, поэтому он принадлежит именно этой группе.
		const report = (table[name] as RuleGroupModule<typeof port>)(ctx, port);
		findings.push(...report.findings);
		notes.push(...report.notes);
	}
	return { findings, notes };
}
