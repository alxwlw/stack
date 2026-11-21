// Читатель группы guardrails: отслеживаемые файлы, бинарники ровно версии пина, запуск actionlint,
// shellcheck, gitleaks, hadolint, markdownlint-cli2 и yamllint за прогон; gitleaks запускается дважды
// (файлы и коммиты PR), когда скан коммитов идёт. Всё внешнее идёт через порт; правило и пометки — guardrails-rule.ts.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { actionlintArgv, parseActionlint } from './guardrails-actionlint.ts';
import { locateTool, repoPins } from './guardrails-bin.ts';
import { type CommitsPart, mergeBase, mergeBaseArgv, prBase } from './guardrails-commits.ts';
import {
	dockerfiles,
	markdownFiles,
	regularFiles,
	shellScripts,
	TRACKED_FILES_ARGV,
	trackedFiles,
	workflowFiles,
	yamlFiles,
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
import { markdownlintCommand, parseMarkdownlint } from './guardrails-markdownlint.ts';
import {
	type GuardrailsPort,
	type GuardrailTool,
	type GuardrailViolation,
	type Unavailable,
} from './guardrails-port.ts';
import { parseShellcheck, shellcheckArgv } from './guardrails-shellcheck.ts';
import {
	parseYamllint,
	YAMLLINT_CONFIG_FILES,
	YAMLLINT_VERSION,
	yamllintArgv,
	yamllintConfig,
} from './guardrails-yamllint.ts';

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
// PR), hadolint, markdownlint-cli2 и yamllint.
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
// поэтому действует только отслеживаемый конфиг hadolint копии, иначе встроенный.
function readHadolint(
	set: readonly string[],
	hadolint: { bin: string; version: string },
	dir: string,
	port: GuardrailsPort,
): ToolPart {
	let home: string;
	try {
		home = mkdtempSync(join(tmpdir(), 'stack-home-'));
	} catch (e) {
		// Как в copyTracked: нет или недоступен TMPDIR — недоступность, а не исключение из читателя.
		return { unavailable: `home: ${e instanceof Error ? e.message : String(e)}` };
	}
	try {
		return runPart(hadolint, hadolintArgv(set), set.length, port, parseHadolint, dir, {
			HOME: home,
			XDG_CONFIG_HOME: home,
		});
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

// yamllint запускается через uv из пина в копии: версия yamllint — константа, а не версия uv.
function readYamllint(
	set: readonly string[],
	config: string,
	uv: { bin: string },
	dir: string,
	port: GuardrailsPort,
): ToolPart {
	return runPart(
		{ bin: uv.bin, version: YAMLLINT_VERSION },
		yamllintArgv(config),
		set.length,
		port,
		parseYamllint,
		dir,
	);
}

// markdownlint-cli2 идёт раннером stack под bun в копии: версия — из отчёта раннера (точная
// зависимость stack), число в пометке — число кандидатов (*.md, *.mdx), а не файлов после игноров.
function readMarkdownlint(set: readonly string[], dir: string, port: GuardrailsPort): ToolPart {
	const { cmd, argv } = markdownlintCommand();
	const parsed = parseMarkdownlint(port.run(cmd, argv, dir));
	if ('unavailable' in parsed) return parsed;
	return { version: parsed.version, files: set.length, violations: parsed.violations };
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
			tools: {
				actionlint: none,
				shellcheck: none,
				gitleaks: none,
				hadolint: none,
				'markdownlint-cli2': none,
				yamllint: none,
			},
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

	// Одна копия на прогон: в ней gitleaks, hadolint, markdownlint-cli2 и yamllint. Бинарники ищутся до
	// копии; она создаётся, когда её нужно найденному бинарнику или непустому набору Markdown.
	// Копия файлов всегда непуста (files.length > 0), поэтому gitleaks ищется всегда; hadolint — только при Dockerfile среди файлов, markdownlint-cli2 —
	// только при Markdown (бинарника нет: раннер — скрипт stack), yamllint — только при YAML и конфиге
	// среди них (иначе uv не ищется).
	const gitleaks = locateTool('gitleaks', pins, port);
	const dockerSet = dockerfiles(files);
	const hadolint = dockerSet.length > 0 ? locateTool('hadolint', pins, port) : undefined;
	const markdownSet = markdownFiles(files);
	const yamlSet = yamlFiles(files);
	const yamlConfig = yamllintConfig(files);
	const uv =
		yamlSet.length > 0 && yamlConfig !== undefined ? locateTool('uv', pins, port) : undefined;
	let gitleaksPart: ToolPart = isUnavailable(gitleaks) ? gitleaks : none;
	let hadolintPart: ToolPart =
		hadolint === undefined ? none : isUnavailable(hadolint) ? hadolint : none;
	let markdownlintPart: ToolPart = none;
	let yamllintPart: ToolPart = none;
	if (yamlSet.length > 0) {
		if (yamlConfig === undefined) {
			yamllintPart = {
				unavailable: `no yamllint config among tracked files (${YAMLLINT_CONFIG_FILES[0]})`,
			};
		} else if (uv !== undefined && isUnavailable(uv)) yamllintPart = uv;
	}
	let commits: CommitsPart = { skipped: 'gitleaks unavailable' };
	const gitleaksReady = isUnavailable(gitleaks) ? undefined : gitleaks;
	const hadolintReady = hadolint === undefined || isUnavailable(hadolint) ? undefined : hadolint;
	const uvReady = uv === undefined || isUnavailable(uv) ? undefined : uv;
	if (
		gitleaksReady !== undefined ||
		hadolintReady !== undefined ||
		markdownSet.length > 0 ||
		uvReady !== undefined
	) {
		const copied = withTrackedCopy(root, files, (dir) => {
			if (gitleaksReady !== undefined) {
				({ part: gitleaksPart, commits } = readGitleaks(root, files, gitleaksReady, dir, port));
			}
			if (hadolintReady !== undefined) {
				hadolintPart = readHadolint(dockerSet, hadolintReady, dir, port);
			}
			if (markdownSet.length > 0) {
				markdownlintPart = readMarkdownlint(markdownSet, dir, port);
			}
			if (uvReady !== undefined && yamlConfig !== undefined) {
				yamllintPart = readYamllint(yamlSet, yamlConfig, uvReady, dir, port);
			}
			return null;
		});
		// Сбой копии — недоступность у каждой части, которая в копии шла бы.
		if (copied !== null) {
			if (gitleaksReady !== undefined) gitleaksPart = { ...copied };
			if (hadolintReady !== undefined) hadolintPart = { ...copied };
			if (markdownSet.length > 0) markdownlintPart = { ...copied };
			if (uvReady !== undefined) yamllintPart = { ...copied };
		}
	}
	return {
		tools: {
			actionlint: actionlintPart,
			shellcheck: shellcheckPart,
			gitleaks: gitleaksPart,
			hadolint: hadolintPart,
			'markdownlint-cli2': markdownlintPart,
			yamllint: yamllintPart,
		},
		commits,
	};
}
