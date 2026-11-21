import {
	failureReason,
	type GuardrailRun,
	type GuardrailViolation,
	type Unavailable,
} from './guardrails-port.ts';

// Версия yamllint: точная, как пины. Строку читает customManagers Renovate: не переносить и не
// менять её вид без правки правила Renovate.
export const YAMLLINT_VERSION = '1.38.0';

// Порядок поиска конфига среди отслеживаемых файлов.
export const YAMLLINT_CONFIG_FILES = ['.yamllint', '.yamllint.yaml', '.yamllint.yml'] as const;

// Первый из YAMLLINT_CONFIG_FILES, что есть в files.
export function yamllintConfig(files: readonly string[]): string | undefined {
	return YAMLLINT_CONFIG_FILES.find((name) => files.includes(name));
}

// uv ставит и запускает yamllint ровно версии YAMLLINT_VERSION (`==`: точную версию держит сам uv).
// Запуск идёт в копии отслеживаемых файлов (cwd), `.` — вся копия, набор сужает `yaml-files` конфига.
// `-c` обязателен: без него yamllint ищет конфиг вверх от cwd и в домашнем каталоге, и ему мог бы
// попасться неотслеживаемый. `-q` убирает из stderr строку `Installed N packages`: непустой stderr
// значит сбой (parseYamllint). `--strict` не передаётся: его код 2 совпал бы с кодом неизвестного
// флага, а предупреждения и без него разбираются как находки.
export function yamllintArgv(config: string): string[] {
	return [
		'tool',
		'run',
		'-q',
		'--from',
		`yamllint==${YAMLLINT_VERSION}`,
		'yamllint',
		'-f',
		'parsable',
		'-c',
		config,
		'.',
	];
}

const LINE = /^(.+):(\d+):(\d+): \[(error|warning)\] (.*) \(([^()]+)\)$/;

// Причина сбоя: ошибка uv (`error: …`), иначе последняя непустая строка stderr (traceback Python
// кончается строкой исключения), иначе код выхода.
function reason(run: GuardrailRun): string {
	const lines = run.err
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l !== '');
	return lines.find((l) => l.startsWith('error: ')) ?? lines.at(-1) ?? failureReason(run);
}

// Разбор: код 0 или 1 и пустой stderr; иначе недоступность. Каждая непустая строка stdout — находка
// (`[error]` и `[warning]`); код 1 есть тогда и только тогда, когда есть `[error]`.
export function parseYamllint(run: GuardrailRun): GuardrailViolation[] | Unavailable {
	if (run.err.trim() !== '' || (run.code !== 0 && run.code !== 1)) {
		return { unavailable: reason(run) };
	}
	const found: GuardrailViolation[] = [];
	let errors = 0;
	for (const text of run.out.split('\n')) {
		if (text.trim() === '') continue;
		const m = LINE.exec(text);
		if (m === null) return { unavailable: 'output has an unexpected shape: lines' };
		const [, path = '', line = '', , level, message = '', rule = ''] = m;
		if (level === 'error') errors += 1;
		found.push({
			tool: 'yamllint',
			rule,
			path: path.startsWith('./') ? path.slice(2) : path,
			line: Number(line),
			message,
		});
	}
	if (run.code === 1 && errors === 0) return { unavailable: 'exited with 1 and reported no error' };
	if (run.code === 0 && errors > 0) return { unavailable: 'exited with 0 and reported an error' };
	return found;
}
