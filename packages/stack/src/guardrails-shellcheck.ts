import {
	failureReason,
	type GuardrailRun,
	type GuardrailViolation,
	type Unavailable,
} from './guardrails-port.ts';

// Уровни ниже порога: `info` и `style` не находка. Общий порог группы: им же пользуется actionlint
// для shellcheck внутри себя. Любой другой уровень (и незнакомый) — находка.
export const QUIET_LEVELS: ReadonlySet<string> = new Set(['info', 'style']);

// Без -x, -S и --norc: решения репозитория (.shellcheckrc, директивы) действуют, порог — в разборе.
// `--` перед путями: файл с именем `-x` или `--norc` в корне не должен читаться как флаг.
export function shellcheckArgv(files: readonly string[]): string[] {
	return ['-f', 'json1', '--', ...files];
}

const SHAPE = 'output has an unexpected shape: comments';

// Разбор json1: код 0 и 1 — вывод, прочее — недоступность. stderr при разобранном выводе не читается.
export function parseShellcheck(run: GuardrailRun): GuardrailViolation[] | Unavailable {
	if (run.code !== 0 && run.code !== 1) return { unavailable: failureReason(run) };
	let data: unknown;
	try {
		data = JSON.parse(run.out);
	} catch {
		return { unavailable: 'output is not JSON' };
	}
	const comments =
		typeof data === 'object' && data !== null
			? (data as { comments?: unknown }).comments
			: undefined;
	if (!Array.isArray(comments)) return { unavailable: SHAPE };
	const found: GuardrailViolation[] = [];
	for (const item of comments as unknown[]) {
		if (typeof item !== 'object' || item === null) return { unavailable: SHAPE };
		const c = item as Record<string, unknown>;
		const { file, line, level, code, message } = c;
		if (
			typeof file !== 'string' ||
			typeof line !== 'number' ||
			typeof level !== 'string' ||
			typeof code !== 'number' ||
			typeof message !== 'string'
		) {
			return { unavailable: SHAPE };
		}
		if (QUIET_LEVELS.has(level)) continue;
		found.push({ tool: 'shellcheck', rule: `SC${code}`, path: file, line, message });
	}
	if (run.code === 1 && comments.length === 0) {
		return { unavailable: 'exited with 1 and reported nothing' };
	}
	return found;
}
