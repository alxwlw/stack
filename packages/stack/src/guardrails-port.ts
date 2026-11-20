// Общие типы группы guardrails. Внешние вызовы идут через один порт: адаптер — в cli.ts, тесты
// подставляют значения.

export interface GuardrailRun {
	code: number;
	out: string;
	err: string;
}

export type GuardrailRunner = (cmd: string, argv: string[]) => GuardrailRun;

export interface GuardrailsPort {
	run: GuardrailRunner;
	env: NodeJS.ProcessEnv;
}

export const GUARDRAIL_TOOLS = ['actionlint', 'shellcheck'] as const;
export type GuardrailTool = (typeof GUARDRAIL_TOOLS)[number];

export interface GuardrailViolation {
	tool: GuardrailTool;
	rule: string;
	path: string;
	line: number;
	message: string;
}

export interface Unavailable {
	unavailable: string;
}

// Первая непустая строка stderr (обрезанная), иначе `exited with <code>`.
export function failureReason(run: GuardrailRun): string {
	const first = run.err
		.split('\n')
		.map((l) => l.trim())
		.find((l) => l !== '');
	return first ?? `exited with ${run.code}`;
}
