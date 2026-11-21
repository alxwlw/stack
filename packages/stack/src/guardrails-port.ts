import { spawnSync } from 'node:child_process';

// Общие типы группы guardrails. Внешние вызовы идут через один порт: адаптер — в cli.ts, тесты
// подставляют значения.

export interface GuardrailRun {
	code: number;
	out: string;
	err: string;
}

// cwd — каталог процесса; без него корень репозитория (spawnRunner).
export type GuardrailRunner = (cmd: string, argv: string[], cwd?: string) => GuardrailRun;

export interface GuardrailsPort {
	run: GuardrailRunner;
	env: NodeJS.ProcessEnv;
	// --base команды check: база PR для скана коммитов gitleaks; без неё — окружение Actions.
	base?: string;
}

export const GUARDRAIL_TOOLS = ['actionlint', 'shellcheck', 'gitleaks'] as const;
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

// Адаптер порта: процесс в корне репозитория (или в cwd вызова), окружение родителя без
// SHELLCHECK_OPTS, GITLEAKS_CONFIG и GITLEAKS_CONFIG_TOML: первая подменяет порог shellcheck, две
// другие — конфиг gitleaks целиком (в обход конфига засева репозитория и его `[extend]`), и чужая
// настройка из окружения сделала бы прогон другим, чем у соседа. Не запустился — код -1 и причина
// в stderr.
export function spawnRunner(root: string): GuardrailRunner {
	const env = { ...process.env };
	delete env.SHELLCHECK_OPTS;
	delete env.GITLEAKS_CONFIG;
	delete env.GITLEAKS_CONFIG_TOML;
	// Вывод `git log` внутри `gitleaks git` зависит от конфига git пользователя или репозитория, и
	// gitleaks разбирает его как есть. При color.ui или color.diff = always печатаются escape-коды:
	// gitleaks не разбирает дифф, выходит с 0 и `[]` без строки ERR, и секрет в коммите PR пропущен.
	// При format.pretty = oneline, raw или format:… и log.date = relative находка приходит с пустым
	// Commit, при log.abbrevCommit = true — с сокращённым: сообщение `(commit )` и отпечаток для
	// ignore-строки расходятся с CI. Конфиг git не отключается целиком (в CI в нём safe.directory),
	// поэтому ключи заданы нейтрально парами GIT_CONFIG_*, дописанными к уже заданным.
	// Остальные ключи проверены на gitleaks 8.30.1 и находок не меняют: diff.noprefix,
	// diff.mnemonicPrefix, log.showSignature.
	const count = Number.parseInt(env.GIT_CONFIG_COUNT ?? '', 10);
	const n = Number.isInteger(count) && count >= 0 ? count : 0;
	const neutral: [string, string][] = [
		['color.ui', 'never'],
		['color.diff', 'never'],
		['format.pretty', 'medium'],
		['log.date', 'default'],
		['log.abbrevCommit', 'false'],
	];
	env.GIT_CONFIG_COUNT = String(n + neutral.length);
	neutral.forEach(([key, value], i) => {
		env[`GIT_CONFIG_KEY_${n + i}`] = key;
		env[`GIT_CONFIG_VALUE_${n + i}`] = value;
	});
	return (cmd, argv, cwd) => {
		const r = spawnSync(cmd, argv, { cwd: cwd ?? root, env, encoding: 'utf8', maxBuffer: 1 << 30 });
		if (r.error) return { code: -1, out: '', err: `${cmd}: ${r.error.message}` };
		return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
	};
}
