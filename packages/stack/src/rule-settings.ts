// Имена и параметры правил, которые канон называет в своих настройках (canon/settings.json).
// Лист: ничего не импортирует (canon-settings.ts импортирует его, а модули правил — canon.ts).
// Нарушение — дефект пакета канона: обычная Error с тем же префиксом, что у canon-settings.ts.
import type { FindingCode } from './findings.ts';

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

// Правило вне групп: имя — код его находок. Канон включает правило ключом `rules` своих настроек;
// порядок списка — порядок находок в check.
export const RULE_NAMES = [
	'release-age-exclude',
	'package-manager',
	'inline-version',
	'engines-node',
	'renovate-preset',
	'dependabot-config',
	'canon-not-extended',
	'moon-toolchain-version',
	'moon-v1-toolchain',
	'moon-default-branch',
	'toolchain-pin',
] as const satisfies readonly FindingCode[];
export type RuleName = (typeof RULE_NAMES)[number];

// Имя пакета npm: со scope или без; тем же образцом canon-settings.ts проверяет ownPackages.
export const PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

/** Засев, который канон просит держать подключённым: gitleaks — встроенный вид, JSON — extends на пакет пресета. */
export type SeedSpec =
	| { readonly kind: 'gitleaks' }
	| { readonly kind: 'json-extends'; readonly package: string; readonly message: string };

export type NoParams = Readonly<Record<string, never>>;

/** Параметры правила по имени; полный по RuleName: имя без записи не компилируется. */
export interface RuleParams {
	'release-age-exclude': NoParams;
	'package-manager': NoParams;
	'inline-version': NoParams;
	'engines-node': NoParams;
	'renovate-preset': { readonly preset: string };
	'dependabot-config': NoParams;
	'canon-not-extended': { readonly seeds: Readonly<Record<string, SeedSpec>> };
	'moon-toolchain-version': NoParams;
	'moon-v1-toolchain': NoParams;
	'moon-default-branch': NoParams;
	'toolchain-pin': NoParams;
}

/** Включённые правила канона: имя → его параметры. */
export type RuleSettings = { readonly [K in RuleName]?: RuleParams[K] };

type ParamsCheck = (raw: Record<string, unknown>, at: string) => RuleParams[RuleName];

function onlyKeys(raw: Record<string, unknown>, at: string, allowed: readonly string[]): void {
	for (const key of Object.keys(raw)) {
		if (!allowed.includes(key)) bad(`"${at}" has unknown key ${JSON.stringify(key)}`);
	}
}

const noParams = (raw: Record<string, unknown>, at: string): NoParams => {
	onlyKeys(raw, at, []);
	return {};
};

const SEED_KINDS = ['gitleaks', 'json-extends'] as const;

function checkSeed(raw: unknown, dest: string, at: string): SeedSpec {
	const head = `"${at}" entry ${JSON.stringify(dest)}`;
	if (!isRecord(raw)) return bad(`${head} must be an object`);
	const { kind } = raw;
	if (!(SEED_KINDS as readonly unknown[]).includes(kind)) {
		return bad(`${head} has "kind" outside: ${SEED_KINDS.join(', ')}`);
	}
	const allowed = kind === 'gitleaks' ? ['kind'] : ['kind', 'package', 'message'];
	for (const key of Object.keys(raw)) {
		if (!allowed.includes(key)) bad(`${head} has unknown key ${JSON.stringify(key)}`);
	}
	if (kind === 'gitleaks') return { kind };
	const { package: pkg, message } = raw;
	if (typeof pkg !== 'string' || !PACKAGE_NAME.test(pkg)) {
		return bad(`${head} has "package" that is not a package name: ${JSON.stringify(pkg)}`);
	}
	if (typeof message !== 'string' || message === '') {
		return bad(`${head} needs a non-empty "message"`);
	}
	return { kind: 'json-extends', package: pkg, message };
}

const PARAMS_CHECKS: {
	[K in RuleName]: (raw: Record<string, unknown>, at: string) => RuleParams[K];
} = {
	'release-age-exclude': noParams,
	'package-manager': noParams,
	'inline-version': noParams,
	'engines-node': noParams,
	'renovate-preset': (raw, at) => {
		onlyKeys(raw, at, ['preset']);
		const { preset } = raw;
		if (typeof preset !== 'string' || preset === '') {
			return bad(`"${at}.preset" must be a non-empty string`);
		}
		return { preset };
	},
	'dependabot-config': noParams,
	'canon-not-extended': (raw, at) => {
		onlyKeys(raw, at, ['seeds']);
		const seedsAt = `${at}.seeds`;
		const { seeds } = raw;
		if (!isRecord(seeds) || Object.keys(seeds).length === 0) {
			return bad(`"${seedsAt}" must be a non-empty object of dest → seed`);
		}
		return {
			seeds: Object.fromEntries(
				Object.entries(seeds).map(([dest, spec]) => [dest, checkSeed(spec, dest, seedsAt)]),
			),
		};
	},
	'moon-toolchain-version': noParams,
	'moon-v1-toolchain': noParams,
	'moon-default-branch': noParams,
	'toolchain-pin': noParams,
};

// Включённые правила: имя из RULE_NAMES → объект параметров (пустой законен, если параметров нет).
export function checkRules(raw: unknown): RuleSettings {
	if (!isRecord(raw)) return bad('"rules" must be an object');
	const out: Record<string, unknown> = {};
	for (const [name, params] of Object.entries(raw)) {
		if (!(RULE_NAMES as readonly string[]).includes(name)) {
			bad(
				`"rules" has unknown rule ${JSON.stringify(name)}, expected one of: ${[...RULE_NAMES].sort().join(', ')}`,
			);
		}
		const at = `rules.${name}`;
		if (!isRecord(params)) return bad(`"${at}" must be an object`);
		// TS не связывает ключ таблицы с типом проверки (коррелированный union): имя проверено выше.
		out[name] = (PARAMS_CHECKS[name as RuleName] as ParamsCheck)(params, at);
	}
	return out;
}
