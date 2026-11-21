import { parseDocument } from 'yaml';

import type { Finding } from './findings.ts';

export const WORKFLOW_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$/;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Наличие ключа — значение не null: `permissions:` без значения ключом не считается.
function has(o: Obj, key: string): boolean {
	return o[key] !== null && o[key] !== undefined;
}

function firstLine(text: string): string {
	return text.split('\n')[0] ?? '';
}

// Только `workflow_call` в `on` (строка, список или ключи карты): вызывающий задаёт группу сам.
function onlyWorkflowCall(on: unknown): boolean {
	if (typeof on === 'string') return on === 'workflow_call';
	if (Array.isArray(on)) return on.length > 0 && on.every((t) => t === 'workflow_call');
	if (isObj(on)) {
		const keys = Object.keys(on);
		return keys.length === 1 && keys[0] === 'workflow_call';
	}
	return false;
}

// Ключ верхнего уровня или у каждого джоба: часть сообщения либо undefined.
function topOrJobs(name: string, root: Obj, jobs: [string, Obj][]): string | undefined {
	if (has(root, name)) return undefined;
	if (jobs.length === 0) return `${name} (top level)`;
	const bare = jobs.filter(([, job]) => !has(job, name)).map(([id]) => id);
	if (bare.length === 0) return undefined;
	return `${name} (top level, or in ${bare.join(', ')})`;
}

function check(path: string, text: string): Finding | undefined {
	const finding = (message: string): Finding => ({
		code: 'workflow-hygiene',
		target: path,
		message,
	});
	const doc = parseDocument(text);
	const error = doc.errors[0];
	if (error) return finding(`cannot read: ${firstLine(error.message)}`);
	let root: unknown;
	try {
		root = doc.toJS();
	} catch (e) {
		return finding(`cannot read: ${firstLine(e instanceof Error ? e.message : String(e))}`);
	}
	if (!isObj(root)) return finding('cannot read: not a mapping');
	const jobs: [string, Obj][] = isObj(root.jobs)
		? Object.entries(root.jobs).map(([id, job]): [string, Obj] => [id, isObj(job) ? job : {}])
		: [];
	const timeouts = jobs
		.filter(([, job]) => !Object.hasOwn(job, 'uses') && !has(job, 'timeout-minutes'))
		.map(([id]) => id);
	const parts = [
		timeouts.length > 0 ? `timeout-minutes (${timeouts.join(', ')})` : undefined,
		topOrJobs('permissions', root, jobs),
		onlyWorkflowCall(root.on) ? undefined : topOrJobs('concurrency', root, jobs),
	].filter((p): p is string => p !== undefined);
	return parts.length > 0 ? finding(`missing ${parts.join('; ')}`) : undefined;
}

export function checkWorkflowHygiene(files: ReadonlyMap<string, string>): Finding[] {
	return [...files.keys()]
		.filter((path) => WORKFLOW_FILE.test(path))
		.toSorted()
		.flatMap((path) => check(path, files.get(path) as string) ?? []);
}
