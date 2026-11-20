// Читатель группы guardrails: отслеживаемые файлы, бинарники ровно версии пина, запуск actionlint,
// shellcheck и gitleaks один раз за прогон. Всё внешнее идёт через порт; правило и пометки — guardrails-rule.ts.

import { rmSync } from 'node:fs';

import { actionlintArgv, parseActionlint } from './guardrails-actionlint.ts';
import { locateTool, repoPins } from './guardrails-bin.ts';
import {
	regularFiles,
	shellScripts,
	TRACKED_FILES_ARGV,
	trackedFiles,
	workflowFiles,
} from './guardrails-files.ts';
import { copyTracked, gitleaksDirArgv, parseGitleaks } from './guardrails-gitleaks.ts';
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

export type GuardrailsOutcome = Unavailable | { tools: Record<GuardrailTool, ToolPart> };

function isUnavailable(v: object): v is Unavailable {
	return 'unavailable' in v;
}

// Бинарник найден, файлы есть — инструмент запущен на них; разбор — parse.
function runPart(
	located: { bin: string; version: string },
	argv: string[],
	files: number,
	port: GuardrailsPort,
	parse: (run: ReturnType<GuardrailsPort['run']>) => GuardrailViolation[] | Unavailable,
): ToolPart {
	const parsed = parse(port.run(located.bin, argv));
	if (!Array.isArray(parsed)) return parsed;
	return { version: located.version, files, violations: parsed };
}

// Копия отслеживаемых обычных файлов на время fn; каталог удаляется при любом исходе. Вход — только
// вывод regularFiles: copyTracked не проверяет, что пути остаются внутри каталога. Единственное
// место копии и её уборки: второй прогон gitleaks (коммиты PR) заходит сюда же.
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

export function readGuardrails(
	root: string,
	prototools: string | undefined,
	port: GuardrailsPort,
): GuardrailsOutcome {
	const tracked = trackedFiles(port.run('git', [...TRACKED_FILES_ARGV]));
	if (isUnavailable(tracked)) return tracked;
	const files = regularFiles(root, tracked);
	const workflows = workflowFiles(files);
	const scripts = shellScripts(root, files);

	const none: ToolPart = { skipped: 'no files' };
	if (files.length === 0) {
		return { tools: { actionlint: none, shellcheck: none, gitleaks: none } };
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

	// Копия файлов всегда непуста (files.length > 0), поэтому gitleaks ищется всегда.
	let gitleaksPart: ToolPart;
	const gitleaks = locateTool('gitleaks', pins, port);
	if (isUnavailable(gitleaks)) gitleaksPart = gitleaks;
	else {
		gitleaksPart = withTrackedCopy(root, files, (dir): ToolPart => {
			const parsed = parseGitleaks(port.run(gitleaks.bin, gitleaksDirArgv(), dir));
			if (!Array.isArray(parsed)) return parsed;
			return {
				version: gitleaks.version,
				files: files.length,
				violations: parsed.map((leak) => ({
					tool: 'gitleaks',
					rule: leak.rule,
					path: leak.path,
					line: leak.line,
					message: leak.description || 'secret detected',
				})),
			};
		});
	}
	return {
		tools: { actionlint: actionlintPart, shellcheck: shellcheckPart, gitleaks: gitleaksPart },
	};
}
