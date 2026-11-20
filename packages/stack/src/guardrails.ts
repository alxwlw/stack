// Читатель группы guardrails: отслеживаемые файлы, бинарники ровно версии пина, запуск actionlint и
// shellcheck один раз за прогон. Всё внешнее идёт через порт; правило и пометки — guardrails-rule.ts.

import { actionlintArgv, parseActionlint } from './guardrails-actionlint.ts';
import { locateTool, repoPins } from './guardrails-bin.ts';
import {
	regularFiles,
	shellScripts,
	TRACKED_FILES_ARGV,
	trackedFiles,
	workflowFiles,
} from './guardrails-files.ts';
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
	if (workflows.length === 0 && scripts.length === 0) {
		return { tools: { actionlint: none, shellcheck: none } };
	}

	const pins = repoPins(prototools);
	// shellcheck нужен обоим наборам: скриптам — как инструмент, workflow — как пиненный бинарник actionlint.
	const shellcheck = locateTool('shellcheck', pins, port);
	let shellcheckPart: ToolPart = none;
	if (isUnavailable(shellcheck)) shellcheckPart = shellcheck;
	else if (scripts.length > 0) {
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
					actionlintArgv(isUnavailable(shellcheck) ? undefined : shellcheck.bin, workflows),
					workflows.length,
					port,
					parseActionlint,
				);
	}
	return { tools: { actionlint: actionlintPart, shellcheck: shellcheckPart } };
}
