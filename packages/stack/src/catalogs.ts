import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseDocument } from 'yaml';

import type { StackConfig } from './config.ts';
import type { Drift } from './findings.ts';
import { canonDir } from './manifest.ts';

export type CanonCatalogs = Record<string, Record<string, string>>;

const WORKSPACE_FILE = 'pnpm-workspace.yaml';

// doc.getIn() возвращает unknown: скаляр (обычный случай) или узел yaml-коллекции,
// если запись каталога сломана (не скаляр). String() на объекте даёт "[object Object]" —
// JSON.stringify честно показывает, что там на самом деле.
function displayValue(v: unknown): string {
	if (v == null) return String(v);
	if (typeof v === 'string') return v;
	if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return v.toString();
	return JSON.stringify(v);
}

export function loadCatalogs(dir: string = canonDir()): CanonCatalogs {
	return JSON.parse(readFileSync(join(dir, 'catalogs.json'), 'utf8')) as CanonCatalogs;
}

export function catalogsFor(cfg: StackConfig, dir: string = canonDir()): CanonCatalogs {
	const all = loadCatalogs(dir);
	const groups = ['dev', ...cfg.with.filter((g) => g in all && g !== 'dev')];
	return Object.fromEntries(
		groups.filter((g) => all[g]).map((g) => [g, all[g] as Record<string, string>]),
	);
}

// Один проход и один предикат для check и sync — см. planFiles.
export function planCatalogs(
	repoRoot: string,
	cfg: StackConfig,
	dir: string = canonDir(),
): Drift[] {
	const path = join(repoRoot, WORKSPACE_FILE);
	if (!existsSync(path)) return [];
	const doc = parseDocument(readFileSync(path, 'utf8'));
	const plan: Drift[] = [];
	for (const [group, entries] of Object.entries(catalogsFor(cfg, dir))) {
		for (const [name, version] of Object.entries(entries)) {
			const current = doc.getIn(['catalogs', group, name]);
			// YAML разбирает `typescript: 7` и `26.1` как числа — сравниваем строками.
			if (current != null && displayValue(current) === version) continue;
			const from = current == null ? undefined : displayValue(current);
			plan.push({
				code: from == null ? 'catalog-missing' : 'catalog-drift',
				target: `catalogs.${group}.${name}`,
				message:
					from == null
						? `catalog entry missing: expected ${version}`
						: `${from} instead of ${version}`,
				address: { catalog: group, name },
				fix: `catalog ${group}.${name}: ${from ?? '—'} → ${version}`,
				apply() {
					// setIn создаёт недостающие узлы и не трогает соседей и их комментарии.
					doc.setIn(['catalogs', group, name], version);
					// singleQuote: oxfmt (canon .oxfmtrc.jsonc) formats YAML with singleQuote:true, and
					// this file's own pre-existing catalogs already use single quotes for scoped names.
					// New scoped-package keys (@foo/bar isn't a plain-scalar-safe start char) default to
					// double quotes otherwise, so a freshly-synced workspace fails `oxfmt --check`.
					// ponytail: doc общий на весь план, файл пишется на каждую запись; один flush в
					// конце, если ~40 записей первого sync станут заметны.
					writeFileSync(path, doc.toString({ singleQuote: true }));
				},
			});
		}
	}
	return plan;
}
