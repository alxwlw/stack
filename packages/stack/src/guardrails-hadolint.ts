import {
	failureReason,
	type GuardrailRun,
	type GuardrailViolation,
	type Unavailable,
} from './guardrails-port.ts';

// `-f json`: вывод разбирается, а не читается глазами. `--no-fail`: без него код 1 значит всё сразу
// (находки, отсутствующий файл, неизвестный флаг), и недоступность не отличить от находки; с ним
// находки и чистый прогон дают код 0 с JSON, а код 1 остаётся сбоем. Порог — уровень из вывода,
// а не код выхода. `--` перед путями: файл `-x.Dockerfile` не должен читаться как флаг.
// Пустой stderr — требование: сломанный конфиг репозитория не даёт ошибки, hadolint печатает
// `Error parsing your config file` в stderr и идёт с конфигом по умолчанию, код 0 (parseHadolint).
export function hadolintArgv(files: readonly string[]): string[] {
	return ['-f', 'json', '--no-fail', '--', ...files];
}

const SHAPE = 'output has an unexpected shape: findings';
const LEVELS: ReadonlySet<string> = new Set(['error', 'warning', 'info', 'style']);
// Ниже порога: `info` и `style` не находка.
const FINDING_LEVELS: ReadonlySet<string> = new Set(['error', 'warning']);

// Разбор: код 0, пустой stderr и JSON-массив нужной формы; иначе недоступность. Находка — `error` и
// `warning` (DL1000, «не разбирается», тоже `error`).
export function parseHadolint(run: GuardrailRun): GuardrailViolation[] | Unavailable {
	if (run.code !== 0) return { unavailable: failureReason(run) };
	if (run.err.trim() !== '') {
		const first = run.err
			.split('\n')
			.map((l) => l.trim())
			.find((l) => l !== '');
		return { unavailable: first ?? run.err.trim() };
	}
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
		const { code, file, level, line, message } = item as Record<string, unknown>;
		if (
			typeof code !== 'string' ||
			typeof file !== 'string' ||
			typeof level !== 'string' ||
			typeof message !== 'string' ||
			typeof line !== 'number' ||
			!LEVELS.has(level)
		) {
			return { unavailable: SHAPE };
		}
		if (!FINDING_LEVELS.has(level)) continue;
		found.push({ tool: 'hadolint', rule: code, path: file, line, message });
	}
	return found;
}
