import { closeSync, lstatSync, openSync, readSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

import { failureReason, type GuardrailRun, type Unavailable } from './guardrails-port.ts';
import { pinSiteKind } from './toolchain-pins.ts';

// Отслеживаемые файлы: `git ls-files -z` в корне репозитория, зовётся как run('git', TRACKED_FILES_ARGV).
export const TRACKED_FILES_ARGV: readonly string[] = ['ls-files', '-z'];

const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const SHELLS = new Set(['sh', 'bash', 'dash', 'ksh']);
const SHEBANG_BYTES = 256;

export function trackedFiles(run: GuardrailRun): string[] | Unavailable {
	if (run.code !== 0) return { unavailable: failureReason(run) };
	return run.out.split('\0').filter((p) => p !== '');
}

// Обычные файлы на диске: удалённые из рабочего дерева, симлинки и gitlink выпадают.
export function regularFiles(root: string, paths: readonly string[]): string[] {
	return paths.filter((p) => {
		try {
			return lstatSync(join(root, p)).isFile();
		} catch {
			return false;
		}
	});
}

export function workflowFiles(paths: readonly string[]): string[] {
	return paths.filter((p) => WORKFLOW.test(p));
}

// Dockerfile любого вида (`Dockerfile`, `Dockerfile.prod`, `web.Dockerfile`) в порядке входа; без SKIP:
// отслеживаемый `build/Dockerfile` — вход.
export function dockerfiles(paths: readonly string[]): string[] {
	return paths.filter((p) => pinSiteKind(p) === 'dockerfile');
}

export function isShellShebang(firstLine: string): boolean {
	if (!firstLine.startsWith('#!')) return false;
	const tokens = firstLine
		.slice(2)
		.split(/\s+/)
		.filter((t) => t !== '');
	const first = tokens[0];
	if (first === undefined) return false;
	let interpreter = basename(first);
	if (interpreter === 'env') {
		const next = tokens.slice(1).find((t) => !t.startsWith('-'));
		if (next === undefined) return false;
		interpreter = basename(next);
	}
	return SHELLS.has(interpreter);
}

function firstLineOf(path: string): string | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(path, 'r');
		const buf = Buffer.alloc(SHEBANG_BYTES);
		const n = readSync(fd, buf, 0, SHEBANG_BYTES, 0);
		return buf.toString('latin1', 0, n).split('\n')[0];
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

export function shellScripts(root: string, paths: readonly string[]): string[] {
	return paths.filter((p) => {
		const ext = extname(p);
		if (ext === '.sh' || ext === '.bash') return true;
		if (ext !== '') return false;
		const line = firstLineOf(join(root, p));
		return line !== undefined && isShellShebang(line);
	});
}
