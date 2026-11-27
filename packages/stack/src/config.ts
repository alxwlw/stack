import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type Node, type ParseError, parseTree } from 'jsonc-parser';

import type { CanonSettings } from './canon-settings.ts';
import { type Exception, exceptionProblem, exceptionSchema } from './exceptions.ts';

// Допустимые ключи верхнего уровня файла настроек потребителя; schema.json описывает тот же набор.
export const CONFIG_KEYS = ['$schema', 'profile', 'with', 'exceptions'] as const;
// Имя профиля из настроек канона; список проверяют читатели, не tsc.
export type Profile = string;

export interface StackConfig {
	profile: Profile;
	with: string[];
	exceptions: Exception[];
}

export class StackConfigError extends Error {}

// Значение узла дерева разбора. parse из jsonc-parser пишет obj[key] = value: ключ __proto__ подменял бы
// прототип, а скаляр терялся; здесь объект собирается собственными свойствами, и __proto__ — обычный ключ.
function nodeValue(node: Node): unknown {
	if (node.type === 'object') {
		return Object.fromEntries(
			(node.children ?? []).map((prop) => {
				const [key, value] = prop.children ?? [];
				return [key?.value, value ? nodeValue(value) : undefined];
			}),
		);
	}
	if (node.type === 'array') return (node.children ?? []).map(nodeValue);
	return node.value;
}

export function readStackConfig(repoRoot: string, settings: CanonSettings): StackConfig {
	const { configFile, command, profiles } = settings;
	const path = join(repoRoot, configFile);
	if (!existsSync(path)) {
		throw new StackConfigError(
			`${configFile} not found. Create it: ${command} init --profile <profile>`,
		);
	}
	const errors: ParseError[] = [];
	const tree = parseTree(readFileSync(path, 'utf8'), errors, { allowTrailingComma: true });
	if (errors.length) throw new StackConfigError(`${configFile}: does not parse as JSONC`);
	const raw: unknown = tree === undefined ? undefined : nodeValue(tree);
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new StackConfigError(`${configFile}: top level must be an object`);
	}
	const top = raw as Record<string, unknown>;
	// Форму файла заявляют CONFIG_KEYS, профили настроек канона и EXCEPTION_SHAPES, schema.json строится из них: лишний
	// ключ — опечатка, а не расширение.
	const unknownKey = Object.keys(top).find((k) => !(CONFIG_KEYS as readonly string[]).includes(k));
	if (unknownKey !== undefined) {
		throw new StackConfigError(
			`${configFile}: unknown key ${JSON.stringify(unknownKey)}, expected one of: ${CONFIG_KEYS.join(', ')}`,
		);
	}
	if (top.$schema !== undefined && typeof top.$schema !== 'string') {
		throw new StackConfigError(`${configFile}: "$schema" must be a string`);
	}
	const profile = top.profile;
	if (typeof profile !== 'string' || !profiles.includes(profile)) {
		throw new StackConfigError(
			`${configFile}: profile="${String(profile)}", expected one of: ${profiles.join(', ')}`,
		);
	}
	// Умолчание — только для отсутствующего ключа: null схема запрещает так же, как не-массив.
	const groups = top.with === undefined ? [] : top.with;
	if (!Array.isArray(groups) || groups.some((g) => typeof g !== 'string')) {
		throw new StackConfigError(`${configFile}: "with" must be an array of strings`);
	}
	const exceptions = top.exceptions === undefined ? [] : top.exceptions;
	if (!Array.isArray(exceptions))
		throw new StackConfigError(`${configFile}: "exceptions" must be an array`);
	for (const e of exceptions) {
		const problem = exceptionProblem(e);
		if (problem) throw new StackConfigError(`${configFile}: ${problem}`);
	}
	return {
		profile,
		with: groups as string[],
		exceptions: exceptions as Exception[],
	};
}

// JSON Schema файла для редактора: строится из тех же констант, что читатель. packages/stack/schema.json
// равен её результату (config.test.ts). Свойство без ключа в CONFIG_KEYS и ключ без свойства не проходят tsc.
export function stackConfigSchema(
	settings: CanonSettings,
	groups: readonly string[],
): Record<string, unknown> {
	const properties: Record<(typeof CONFIG_KEYS)[number], unknown> = {
		$schema: { type: 'string' },
		profile: {
			type: 'string',
			enum: [...settings.profiles],
			description: 'Repo profile: picks which canon verbatim files get synced.',
		},
		with: {
			type: 'array',
			description:
				'Opt-in canon groups. "renovate" is deprecated and does nothing: Renovate is the canon\'s dependency bot for every profile.',
			items: { type: 'string', enum: [...groups] },
		},
		exceptions: {
			type: 'array',
			description: `An exception holds its item back in both \`${settings.command} check\` (the finding is suppressed and reported as allowed) and \`${settings.command} sync\` (the item is left untouched). Each exception addresses exactly one canon file or exactly one catalog entry.`,
			items: exceptionSchema(),
		},
	};
	return {
		$schema: 'http://json-schema.org/draft-07/schema#',
		title: `${settings.command} config (${settings.configFile})`,
		type: 'object',
		properties,
		required: ['profile'],
		additionalProperties: false,
	};
}
