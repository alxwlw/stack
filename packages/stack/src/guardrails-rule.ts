// Правило группы guardrails: находки и пометки из исхода читателя. Чистые функции над значениями.

import type { Finding } from './findings.ts';
import type { GuardrailsOutcome } from './guardrails.ts';
import { GUARDRAIL_TOOLS, type GuardrailViolation } from './guardrails-port.ts';

function byPathThenLine(a: GuardrailViolation, b: GuardrailViolation): number {
	if (a.path !== b.path) return a.path < b.path ? -1 : 1;
	return a.line - b.line;
}

// Порядок: инструмент (GUARDRAIL_TOOLS), путь, строка. Строка <= 0 — цель без номера.
export function checkGuardrails(outcome: GuardrailsOutcome | undefined): Finding[] {
	if (outcome === undefined) throw new Error('checkGuardrails: no guardrails outcome');
	if ('unavailable' in outcome) {
		return [
			{ code: 'guardrails-unavailable', target: 'git ls-files', message: outcome.unavailable },
		];
	}
	const findings: Finding[] = [];
	for (const tool of GUARDRAIL_TOOLS) {
		const part = outcome.tools[tool];
		if ('skipped' in part) continue;
		if ('unavailable' in part) {
			findings.push({ code: 'guardrails-unavailable', target: tool, message: part.unavailable });
			continue;
		}
		for (const v of [...part.violations].sort(byPathThenLine)) {
			findings.push({
				code: 'guardrails-violation',
				target: v.line > 0 ? `${v.path}:${v.line}` : v.path,
				message: `${v.tool} ${v.rule}: ${v.message}`,
			});
		}
	}
	const commits = outcome.commits;
	if ('unavailable' in commits) {
		findings.push({
			code: 'guardrails-unavailable',
			target: 'gitleaks commits',
			message: commits.unavailable,
		});
	} else if ('violations' in commits) {
		for (const v of [...commits.violations].sort(byPathThenLine)) {
			findings.push({
				code: 'guardrails-violation',
				target: v.line > 0 ? `${v.path}:${v.line}` : v.path,
				message: `${v.tool} ${v.rule}: ${v.message}`,
			});
		}
	}
	return findings;
}

// Строка на инструмент в порядке GUARDRAIL_TOOLS; выход пометки не меняют.
export function guardrailsNotes(outcome: GuardrailsOutcome | undefined): string[] {
	if (outcome === undefined || 'unavailable' in outcome) return [];
	const lines = GUARDRAIL_TOOLS.map((tool) => {
		const part = outcome.tools[tool];
		if ('skipped' in part) return `guardrails ${tool}: skipped (no files)`;
		if ('unavailable' in part) return `guardrails ${tool}: unavailable`;
		return `guardrails ${tool} ${part.version}: ${part.files} file(s), ${part.violations.length} finding(s)`;
	});
	const commits = outcome.commits;
	if ('skipped' in commits) lines.push(`guardrails gitleaks commits: skipped (${commits.skipped})`);
	else if ('unavailable' in commits) lines.push('guardrails gitleaks commits: unavailable');
	else {
		lines.push(
			`guardrails gitleaks commits ${commits.range}: ${commits.violations.length} finding(s)`,
		);
	}
	return lines;
}
