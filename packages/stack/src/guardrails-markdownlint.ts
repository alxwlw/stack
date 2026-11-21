import { fileURLToPath } from 'node:url';

import {
	failureReason,
	type GuardrailRun,
	type GuardrailViolation,
	type Unavailable,
} from './guardrails-port.ts';

// Поля результата markdownlint-cli2, которые раннер печатает (errorContext и fixInfo — нет).
export interface MarkdownlintResult {
	fileName: string;
	lineNumber: number;
	ruleNames: string[];
	ruleDescription: string;
	errorDetail: string | null;
	severity: string;
}

// Отчёт раннера: код возврата main, признак, что formatter вызван (без него «нет результатов» — не
// «чисто»), результаты в порядке markdownlint-cli2.
export interface MarkdownlintReport {
	version: string;
	code: number;
	formatted: boolean;
	results: MarkdownlintResult[];
}

// Раннер — скрипт stack: markdownlint-cli2 вызывается как библиотека, чтобы отключить `fix` и получить
// результаты структурой. Запускается под тем же bun, что и stack.
export const MARKDOWNLINT_RUNNER = fileURLToPath(new URL('./markdownlint-run.ts', import.meta.url));

// `--no-install`: в копии нет node_modules, и автоустановка bun скачала бы из npm пакет из customRules
// вместо исключения, которое даёт недоступность.
export function markdownlintCommand(): { cmd: string; argv: string[] } {
	return { cmd: process.execPath, argv: ['--no-install', MARKDOWNLINT_RUNNER] };
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isResult(v: unknown): v is MarkdownlintResult {
	return (
		isRecord(v) &&
		typeof v.fileName === 'string' &&
		typeof v.lineNumber === 'number' &&
		Array.isArray(v.ruleNames) &&
		v.ruleNames.length > 0 &&
		v.ruleNames.every((n) => typeof n === 'string') &&
		typeof v.ruleDescription === 'string' &&
		(v.errorDetail === null || typeof v.errorDetail === 'string') &&
		typeof v.severity === 'string'
	);
}

function isReport(v: unknown): v is MarkdownlintReport {
	return (
		isRecord(v) &&
		typeof v.version === 'string' &&
		typeof v.code === 'number' &&
		typeof v.formatted === 'boolean' &&
		Array.isArray(v.results) &&
		v.results.every(isResult)
	);
}

// Разбор отчёта раннера. Находка — каждый результат, и `warning` тоже: правило со степенью warning
// даёт код 0, но результат есть. Всё, что не «код 0 или 1 с отчётом о результатах», — недоступность.
export function parseMarkdownlint(
	run: GuardrailRun,
): { version: string; violations: GuardrailViolation[] } | Unavailable {
	if (run.code !== 0) return { unavailable: failureReason(run) };
	let body: unknown;
	try {
		body = JSON.parse(run.out);
	} catch {
		return { unavailable: 'output is not JSON' };
	}
	if (!isReport(body)) return { unavailable: 'output has an unexpected shape: report' };
	if (body.code === 2) {
		return { unavailable: 'no globs: the markdownlint-cli2 config is missing or lists none' };
	}
	if (body.code !== 0 && body.code !== 1) {
		return { unavailable: `markdownlint-cli2 returned ${body.code}` };
	}
	if (!body.formatted) return { unavailable: 'markdownlint-cli2 did not report results' };
	const errors = body.results.some((r) => r.severity === 'error');
	if (body.code === 1 && !errors) {
		return { unavailable: 'markdownlint-cli2 exited with 1 and reported nothing' };
	}
	if (body.code === 0 && errors) {
		return { unavailable: 'markdownlint-cli2 exited with 0 and reported an error' };
	}
	return {
		version: body.version,
		violations: body.results.map((r) => ({
			tool: 'markdownlint-cli2',
			rule: r.ruleNames[0] ?? '',
			path: r.fileName,
			line: r.lineNumber,
			message: r.errorDetail ? `${r.ruleDescription} [${r.errorDetail}]` : r.ruleDescription,
		})),
	};
}
