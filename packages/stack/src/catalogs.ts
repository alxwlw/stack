import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseDocument } from 'yaml';

import type { StackConfig } from './config.ts';
import type { Finding } from './findings.ts';
import { canonDir } from './manifest.ts';

export type CanonCatalogs = Record<string, Record<string, string>>;

export interface CatalogChange {
	group: string;
	name: string;
	from: string | undefined;
	to: string;
}

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

export function syncCatalogs(
	repoRoot: string,
	cfg: StackConfig,
	dir: string = canonDir(),
): CatalogChange[] {
	const path = join(repoRoot, WORKSPACE_FILE);
	if (!existsSync(path)) return [];
	const doc = parseDocument(readFileSync(path, 'utf8'));
	const changes: CatalogChange[] = [];
	for (const [group, entries] of Object.entries(catalogsFor(cfg, dir))) {
		for (const [name, version] of Object.entries(entries)) {
			const current = doc.getIn(['catalogs', group, name]);
			// YAML разбирает `typescript: 7` и `26.1` как числа — сравниваем строками.
			if (current != null && displayValue(current) === version) continue;
			// setIn создаёт недостающие узлы и не трогает соседей и их комментарии.
			doc.setIn(['catalogs', group, name], version);
			changes.push({
				group,
				name,
				from: current == null ? undefined : displayValue(current),
				to: version,
			});
		}
	}
	// singleQuote: oxfmt (canon .oxfmtrc.jsonc) formats YAML with singleQuote:true, and this
	// file's own pre-existing catalogs already use single quotes for scoped names. New
	// scoped-package keys (@foo/bar isn't a plain-scalar-safe start char) default to double
	// quotes otherwise, so a freshly-synced workspace fails `oxfmt --check` on its own output.
	if (changes.length) writeFileSync(path, doc.toString({ singleQuote: true }));
	return changes;
}

export function checkCatalogs(
	repoRoot: string,
	cfg: StackConfig,
	dir: string = canonDir(),
): Finding[] {
	const path = join(repoRoot, WORKSPACE_FILE);
	if (!existsSync(path)) return [];
	const doc = parseDocument(readFileSync(path, 'utf8'));
	const findings: Finding[] = [];
	for (const [group, entries] of Object.entries(catalogsFor(cfg, dir))) {
		for (const [name, version] of Object.entries(entries)) {
			const current = doc.getIn(['catalogs', group, name]);
			if (current != null && displayValue(current) === version) continue;
			const exception = cfg.exceptions.find((e) => e.catalog === group && e.name === name);
			findings.push({
				code: current == null ? 'catalog-missing' : 'catalog-drift',
				target: `catalogs.${group}.${name}`,
				message:
					current == null
						? `catalog entry missing: expected ${version}`
						: `${displayValue(current)} instead of ${version}`,
				...(exception ? { suppressedBy: exception } : {}),
			});
		}
	}
	return findings;
}
