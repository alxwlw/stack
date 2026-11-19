import { isMap, isPair, isScalar, parseDocument, visit } from 'yaml';

// Копии пинов тулчейна вне .prototools: версии node, bun, pnpm и proto, повторённые в Dockerfile и
// в workflow. Модуль чистый: находит копии в тексте и переписывает их вставкой по смещениям.
// Workflow разбирается `parseDocument`, но берутся только позиции скаляров, файл не пересобирается
// из дерева: так кавычки, комментарии, отступы и концы строк остаются как были, а в диффе sync
// меняются одни цифры версии.

export type PinSiteKind = 'dockerfile' | 'workflow';
export type PinnedTool = 'node' | 'bun' | 'pnpm' | 'proto';

/** Копия пина: версия пинованного инструмента, записанная в тексте файла. */
export interface PinCopy {
	tool: PinnedTool;
	/** Как записана: 1–3 числа через точку, без суффикса тега и без хэша. */
	version: string;
	/** Номер строки, с 1. */
	line: number;
	/** Смещение начала версии в тексте. */
	start: number;
	/** Смещение конца заменяемого участка: у `pnpm@<версия>+<хэш>` включает хэш. */
	end: number;
	/** Версия без кавычек в YAML: число, которое парсер мог бы прочитать иначе. */
	plain: boolean;
}

export interface PinChange {
	tool: PinnedTool;
	line: number;
	from: string;
	to: string;
}

const VERSION = /^\d+(?:\.\d+){0,2}$/;
const DOCKER_IMAGE = /^(node|oven\/bun):(\d+(?:\.\d+){0,2})(?:-[A-Za-z0-9._-]+)?$/;
const DOCKER_FROM = /^\s*FROM((?:\s+--[A-Za-z][\w-]*=\S*)*)\s+(\S+)/i;
// Перед `pnpm@` нет символа имени пакета; за версией и хэшем нет продолжения имени версии.
const PNPM_LITERAL = /(?<![\w@/.-])pnpm@(\d+(?:\.\d+){0,2})(\+[^\s"']*)?(?![\w.+-])/g;
const WORKFLOW_KEYS: Readonly<Record<string, PinnedTool>> = {
	'proto-version': 'proto',
	'node-version': 'node',
	'bun-version': 'bun',
};

/** Вид файла по пути от корня репозитория; undefined — в файле копии не ищутся. */
export function pinSiteKind(path: string): PinSiteKind | undefined {
	const name = path.slice(path.lastIndexOf('/') + 1);
	if (name === 'Dockerfile') return 'dockerfile';
	if (name.startsWith('Dockerfile.') && !name.endsWith('.dockerignore')) return 'dockerfile';
	if (name.endsWith('.Dockerfile') && name.length > '.Dockerfile'.length) return 'dockerfile';
	if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)) return 'workflow';
	if (/^\.github\/actions\/(?:.+\/)?action\.ya?ml$/.test(path)) return 'workflow';
	return undefined;
}

function dockerfileCopies(text: string): PinCopy[] {
	const copies: PinCopy[] = [];
	let offset = 0;
	let line = 0;
	for (const raw of text.split('\n')) {
		line += 1;
		const lineStart = offset;
		offset += raw.length + 1;
		if (raw.trimStart().startsWith('#')) continue;
		const from = DOCKER_FROM.exec(raw);
		const token = from?.[2];
		const image = token === undefined ? undefined : DOCKER_IMAGE.exec(token);
		if (
			from !== null &&
			token !== undefined &&
			image?.[1] !== undefined &&
			image[2] !== undefined
		) {
			const tokenStart = from[0].length - token.length;
			const start = lineStart + tokenStart + image[1].length + 1;
			copies.push({
				tool: image[1] === 'node' ? 'node' : 'bun',
				version: image[2],
				line,
				start,
				end: start + image[2].length,
				plain: false,
			});
		}
		for (const m of raw.matchAll(PNPM_LITERAL)) {
			const version = m[1];
			if (version === undefined) continue;
			const start = lineStart + m.index + 'pnpm@'.length;
			copies.push({
				tool: 'pnpm',
				version,
				line,
				start,
				end: start + version.length + (m[2]?.length ?? 0),
				plain: false,
			});
		}
	}
	return copies.toSorted((a, b) => a.start - b.start);
}

function workflowCopies(text: string): PinCopy[] {
	const doc = parseDocument(text);
	if (doc.errors.length > 0) return [];
	const copies: PinCopy[] = [];
	visit(doc, {
		Pair: (_key, pair, path) => {
			if (!isScalar(pair.key) || typeof pair.key.value !== 'string') return;
			if (!Object.hasOwn(WORKFLOW_KEYS, pair.key.value)) return;
			const tool = WORKFLOW_KEYS[pair.key.value] as PinnedTool;
			// Ключ лежит прямо в карте под ключом `with`: шаг, composite action или вызов reusable workflow.
			const owner = path.at(-2);
			if (!isMap(path.at(-1)) || !isPair(owner)) return;
			if (!isScalar(owner.key) || owner.key.value !== 'with') return;
			const value = pair.value;
			if (!isScalar(value) || value.range === null || value.range === undefined) return;
			if (value.type !== 'PLAIN' && value.type !== 'QUOTE_SINGLE' && value.type !== 'QUOTE_DOUBLE')
				return;
			const source: unknown = value.source;
			if (typeof source !== 'string' || !VERSION.test(source)) return;
			const plain = value.type === 'PLAIN';
			const start = value.range[0] + (plain ? 0 : 1);
			// YAML-escape в двойных кавычках: `source` короче сырого текста, замена по смещениям испортила бы строку.
			if (text.slice(start, start + source.length) !== source) return;
			copies.push({
				tool,
				version: source,
				line: text.slice(0, start).split('\n').length,
				start,
				end: start + source.length,
				plain,
			});
		},
	});
	return copies.toSorted((a, b) => a.start - b.start);
}

/** Все копии в тексте, в порядке строк. */
export function pinCopies(kind: PinSiteKind, text: string): PinCopy[] {
	return kind === 'dockerfile' ? dockerfileCopies(text) : workflowCopies(text);
}

/** Пин, обрезанный до числа компонентов found; undefined — пин не вида N.N.N. */
export function alignToPin(found: string, pin: string): string | undefined {
	if (!/^\d+\.\d+\.\d+$/.test(pin)) return undefined;
	return pin.split('.').slice(0, found.split('.').length).join('.');
}

// Два числа без кавычек YAML читает числом: `26.10` стало бы `26.1`.
function needsQuotes(version: string): boolean {
	return version.split('.').length === 2 && String(Number(version)) !== version;
}

/** Текст с копиями, приведёнными к пинам. Ничего не разошлось — тот же text и пустой changes. */
export function rewritePinCopies(
	kind: PinSiteKind,
	text: string,
	pins: Readonly<Record<string, string | undefined>>,
): { text: string; changes: PinChange[] } {
	const changes: PinChange[] = [];
	const edits: { start: number; end: number; with: string }[] = [];
	for (const copy of pinCopies(kind, text)) {
		const pin = pins[copy.tool];
		const to = pin === undefined ? undefined : alignToPin(copy.version, pin);
		if (to === undefined || to === copy.version) continue;
		changes.push({ tool: copy.tool, line: copy.line, from: copy.version, to });
		edits.push({
			start: copy.start,
			end: copy.end,
			with: copy.plain && needsQuotes(to) ? `'${to}'` : to,
		});
	}
	// С конца текста: смещения предыдущих копий не сдвигаются.
	let result = text;
	for (const edit of edits.toReversed()) {
		result = result.slice(0, edit.start) + edit.with + result.slice(edit.end);
	}
	return { text: result, changes };
}
