// Настройки канона: имена и тексты, которые канон объявляет данными (canon/settings.json).
// Нарушение — дефект пакета канона, а не потребителя: обычная Error, не StackConfigError.
import { checkDeprecatedGroups, checkGroups, type RuleGroup } from './rule-settings.ts';

export interface SyncPrTexts {
	title: string;
	body: string;
	closeComment: string;
	upToDateComment: string;
}

export interface CanonSettings {
	profiles: readonly string[];
	configFile: string;
	command: string;
	ownPackages: readonly string[];
	syncPr: SyncPrTexts;
	/** Предлагаемые группы правил: из них `with` включает правила. */
	groups: readonly RuleGroup[];
	/** Устаревшие группы: имя → причина; принимаются, ничего не включают. */
	deprecatedGroups: Readonly<Record<string, string>>;
}

// Подстановки шаблонов: у каждого шаблона свой список.
export const SYNC_PR_PLACEHOLDERS = {
	title: ['version'],
	body: ['version', 'files'],
	closeComment: ['version', 'url'],
	upToDateComment: ['version', 'base'],
} as const satisfies Record<keyof SyncPrTexts, readonly string[]>;

export type SyncPrValues<K extends keyof SyncPrTexts> = Record<
	(typeof SYNC_PR_PLACEHOLDERS)[K][number],
	string
>;

// Ключи верхнего уровня: Record не даёт полю без ключа и ключу без поля пройти tsc.
const SETTINGS_KEYS: Record<keyof CanonSettings, true> = {
	profiles: true,
	configFile: true,
	command: true,
	ownPackages: true,
	syncPr: true,
	groups: true,
	deprecatedGroups: true,
};

const PLACEHOLDER = /\{([A-Za-z]+)\}/g;
const SCOPE_PATTERN = /^@[a-z0-9][a-z0-9._-]*\/$/;
const PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

function bad(message: string): never {
	throw new Error(`canon settings: ${message}`);
}

function checkProfiles(v: unknown): string[] {
	const fail = (what: string): never => bad(`"profiles" ${what}`);
	if (!Array.isArray(v) || v.length === 0) return fail('must be a non-empty array of strings');
	const out: string[] = [];
	for (const p of v as unknown[]) {
		if (typeof p !== 'string' || p === '') return fail('must hold non-empty strings only');
		if (out.includes(p)) return fail(`lists ${JSON.stringify(p)} twice`);
		out.push(p);
	}
	return out;
}

function checkConfigFile(v: unknown): string {
	if (typeof v !== 'string' || v === '') bad('"configFile" must be a non-empty string');
	if (/[/\\]/.test(v) || v === '.' || v === '..') {
		bad(`"configFile" must be a file name, not a path: ${JSON.stringify(v)}`);
	}
	return v;
}

function checkCommand(v: unknown): string {
	if (typeof v !== 'string' || v === '') bad('"command" must be a non-empty string');
	if (/\s/.test(v)) bad(`"command" must not contain whitespace: ${JSON.stringify(v)}`);
	return v;
}

function checkOwnPackages(v: unknown): string[] {
	if (!Array.isArray(v)) return bad('"ownPackages" must be an array');
	for (const p of v as unknown[]) {
		if (typeof p !== 'string' || !(SCOPE_PATTERN.test(p) || PACKAGE_NAME.test(p))) {
			bad(
				`"ownPackages" has ${JSON.stringify(p)}: expected a scope like "@scope/" or a package name`,
			);
		}
	}
	return [...(v as string[])];
}

function checkSyncPr(v: unknown): SyncPrTexts {
	if (!isRecord(v)) return bad('"syncPr" must be an object');
	for (const key of Object.keys(v)) {
		if (!Object.hasOwn(SYNC_PR_PLACEHOLDERS, key)) {
			bad(`"syncPr" has unknown key ${JSON.stringify(key)}`);
		}
	}
	const out: Record<string, string> = {};
	for (const [key, allowed] of Object.entries(SYNC_PR_PLACEHOLDERS)) {
		const text = v[key];
		if (typeof text !== 'string' || text === '') {
			bad(`"syncPr.${key}" must be a non-empty string`);
		}
		for (const m of text.matchAll(PLACEHOLDER)) {
			const name = m[1] as string;
			if (!(allowed as readonly string[]).includes(name)) {
				bad(
					`"syncPr.${key}" has unknown placeholder {${name}}, expected one of: ${allowed.map((a) => `{${a}}`).join(', ')}`,
				);
			}
		}
		out[key] = text;
	}
	return out as unknown as SyncPrTexts;
}

export function checkSettings(raw: unknown): CanonSettings {
	if (!isRecord(raw)) return bad('must be an object');
	for (const key of Object.keys(raw)) {
		if (!Object.hasOwn(SETTINGS_KEYS, key)) bad(`unknown key ${JSON.stringify(key)}`);
	}
	const groups = checkGroups(raw.groups);
	return {
		profiles: checkProfiles(raw.profiles),
		configFile: checkConfigFile(raw.configFile),
		command: checkCommand(raw.command),
		ownPackages: checkOwnPackages(raw.ownPackages),
		syncPr: checkSyncPr(raw.syncPr),
		groups,
		deprecatedGroups: checkDeprecatedGroups(raw.deprecatedGroups, groups),
	};
}

// Один проход: вставленное значение не просматривается повторно, `$&` в нём — обычный текст.
export function syncPrText<K extends keyof SyncPrTexts>(
	texts: SyncPrTexts,
	key: K,
	values: SyncPrValues<K>,
): string {
	const byName: Record<string, string> = values;
	return texts[key].replace(PLACEHOLDER, (whole, name: string) =>
		Object.hasOwn(byName, name) ? (byName[name] as string) : whole,
	);
}
