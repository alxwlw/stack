// Имена и параметры правил, которые канон называет в своих настройках (canon/settings.json).
// Лист: ничего не импортирует (canon-settings.ts импортирует его, а модули правил — canon.ts).
// Нарушение — дефект пакета канона: обычная Error с тем же префиксом, что у canon-settings.ts.

// Группа правила включает правило `stack check`, файлов и каталогов не даёт.
export const RULE_GROUPS = ['peers', 'repo-rules', 'guardrails'] as const;
export type RuleGroup = (typeof RULE_GROUPS)[number];

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

function bad(message: string): never {
	throw new Error(`canon settings: ${message}`);
}

// Предлагаемые группы: порядок настроек сохраняется, порядок находок задаёт RULE_GROUPS.
export function checkGroups(raw: unknown): RuleGroup[] {
	const shape = '"groups" must be an array of rule group names';
	if (!Array.isArray(raw)) return bad(shape);
	const out: RuleGroup[] = [];
	for (const g of raw as unknown[]) {
		if (typeof g !== 'string') return bad(shape);
		if (!(RULE_GROUPS as readonly string[]).includes(g)) {
			bad(
				`"groups" has unknown rule group ${JSON.stringify(g)}, expected one of: ${[...RULE_GROUPS].sort().join(', ')}`,
			);
		}
		if (out.includes(g as RuleGroup)) bad(`"groups" lists ${JSON.stringify(g)} twice`);
		out.push(g as RuleGroup);
	}
	return out;
}

// Устаревшие группы: имя → причина; имя, совпадающее с предлагаемой группой, — дефект канона.
export function checkDeprecatedGroups(
	raw: unknown,
	offered: readonly RuleGroup[],
): Readonly<Record<string, string>> {
	if (!isRecord(raw)) return bad('"deprecatedGroups" must be an object of group name → reason');
	const out: Record<string, string> = {};
	for (const [name, reason] of Object.entries(raw)) {
		if (typeof reason !== 'string' || reason === '') {
			bad(`"deprecatedGroups.${name}" must be a non-empty string`);
		}
		if ((offered as readonly string[]).includes(name)) {
			bad(`"deprecatedGroups" names ${JSON.stringify(name)}, which the canon also offers`);
		}
		out[name] = reason;
	}
	return out;
}
