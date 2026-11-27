import { parse, type ParseError, printParseErrorCode } from 'jsonc-parser';

import type { Canon } from './canon.ts';
import type { Finding } from './findings.ts';
import type { Repo } from './repo.ts';

/** Канон-файл с правилами gitleaks: его подключает засев gitleaks. */
export const GITLEAKS_CANON = '.gitleaks.canon.toml';

const NOT_PARSED_TAIL = 'cannot tell whether it extends the canon';
const NOT_PARSED = `stack ${NOT_PARSED_TAIL}`;

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

const notParsed = (format: string, reason: string) =>
	`does not parse as ${format} (${reason}) — ${NOT_PARSED}`;

// Ключ записи так, как его находит gitleaks: регистр не важен, а при нескольких написаниях действует то,
// что идёт первым по ASCII (замер gitleaks 8.30.1: `EXTEND` раньше `Extend`, `Extend` раньше `extend`;
// остальные написания молча отбрасываются).
function keyOf(table: Record<string, unknown>, name: string): unknown {
	const key = Object.keys(table)
		.filter((k) => k.toLowerCase() === name)
		.sort()[0];
	return key === undefined ? undefined : table[key];
}

// Строки, которые gitleaks (viper, strconv.ParseBool) читает как булево; пустая строка — ложь.
const TRUE_STRINGS = new Set(['1', 't', 'T', 'TRUE', 'true', 'True']);
const FALSE_STRINGS = new Set(['0', 'f', 'F', 'FALSE', 'false', 'False', '']);

// Булево useDefault: boolean как есть, число — не ноль, строка — по ParseBool; иное — undefined.
function readBool(value: unknown): boolean | undefined {
	if (value === undefined) return false;
	if (typeof value === 'boolean') return value;
	if (typeof value === 'number') return value !== 0;
	if (typeof value !== 'string') return undefined;
	if (TRUE_STRINGS.has(value)) return true;
	return FALSE_STRINGS.has(value) ? false : undefined;
}

// Засев gitleaks: канон подключён, когда extend.path указывает на канон-файл правил. useDefault = true
// не годится и вместе с path: gitleaks такой конфиг не загружает. Ключи и булевы читаются как у
// gitleaks (viper), по замеру этой фазы: регистр ключей не важен, useDefault может быть строкой или
// числом, а непонятная строка или массив — конфиг, который gitleaks не загружает.
function readGitleaks(text: string): string | undefined {
	let data: unknown;
	try {
		data = Bun.TOML.parse(text);
	} catch (error) {
		const first = (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '';
		return notParsed('TOML', first);
	}
	const extend = isRecord(data) ? keyOf(data, 'extend') : undefined;
	const rawDefault = isRecord(extend) ? keyOf(extend, 'usedefault') : undefined;
	const useDefault = readBool(rawDefault);
	if (useDefault === undefined) {
		return `[extend] useDefault = ${JSON.stringify(rawDefault)} is not a boolean — gitleaks refuses to load the config`;
	}
	if (useDefault) {
		return `[extend] must set path = "${GITLEAKS_CANON}" in place of useDefault = true — the canon ruleset already extends the default one, and gitleaks refuses a config that sets both`;
	}
	const path = isRecord(extend) ? keyOf(extend, 'path') : undefined;
	if (typeof path === 'string' && path.replace(/^(\.\/)+/, '') === GITLEAKS_CANON) return undefined;
	return `[extend] path must be "${GITLEAKS_CANON}" — without it the canon ruleset does not apply`;
}

// Записи extends верхнего уровня: строка — одна запись, массив — его строки, прочее — ни одной.
function readExtends(text: string): string[] | string {
	const errors: ParseError[] = [];
	const data: unknown = parse(text.replace(/^\uFEFF/, ''), errors, { allowTrailingComma: true });
	const first = errors[0];
	if (first) {
		return notParsed(
			'JSON with comments',
			`${printParseErrorCode(first.error)} at offset ${first.offset}`,
		);
	}
	const value = isRecord(data) ? data['extends'] : undefined;
	if (typeof value === 'string') return [value];
	if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
	return [];
}

function jsonSeed(pattern: RegExp, message: string): (text: string) => string | undefined {
	return (text) => {
		const entries = readExtends(text);
		if (typeof entries === 'string') return entries;
		return entries.some((entry) => pattern.test(entry)) ? undefined : message;
	};
}

/** dest засева → чтение его текста: undefined — канон подключён, строка — текст находки. */
export const SEED_CHECKS: ReadonlyMap<string, (text: string) => string | undefined> = new Map([
	['.gitleaks.toml', readGitleaks],
	[
		'.oxlintrc.json',
		jsonSeed(
			/(^|\/)@alxwlw\/oxlint-config\//,
			'"extends" must include a preset of @alxwlw/oxlint-config, such as "./node_modules/@alxwlw/oxlint-config/node.jsonc" — without it the canon lint rules do not apply',
		),
	],
	[
		'tsconfig.options.json',
		jsonSeed(
			/(^|\/)@alxwlw\/tsconfig\//,
			'"extends" must name a preset of @alxwlw/tsconfig, such as "@alxwlw/tsconfig/node.json" — without it the canon compiler options do not apply',
		),
	],
]);

// Правило только для отчёта: засев на месте, но канон не подключает. Идёт по файлам канона, не по
// ключам таблицы: файла нет в каноне — проверять нечего. Отсутствие засева сообщает file-missing.
// Читатели таблицы пишут хвост «cannot tell» с именем владельца; имя команды канона подставляет эта функция.
export function checkSeedExtends(repo: Repo, canon: Canon): Finding[] {
	const { command } = canon.settings;
	const named = (message: string): string =>
		message.endsWith(NOT_PARSED)
			? `${message.slice(0, -NOT_PARSED.length)}${command} ${NOT_PARSED_TAIL}`
			: message;
	const findings: Finding[] = [];
	for (const { dest } of canon.files) {
		const read = SEED_CHECKS.get(dest);
		if (!read || !repo.paths.has(dest)) continue;
		const text = repo.files.get(dest);
		const found = text === undefined ? undefined : read(text);
		const message =
			text === undefined
				? `is not a readable file — ${command} ${NOT_PARSED_TAIL}`
				: found === undefined
					? undefined
					: named(found);
		if (message !== undefined) {
			findings.push({ code: 'canon-not-extended', target: dest, file: dest, message });
		}
	}
	return findings;
}
