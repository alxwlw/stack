import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { failureReason, type GuardrailRun, type Unavailable } from './guardrails-port.ts';

// Код выхода «нашёл секрет». У gitleaks `--exit-code N` меняет только его: чистый скан даёт 0, а
// фатальная ошибка (битый конфиг, нет цели) — 1 при любом N. Код 3 отделяет находку от сбоя.
export const GITLEAKS_LEAKS_EXIT = 3;

// Файл настроек засева в корне репозитория: gitleaks ищет его сам, а для `git` его передаёт `--config`.
export const GITLEAKS_CONFIG_FILE = '.gitleaks.toml';

// Общие флаги. `--report-path -` — отчёт JSON на stdout, а баннер и лог остаются в stderr, разбор
// не зависит от файла на диске. `--redact` — значение секрета не попадает ни в отчёт, ни в лог.
// Уровень лога `info` и НИКОГДА `trace`: на `trace` даже с `--redact` stderr печатает секреты
// подавленных находок (`gitleaks:allow`, stopwords).
const COMMON = [
	'--redact',
	'--no-banner',
	'--no-color',
	'--log-level',
	'info',
	'--exit-code',
	String(GITLEAKS_LEAKS_EXIT),
	'--report-format',
	'json',
	'--report-path',
	'-',
];

// Скан файлов текущего каталога (cwd — копия отслеживаемых файлов, см. copyTracked).
export function gitleaksDirArgv(): string[] {
	return ['dir', ...COMMON, '.'];
}

// Скан коммитов диапазона: `--log-opts` заменяет аргументы git log по умолчанию. cwd — копия
// файлов, `root` — репозиторий; конфиг передаётся явно, потому что от cwd его `[extend]` разрешается
// так же, как у `dir`.
export function gitleaksGitArgv(root: string, range: string, withConfig: boolean): string[] {
	return [
		'git',
		...COMMON,
		`--log-opts=${range}`,
		...(withConfig ? ['--config', GITLEAKS_CONFIG_FILE] : []),
		root,
	];
}

export interface GitleaksLeak {
	rule: string;
	path: string;
	line: number;
	commit: string;
	description: string;
}

// oxlint-disable-next-line no-control-regex -- ESC в цветовых кодах ANSI: строки FTL окрашены вопреки `--no-color`
const ANSI = /\x1b\[[0-9;]*m/g;
const LOG_LINE = /^\d{1,2}:\d{2}(?:AM|PM) (ERR|FTL) (.*)$/;
const SHAPE = 'output has an unexpected shape: findings';

// Разбор отчёта. Читаются только RuleID, File, StartLine, Description и Commit: Secret, Match и
// Message — значение секрета — не копируются никуда. stdout в причину недоступности не попадает.
export function parseGitleaks(run: GuardrailRun): GitleaksLeak[] | Unavailable {
	const err = run.err.replace(ANSI, '');
	for (const line of err.split('\n')) {
		const m = LOG_LINE.exec(line.trimEnd());
		// Сбой git внутри `gitleaks git` — код 0 и `[]`: признак только строка ERR в stderr.
		if (m) return { unavailable: `${m[1]} ${m[2]}` };
	}
	if (run.code !== 0 && run.code !== GITLEAKS_LEAKS_EXIT) {
		const panic = err.split('\n').find((l) => l.startsWith('panic: '));
		return { unavailable: panic?.trimEnd() ?? failureReason({ ...run, err }) };
	}
	let data: unknown;
	try {
		data = JSON.parse(run.out.trim());
	} catch {
		return { unavailable: 'output is not JSON' };
	}
	if (!Array.isArray(data)) return { unavailable: SHAPE };
	const leaks: GitleaksLeak[] = [];
	for (const item of data as unknown[]) {
		if (typeof item !== 'object' || item === null) return { unavailable: SHAPE };
		const f = item as Record<string, unknown>;
		if (
			typeof f.RuleID !== 'string' ||
			typeof f.File !== 'string' ||
			typeof f.Description !== 'string' ||
			typeof f.Commit !== 'string' ||
			typeof f.StartLine !== 'number'
		) {
			return { unavailable: SHAPE };
		}
		leaks.push({
			rule: f.RuleID,
			path: f.File,
			line: f.StartLine,
			commit: f.Commit,
			description: f.Description,
		});
	}
	if (run.code === 0 && leaks.length > 0) {
		return { unavailable: 'exited with 0 and reported findings' };
	}
	if (run.code === GITLEAKS_LEAKS_EXIT && leaks.length === 0) {
		return { unavailable: `exited with ${GITLEAKS_LEAKS_EXIT} and reported nothing` };
	}
	return leaks;
}

// Копия файлов в новый каталог по тем же относительным путям: gitleaks `dir` берёт один путь, а cwd
// решает, где искать конфиг засева, `[extend]` и файл игнора. Сбой — каталог удалён и `unavailable`;
// каталог удаляет вызывающий.
export function copyTracked(root: string, files: readonly string[]): { dir: string } | Unavailable {
	const dir = mkdtempSync(join(tmpdir(), 'stack-gitleaks-'));
	for (const path of files) {
		try {
			const dst = join(dir, path);
			mkdirSync(dirname(dst), { recursive: true });
			copyFileSync(join(root, path), dst);
		} catch (e) {
			rmSync(dir, { recursive: true, force: true });
			return { unavailable: `copy ${path}: ${e instanceof Error ? e.message : String(e)}` };
		}
	}
	return { dir };
}
