import type { CheckReport, SyncResult } from './check.ts';
import { type Held, isHeld } from './exceptions.ts';
import { type Finding, isDrift } from './findings.ts';

// Единственное место, где находка становится строкой вывода: строка блокирующей, строка удержанной,
// подсказка и сборки вывода `check` и `sync`. Каждая строка несёт свой канал.

export type Stream = 'out' | 'err';

export interface Line {
	stream: Stream;
	text: string;
}

/** Порт печати: одна строка в один канал. */
export type Print = (stream: Stream, line: string) => void;

export function findingLine(f: Finding): string {
	return `${f.code}: ${f.target} — ${f.message}`;
}

export function allowedLine(f: Held): string {
	return `allowed (${f.suppressedBy.reason}): ${f.target} — ${f.message}`;
}

// Подсказка под находками: `<command> sync` закрывает только Drift; правила deps.ts — отчёт без действия.
export function fixHint(blocking: Finding[], command: string): string {
	const total = blocking.length;
	const bySync = blocking.filter(isDrift).length;
	if (bySync === total) return `${total} finding(s). Fix with: ${command} sync`;
	if (bySync === 0) {
		return `${total} finding(s). ${command} sync does not fix these — fix them by hand (see above)`;
	}
	return `${total} finding(s): ${bySync} fixable with: ${command} sync, ${total - bySync} to fix by hand (see above)`;
}

const err = (text: string): Line => ({ stream: 'err', text });
const out = (text: string): Line => ({ stream: 'out', text });

/** Пометки, удержанные, блокирующие, пустая строка и подсказка — всё в err, код 1; без блокирующих
 *  последней идёт `canon: no drift` в out, код 0. */
export function checkOutput(report: CheckReport, command: string): { lines: Line[]; code: 0 | 1 } {
	const blocking = report.findings.filter((f) => !isHeld(f));
	const lines = [
		...report.notes.map(err),
		...report.findings.filter(isHeld).map((f) => err(allowedLine(f))),
		...blocking.map((f) => err(findingLine(f))),
	];
	if (blocking.length === 0) return { lines: [...lines, out('canon: no drift')], code: 0 };
	return { lines: [...lines, err(''), err(fixHint(blocking, command))], code: 1 };
}

/** Удержанные — в err, затем правки и итог — в out. */
export function syncOutput(result: SyncResult): Line[] {
	return [
		...result.held.map((h) => err(allowedLine(h))),
		...result.applied.map((d) => out(d.fix)),
		out(`canon ${result.applied.length === 0 ? 'already up to date' : 'applied'}`),
	];
}

export function printLines(print: Print, lines: readonly Line[]): void {
	for (const line of lines) print(line.stream, line.text);
}
