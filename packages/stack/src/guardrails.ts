// Читатель группы guardrails: отслеживаемые файлы, бинарники ровно версии пина, запуск actionlint,
// shellcheck, gitleaks и hadolint за прогон; gitleaks запускается дважды (файлы и коммиты PR), когда
// скан коммитов идёт. Всё внешнее идёт через порт; правило и пометки — guardrails-rule.ts.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { actionlintArgv, parseActionlint } from './guardrails-actionlint.ts';
import { locateTool, repoPins } from './guardrails-bin.ts';
import { type CommitsPart, mergeBase, mergeBaseArgv, prBase } from './guardrails-commits.ts';
import {
	dockerfiles,
	regularFiles,
	shellScripts,
	TRACKED_FILES_ARGV,
	trackedFiles,
	workflowFiles,
} from './guardrails-files.ts';
import {
	copyTracked,
	GITLEAKS_CONFIG_FILE,
	gitleaksDirArgv,
	gitleaksGitArgv,
	type GitleaksLeak,
	parseGitleaks,
} from './guardrails-gitleaks.ts';
import { hadolintArgv, parseHadolint } from './guardrails-hadolint.ts';
import {
	type GuardrailsPort,
	type GuardrailTool,
	type GuardrailViolation,
	type Unavailable,
} from './guardrails-port.ts';
import { parseShellcheck, shellcheckArgv } from './guardrails-shellcheck.ts';

export type ToolPart =
	| { skipped: 'no files' }
	| Unavailable
	| { version: string; files: number; violations: GuardrailViolation[] };

export type GuardrailsOutcome =
	| Unavailable
	| { tools: Record<GuardrailTool, ToolPart>; commits: CommitsPart };

function isUnavailable(v: object): v is Unavailable {
	return 'unavailable' in v;
}

// Бинарник найден, файлы есть — инструмент запущен на них; разбор — parse. cwd и env — каталог и
// переопределения окружения процесса (порт: корень репозитория и окружение родителя без них).
function runPart(
	located: { bin: string; version: string },
	argv: string[],
	files: number,
	port: GuardrailsPort,
	parse: (run: ReturnType<GuardrailsPort['run']>) => GuardrailViolation[] | Unavailable,
	cwd?: string,
	env?: Readonly<Record<string, string>>,
): ToolPart {
	const parsed = parse(port.run(located.bin, argv, cwd, env));
	if (!Array.isArray(parsed)) return parsed;
	return { version: located.version, files, violations: parsed };
}

// Копия отслеживаемых обычных файлов на время fn; каталог удаляется при любом исходе. Вход — только
// вывод regularFiles: copyTracked не проверяет, что пути остаются внутри каталога. Единственное
// место копии и её уборки: за прогон одна копия, и в ней идут оба прогона gitleaks (файлы и коммиты
// PR) и hadolint.
function withTrackedCopy<T>(
	root: string,
	files: readonly string[],
	fn: (dir: string) => T,
): T | Unavailable {
	const copy = copyTracked(root, files);
	if (isUnavailable(copy)) return copy;
	try {
		return fn(copy.dir);
	} finally {
		rmSync(copy.dir, { recursive: true, force: true });
	}
}

function toViolation(leak: GitleaksLeak, suffix = ''): GuardrailViolation {
	return {
		tool: 'gitleaks',
		rule: leak.rule,
		path: leak.path,
		line: leak.line,
		message: `${leak.description || 'secret detected'}${suffix}`,
	};
}

// Часть gitleaks и часть коммитов; обе идут в копии файлов dir (cwd обоих запусков).
function readGitleaks(
	root: string,
	files: readonly string[],
	gitleaks: { bin: string; version: string },
	dir: string,
	port: GuardrailsPort,
): { part: ToolPart; commits: CommitsPart } {
	const parsed = parseGitleaks(port.run(gitleaks.bin, gitleaksDirArgv(), dir));
	if (!Array.isArray(parsed)) return { part: parsed, commits: { skipped: 'gitleaks unavailable' } };
	return {
		part: {
			version: gitleaks.version,
			files: files.length,
			violations: parsed.map((leak) => toViolation(leak)),
		},
		commits: readCommits(root, files, gitleaks.bin, dir, port),
	};
}

// hadolint ищет конфиг в cwd, затем в XDG_CONFIG_HOME и HOME: оба указывают на новый пустой каталог,
// поэтому действует только отслеживаемый `.hadolint.yaml` копии, иначе встроенный.
function readHadolint(
	set: readonly string[],
	hadolint: { bin: string; version: string },
	dir: string,
	port: GuardrailsPort,
): ToolPart {
	const home = mkdtempSync(join(tmpdir(), 'stack-home-'));
	try {
		return runPart(hadolint, hadolintArgv(set), set.length, port, parseHadolint, dir, {
			HOME: home,
			XDG_CONFIG_HOME: home,
		});
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

function readCommits(
	root: string,
	files: readonly string[],
	bin: string,
	dir: string,
	port: GuardrailsPort,
): CommitsPart {
	const pr = prBase(port.base, port.env);
	if (!('base' in pr)) return pr;
	const mb = mergeBase(port.run('git', mergeBaseArgv(pr.base), root), pr.base);
	if (typeof mb !== 'string') return mb;
	const range = `${mb}..HEAD`;
	const parsed = parseGitleaks(
		port.run(bin, gitleaksGitArgv(root, range, files.includes(GITLEAKS_CONFIG_FILE)), dir),
	);
	if (!Array.isArray(parsed)) return parsed;
	return {
		range: `${mb.slice(0, 12)}..HEAD`,
		violations: parsed.map((leak) => toViolation(leak, ` (commit ${leak.commit.slice(0, 12)})`)),
	};
}

export function readGuardrails(
	repoRoot: string,
	prototools: string | undefined,
	port: GuardrailsPort,
): GuardrailsOutcome {
	// Скан коммитов идёт с cwd = копия и зовёт `git -C <корень>`: относительный корень там не найти.
	const root = resolve(repoRoot);
	const tracked = trackedFiles(port.run('git', [...TRACKED_FILES_ARGV]));
	if (isUnavailable(tracked)) return tracked;
	const files = regularFiles(root, tracked);
	const workflows = workflowFiles(files);
	const scripts = shellScripts(root, files);

	const none: ToolPart = { skipped: 'no files' };
	if (files.length === 0) {
		return {
			tools: { actionlint: none, shellcheck: none, gitleaks: none, hadolint: none },
			commits: { skipped: 'no files' },
		};
	}

	const pins = repoPins(prototools);
	// shellcheck нужен обоим наборам: скриптам — как инструмент, workflow — как пиненный бинарник actionlint.
	const needShellcheck = workflows.length > 0 || scripts.length > 0;
	const shellcheck = needShellcheck ? locateTool('shellcheck', pins, port) : undefined;
	let shellcheckPart: ToolPart = none;
	if (shellcheck !== undefined && isUnavailable(shellcheck)) shellcheckPart = shellcheck;
	else if (shellcheck !== undefined && scripts.length > 0) {
		shellcheckPart = runPart(
			shellcheck,
			shellcheckArgv(scripts),
			scripts.length,
			port,
			parseShellcheck,
		);
	}

	let actionlintPart: ToolPart = none;
	if (workflows.length > 0) {
		const actionlint = locateTool('actionlint', pins, port);
		actionlintPart = isUnavailable(actionlint)
			? actionlint
			: runPart(
					actionlint,
					actionlintArgv(
						shellcheck === undefined || isUnavailable(shellcheck) ? undefined : shellcheck.bin,
						workflows,
					),
					workflows.length,
					port,
					parseActionlint,
				);
	}

	// Одна копия на прогон: в ней gitleaks и hadolint. Бинарники ищутся до копии, и копия не создаётся,
	// когда ни один из них не найден. Копия файлов всегда непуста (files.length > 0), поэтому gitleaks
	// ищется всегда; hadolint — только при Dockerfile среди файлов.
	const gitleaks = locateTool('gitleaks', pins, port);
	const dockerSet = dockerfiles(files);
	const hadolint = dockerSet.length > 0 ? locateTool('hadolint', pins, port) : undefined;
	let gitleaksPart: ToolPart = isUnavailable(gitleaks) ? gitleaks : none;
	let hadolintPart: ToolPart =
		hadolint === undefined ? none : isUnavailable(hadolint) ? hadolint : none;
	let commits: CommitsPart = { skipped: 'gitleaks unavailable' };
	const gitleaksReady = isUnavailable(gitleaks) ? undefined : gitleaks;
	const hadolintReady = hadolint === undefined || isUnavailable(hadolint) ? undefined : hadolint;
	if (gitleaksReady !== undefined || hadolintReady !== undefined) {
		const copied = withTrackedCopy(root, files, (dir) => {
			if (gitleaksReady !== undefined) {
				({ part: gitleaksPart, commits } = readGitleaks(root, files, gitleaksReady, dir, port));
			}
			if (hadolintReady !== undefined) {
				hadolintPart = readHadolint(dockerSet, hadolintReady, dir, port);
			}
			return null;
		});
		// Сбой копии — недоступность у каждой части, которая в копии шла бы.
		if (copied !== null) {
			if (gitleaksReady !== undefined) gitleaksPart = { ...copied };
			if (hadolintReady !== undefined) hadolintPart = { ...copied };
		}
	}
	return {
		tools: {
			actionlint: actionlintPart,
			shellcheck: shellcheckPart,
			gitleaks: gitleaksPart,
			hadolint: hadolintPart,
		},
		commits,
	};
}
