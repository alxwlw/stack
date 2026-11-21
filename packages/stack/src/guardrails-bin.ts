// Бинарник инструмента guardrails ровно версии пина `.prototools`: путь из переменной или из
// `proto bin`, затем всегда проба версии. Только она ловит недоверенный `.prototools` (proto молча
// игнорирует пины) и устаревшую переменную.

import { parsePins } from './canon.ts';
import {
	failureReason,
	type GuardrailRun,
	type GuardrailsPort,
	type ProtoTool,
	type Unavailable,
} from './guardrails-port.ts';

export interface LocatedTool {
	bin: string;
	version: string;
}

export const VERSION_ARGV: Readonly<Record<ProtoTool, readonly string[]>> = {
	actionlint: ['-version'],
	shellcheck: ['--version'],
	gitleaks: ['version'],
	hadolint: ['--version'],
};

export function repoPins(prototools: string | undefined): Record<string, string> | Unavailable {
	if (prototools === undefined) return { unavailable: '.prototools is missing' };
	try {
		return parsePins(prototools);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { unavailable: `.prototools does not parse: ${msg}` };
	}
}

export function binVar(tool: ProtoTool): string {
	return `${tool.toUpperCase()}_BIN`;
}

// actionlint и gitleaks: первая строка, если это версия (у gitleaks `version`; вывод `--version`
// другой — `gitleaks version 8.x`, и его проба не принимает); hadolint: первая строка
// `Haskell Dockerfile Linter <v>`; shellcheck: строка `version: <v>`.
export function toolVersion(tool: ProtoTool, out: string): string | undefined {
	if (tool === 'hadolint') {
		return /^Haskell Dockerfile Linter (\d+\.\d+\.\d+)$/.exec(out.split('\n')[0] ?? '')?.[1];
	}
	if (tool === 'actionlint' || tool === 'gitleaks') {
		const first = out.split('\n')[0]?.trim() ?? '';
		return /^\d+\.\d+\.\d+$/.test(first) ? first : undefined;
	}
	return /^version:\s*(\d+\.\d+\.\d+)\s*$/m.exec(out)?.[1];
}

function isUnavailable(v: Record<string, string> | Unavailable): v is Unavailable {
	return typeof v.unavailable === 'string';
}

function firstLine(text: string): string {
	return text.split('\n')[0]?.trim() ?? '';
}

function ndjsonMessage(line: string): { type?: unknown; message?: unknown } | undefined {
	try {
		const v: unknown = JSON.parse(line);
		return typeof v === 'object' && v !== null ? v : undefined;
	} catch {
		return undefined;
	}
}

// `proto bin` печатает голый путь или NDJSON (в окружении агента): путь — message последней строки,
// ошибка — message первой строки с type "error".
export function protoBinPath(run: GuardrailRun): string | Unavailable {
	const lines = run.out.split('\n').filter((l) => l.trim() !== '');
	if (run.code !== 0) {
		for (const l of lines) {
			const m = l.startsWith('{') ? ndjsonMessage(l) : undefined;
			if (m?.type === 'error' && typeof m.message === 'string') {
				const reason = firstLine(m.message);
				if (reason !== '') return { unavailable: reason };
			}
		}
		return { unavailable: failureReason(run) };
	}
	const last = lines.at(-1)?.trim();
	if (last === undefined) return { unavailable: 'printed no path' };
	if (!last.startsWith('{')) return last;
	const m = ndjsonMessage(last);
	if (typeof m?.message === 'string' && m.message.trim() !== '') return m.message.trim();
	return { unavailable: 'printed no path' };
}

export function locateTool(
	tool: ProtoTool,
	pins: Record<string, string> | Unavailable,
	port: GuardrailsPort,
): LocatedTool | Unavailable {
	if (isUnavailable(pins)) return pins;
	const pin = pins[tool];
	if (pin === undefined) return { unavailable: `.prototools has no ${tool} pin` };

	const variable = binVar(tool);
	const fromVar = port.env[variable];
	const viaVar = fromVar !== undefined && fromVar !== '';
	let bin: string;
	if (viaVar) {
		bin = fromVar;
	} else {
		const found = protoBinPath(port.run('proto', ['bin', tool]));
		if (typeof found !== 'string')
			return { unavailable: `proto bin ${tool}: ${found.unavailable}` };
		bin = found;
	}

	const probe = port.run(bin, [...VERSION_ARGV[tool]]);
	if (probe.code !== 0) {
		const origin = viaVar ? `${variable}=${bin}` : bin;
		return { unavailable: `${origin}: ${failureReason(probe)}` };
	}
	const version = toolVersion(tool, probe.out);
	if (version === undefined) return { unavailable: `${bin} printed no ${tool} version` };
	if (version !== pin) {
		const tail = viaVar ? ` (from ${variable})` : '';
		return { unavailable: `${tool} ${version} at ${bin}, .prototools pins ${pin}${tail}` };
	}
	return { bin, version };
}
