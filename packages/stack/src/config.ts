import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse as parseJsonc, type ParseError } from 'jsonc-parser';

import { type Exception, exceptionProblem } from './exceptions.ts';

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
