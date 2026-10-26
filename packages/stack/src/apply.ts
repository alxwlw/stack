import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { applyEdits, modify } from 'jsonc-parser';
import { parseDocument } from 'yaml';

import type { Change } from './findings.ts';

function renderFile(file: string, current: string | undefined, changes: Change[]): string {
	// Список по файлу не бывает пустым: правки группирует renderChanges.
	const first = changes[0] as Change;
	if (changes.some((c) => c.kind !== first.kind)) {
		throw new Error(`conflicting changes for ${file}`);
	}
	if (first.kind === 'write') {
		// Несколько write в один файл: побеждает последний (дубликат dest ловит canon.test.ts).
		let content = '';
		for (const c of changes) if (c.kind === 'write') content = c.content;
		return content;
	}
	if (first.kind === 'yaml-set') {
		const doc = parseDocument(current ?? '');
		for (const c of changes) {
			// setIn создаёт недостающие узлы и не трогает соседей и их комментарии.
			if (c.kind === 'yaml-set') doc.setIn(c.path, c.value);
		}
		// singleQuote: oxfmt (canon .oxfmtrc.jsonc) formats YAML with singleQuote:true, and
		// this file's own pre-existing catalogs already use single quotes for scoped names.
		// New scoped-package keys (@foo/bar isn't a plain-scalar-safe start char) default to
		// double quotes otherwise, so a freshly-synced workspace fails `oxfmt --check`.
		// lineWidth: 0 — без переноса: по умолчанию yaml режет скаляры длиннее 80 колонок во
		// всём документе, и sync переписал бы строки, к каталогам не относящиеся.
		return doc.toString({ singleQuote: true, lineWidth: 0 });
	}
	let text = current ?? '';
	for (const c of changes) {
		// modify+applyEdits меняет только значение поля: отступы и порядок ключей остаются.
		if (c.kind === 'json-set') text = applyEdits(text, modify(text, c.path, c.value, {}));
	}
	return text;
}

// Чистая часть: текущее содержимое (undefined — файла нет) + правки → итог по одному на файл.
export function renderChanges(
	current: ReadonlyMap<string, string | undefined>,
	changes: readonly Change[],
): Map<string, string> {
	const byFile = new Map<string, Change[]>();
	for (const c of changes) byFile.set(c.file, [...(byFile.get(c.file) ?? []), c]);
	const out = new Map<string, string>();
	for (const [file, list] of byFile) out.set(file, renderFile(file, current.get(file), list));
	return out;
}

// Читает каждый затронутый файл один раз, рендерит, пишет каждый файл один раз.
export function applyChanges(root: string, changes: readonly Change[]): void {
	const current = new Map<string, string | undefined>();
	for (const c of changes) {
		if (current.has(c.file) || c.kind === 'write') continue;
		current.set(c.file, readFileSync(join(root, c.file), 'utf8'));
	}
	for (const [file, content] of renderChanges(current, changes)) {
		const target = join(root, file);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, content);
	}
}
