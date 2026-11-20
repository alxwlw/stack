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
	return (cmd, argv, cwd) => {
		const r = spawnSync(cmd, argv, { cwd: cwd ?? root, env, encoding: 'utf8', maxBuffer: 1 << 30 });
		if (r.error) return { code: -1, out: '', err: `${cmd}: ${r.error.message}` };
		return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
	};
}
