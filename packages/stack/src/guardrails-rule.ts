// Правило группы guardrails: находки и пометки из исхода читателя (чистые функции над значениями) и
// сама группа guardrailsGroup: она зовёт readGuardrails — через порт run идут `git ls-files`,
// инструменты и `git merge-base` для коммитов PR, копию файлов во временный каталог читатель делает
// сам — и добавляет к находкам гигиену workflow.

import type { Finding } from './findings.ts';
import { type GuardrailsOutcome, readGuardrails } from './guardrails.ts';
import {
	GUARDRAIL_TOOLS,
	type GuardrailRunner,
	type GuardrailViolation,
} from './guardrails-port.ts';
import type { RuleGroupModule } from './rule-group.ts';
import { checkWorkflowHygiene } from './workflow-hygiene.ts';

function byPathThenLine(a: GuardrailViolation, b: GuardrailViolation): number {
	if (a.path !== b.path) return a.path < b.path ? -1 : 1;
	return a.line - b.line;
}

// Порядок: инструмент (GUARDRAIL_TOOLS), путь, строка; находки коммитов PR (commits) идут после всех инструментов. Строка <= 0 — цель без номера.
export function checkGuardrails(outcome: GuardrailsOutcome): Finding[] {
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

// Строка на инструмент в порядке GUARDRAIL_TOOLS, последней — строка коммитов PR (commits); выход пометки не меняют.
export function guardrailsNotes(outcome: GuardrailsOutcome): string[] {
	if ('unavailable' in outcome) return [];
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

/** Находки: инструменты, коммиты PR, затем гигиена workflow по ctx.repo.files. */
export const guardrailsGroup: RuleGroupModule<GuardrailRunner> = (ctx, run) => {
	const outcome = readGuardrails(
		ctx.repoRoot,
		ctx.repo.files.get('.prototools'),
		{ run, env: ctx.env },
		ctx.prBase,
	);
	return {
		findings: [...checkGuardrails(outcome), ...checkWorkflowHygiene(ctx.repo.files)],
		notes: guardrailsNotes(outcome),
	};
};
