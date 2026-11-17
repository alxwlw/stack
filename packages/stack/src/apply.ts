import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { applyEdits, modify } from 'jsonc-parser';
import { isScalar, isSeq, parseDocument } from 'yaml';

import type { Change } from './findings.ts';

function renderFile(file: string, current: string | undefined, changes: Change[]): string {
	// Список по файлу не бывает пустым: правки группирует renderChanges.
	const first = changes[0] as Change;
	// Совместимость по формату файла: yaml-set и yaml-append — один формат.
	const format = (c: Change) => (c.kind === 'yaml-append' ? 'yaml-set' : c.kind);
	if (changes.some((c) => format(c) !== format(first))) {
		throw new Error(`conflicting changes for ${file}`);
	}
	if (first.kind === 'write') {
		// Несколько write в один файл: побеждает последний (дубликат dest ловит canon.test.ts).
		let content = '';
		for (const c of changes) if (c.kind === 'write') content = c.content;
		return content;
	}
	if (format(first) === 'yaml-set') {
		const doc = parseDocument(current ?? '');
		for (const c of changes) {
			// setIn создаёт недостающие узлы и не трогает соседей и их комментарии.
			if (c.kind === 'yaml-set') doc.setIn(c.path, c.value);
			else if (c.kind === 'yaml-append') {
				const node = doc.getIn(c.path, true);
				if (isSeq(node)) node.add(doc.createNode(c.value));
				else if (node === undefined || (isScalar(node) && node.value === null)) {
					// yaml держит комментарии пустого ключа на null-скаляре: переносим на новую последовательность.
					const seq = doc.createNode([c.value]);
					if (node?.comment) seq.comment = node.comment;
					if (node?.commentBefore) seq.commentBefore = node.commentBefore;
					doc.setIn(c.path, seq);
				} else throw new Error(`${file}: ${c.path.join('.')} is not a sequence`);
			}
		}
		// singleQuote: oxfmt (canon .oxfmtrc.jsonc) formats YAML with singleQuote:true, and
		// pnpm-workspace.yaml's own pre-existing catalogs already use single quotes for scoped names.
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

// Текущее содержимое берётся из снимка репозитория (нет ключа — нет файла), диск не читается;
// не больше одной записи на файл.
export function applyChanges(
	root: string,
	changes: readonly Change[],
	current: ReadonlyMap<string, string>,
): void {
	for (const [file, content] of renderChanges(current, changes)) {
		const target = join(root, file);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, content);
	}
}
