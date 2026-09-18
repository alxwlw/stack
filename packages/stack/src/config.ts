import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse as parseJsonc, type ParseError } from 'jsonc-parser';

export const STACK_CONFIG_FILE = '.stack.jsonc';
export const PROFILES = ['node', 'contracts', 'infra'] as const;
export type Profile = (typeof PROFILES)[number];

export interface Exception {
	file?: string;
	catalog?: string;
	name?: string;
	reason: string;
}

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
	const raw = parseJsonc(readFileSync(path, 'utf8'), errors, { allowTrailingComma: true }) as
		| Partial<StackConfig>
		| undefined;
	if (errors.length || raw == null || typeof raw !== 'object') {
		throw new StackConfigError(`${STACK_CONFIG_FILE}: does not parse as JSONC`);
	}
	const profile = raw.profile;
	if (!PROFILES.includes(profile as Profile)) {
		throw new StackConfigError(
			`${STACK_CONFIG_FILE}: profile="${String(profile)}", expected one of: ${PROFILES.join(', ')}`,
		);
	}
	const groups = raw.with ?? [];
	if (!Array.isArray(groups) || groups.some((g) => typeof g !== 'string')) {
		throw new StackConfigError(`${STACK_CONFIG_FILE}: "with" must be an array of strings`);
	}
	const exceptions = raw.exceptions ?? [];
	if (!Array.isArray(exceptions))
		throw new StackConfigError(`${STACK_CONFIG_FILE}: "exceptions" must be an array`);
	const present = (v: unknown): boolean => v !== undefined;
	const nonEmpty = (v: unknown): boolean => typeof v === 'string' && v !== '';
	// exceptions пришёл из JSON и типизирован через "as" — реальный элемент массива может быть
	// null/undefined, даже когда тип обещает Exception; проверяем честно, не полагаясь на "as".
	for (const e of exceptions as (Exception | null | undefined)[]) {
		if (e == null || !e.reason)
			throw new StackConfigError(
				`${STACK_CONFIG_FILE}: exception is missing "reason": ${JSON.stringify(e)}`,
			);
		const isFileOnly = nonEmpty(e.file) && !present(e.catalog) && !present(e.name);
		const isEntryOnly = nonEmpty(e.catalog) && nonEmpty(e.name) && !present(e.file);
		if (!isFileOnly && !isEntryOnly) {
			throw new StackConfigError(
				`${STACK_CONFIG_FILE}: an exception must address either "file" or a "catalog"+"name" pair: ${JSON.stringify(e)}`,
			);
		}
	}
	return { profile: profile as Profile, with: groups, exceptions };
}
