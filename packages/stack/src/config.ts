import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse as parseJsonc, type ParseError } from 'jsonc-parser';

import { type Exception, exceptionProblem, exceptionSchema } from './exceptions.ts';

export const STACK_CONFIG_FILE = '.stack.jsonc';
export const PROFILES = ['node', 'contracts', 'infra'] as const;
// Допустимые ключи верхнего уровня .stack.jsonc; schema.json описывает тот же набор.
export const CONFIG_KEYS = ['$schema', 'profile', 'with', 'exceptions'] as const;
export type Profile = (typeof PROFILES)[number];

export interface StackConfig {
	profile: Profile;
	with: string[];
	exceptions: Exception[];
}

export class StackConfigError extends Error {}

export function readStackConfig(repoRoot: string): StackConfig {
	const path = join(repoRoot, STACK_CONFIG_FILE);
	if (!existsSync(path)) {
		throw new StackConfigError(
			`${STACK_CONFIG_FILE} not found. Create it: stack init --profile <profile>`,
		);
	}
	const errors: ParseError[] = [];
	const raw: unknown = parseJsonc(readFileSync(path, 'utf8'), errors, { allowTrailingComma: true });
	if (errors.length) throw new StackConfigError(`${STACK_CONFIG_FILE}: does not parse as JSONC`);
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new StackConfigError(`${STACK_CONFIG_FILE}: top level must be an object`);
	}
	const top = raw as Record<string, unknown>;
	// Форма файла заявлена schema.json: лишний ключ — опечатка, а не расширение.
	const unknownKey = Object.keys(top).find((k) => !(CONFIG_KEYS as readonly string[]).includes(k));
	if (unknownKey !== undefined) {
		throw new StackConfigError(
			`${STACK_CONFIG_FILE}: unknown key "${unknownKey}", expected one of: ${CONFIG_KEYS.join(', ')}`,
		);
	}
	if (top.$schema !== undefined && typeof top.$schema !== 'string') {
		throw new StackConfigError(`${STACK_CONFIG_FILE}: "$schema" must be a string`);
	}
	const profile = top.profile;
	if (!PROFILES.includes(profile as Profile)) {
		throw new StackConfigError(
			`${STACK_CONFIG_FILE}: profile="${String(profile)}", expected one of: ${PROFILES.join(', ')}`,
		);
	}
	// Умолчание — только для отсутствующего ключа: null схема запрещает так же, как не-массив.
	const groups = top.with === undefined ? [] : top.with;
	if (!Array.isArray(groups) || groups.some((g) => typeof g !== 'string')) {
		throw new StackConfigError(`${STACK_CONFIG_FILE}: "with" must be an array of strings`);
	}
	const exceptions = top.exceptions === undefined ? [] : top.exceptions;
	if (!Array.isArray(exceptions))
		throw new StackConfigError(`${STACK_CONFIG_FILE}: "exceptions" must be an array`);
	for (const e of exceptions) {
		const problem = exceptionProblem(e);
		if (problem) throw new StackConfigError(`${STACK_CONFIG_FILE}: ${problem}`);
	}
	return {
		profile: profile as Profile,
		with: groups as string[],
		exceptions: exceptions as Exception[],
	};
}

// JSON Schema файла для редактора: строится из тех же констант, что читатель. packages/stack/schema.json
// равен её результату (config.test.ts). Свойство без ключа в CONFIG_KEYS и ключ без свойства не проходят tsc.
export function stackConfigSchema(groups: readonly string[]): Record<string, unknown> {
	const properties: Record<(typeof CONFIG_KEYS)[number], unknown> = {
		$schema: { type: 'string' },
		profile: {
			type: 'string',
			enum: [...PROFILES],
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
			description:
				'An exception holds its item back in both `stack check` (the finding is suppressed and reported as allowed) and `stack sync` (the item is left untouched). Each exception addresses exactly one canon file or exactly one catalog entry.',
			items: exceptionSchema(),
		},
	};
	return {
		$schema: 'http://json-schema.org/draft-07/schema#',
		title: 'stack config (.stack.jsonc)',
		type: 'object',
		properties,
		required: ['profile'],
		additionalProperties: false,
	};
}
