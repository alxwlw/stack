import {
	failureReason,
	type GuardrailRun,
	type GuardrailViolation,
	type Unavailable,
} from './guardrails-port.ts';
import { QUIET_LEVELS } from './guardrails-shellcheck.ts';

// Флаги до файлов. shellcheck — путь пиненного бинарника или пусто (явно выключен: иначе actionlint
// берёт тот, что лежит в PATH); pyflakes не пинуется и выключен всегда.
export function actionlintArgv(shellcheck: string | undefined, files: readonly string[]): string[] {
	return ['-format', '{{json .}}', `-shellcheck=${shellcheck ?? ''}`, '-pyflakes=', ...files];
}

const SHAPE = 'output has an unexpected shape: errors';

const SHELLCHECK_MESSAGE =
	/^shellcheck reported issue in this script: SC(\d+):([a-z]+):\d+:\d+: (.*)$/s;

// Разбор `-format '{{json .}}'`: код 0 и 1 — вывод, прочее — недоступность. stderr при разобранном
// выводе не читается. Находка shellcheck внутри actionlint проходит тот же порог, что и shellcheck сам.
export function parseActionlint(run: GuardrailRun): GuardrailViolation[] | Unavailable {
	if (run.code !== 0 && run.code !== 1) return { unavailable: failureReason(run) };
	if (run.code === 0 && run.out.trim() === '') return [];
	let data: unknown;
	try {
		data = JSON.parse(run.out);
	} catch {
		return { unavailable: 'output is not JSON' };
	}
	if (!Array.isArray(data)) return { unavailable: SHAPE };
	const found: GuardrailViolation[] = [];
	for (const item of data as unknown[]) {
		if (typeof item !== 'object' || item === null) return { unavailable: SHAPE };
		const { message, filepath, line, kind } = item as Record<string, unknown>;
		if (
			typeof message !== 'string' ||
			typeof filepath !== 'string' ||
			typeof line !== 'number' ||
			typeof kind !== 'string'
		) {
			return { unavailable: SHAPE };
		}
		if (kind !== 'shellcheck') {
			found.push({ tool: 'actionlint', rule: kind, path: filepath, line, message });
			continue;
		}
		const m = SHELLCHECK_MESSAGE.exec(message);
		if (m === null) {
			found.push({ tool: 'actionlint', rule: 'shellcheck', path: filepath, line, message });
		} else if (!QUIET_LEVELS.has(m[2] ?? '')) {
			found.push({
				tool: 'actionlint',
				rule: `SC${m[1] ?? ''}`,
				path: filepath,
				line,
				message: m[3] ?? '',
			});
		}
	}
	if (run.code === 1 && data.length === 0) {
		return { unavailable: 'exited with 1 and reported nothing' };
	}
	return found;
}
