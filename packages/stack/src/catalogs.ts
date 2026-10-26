import type { Canon } from './canon.ts';
import type { Drift } from './findings.ts';
import { type Repo, WORKSPACE_FILE } from './repo.ts';

// doc.getIn() возвращает unknown: скаляр (обычный случай) или узел yaml-коллекции,
// если запись каталога сломана (не скаляр). String() на объекте даёт "[object Object]" —
// JSON.stringify честно показывает, что там на самом деле.
function displayValue(v: unknown): string {
	if (v == null) return String(v);
	if (typeof v === 'string') return v;
	if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return v.toString();
	return JSON.stringify(v);
}

// Один проход и один предикат для check и sync — см. planFiles.
export function planCatalogs(repo: Repo, canon: Canon): Drift[] {
	// Документа нет: файла нет или он не разобрался (находка — в repo.unreadable).
	const doc = repo.workspace;
	if (doc === undefined) return [];
	const plan: Drift[] = [];
	for (const [group, entries] of Object.entries(canon.catalogs)) {
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
				catalog: group,
				name,
				fix: `catalog ${group}.${name}: ${from ?? '—'} → ${version}`,
				change: {
					kind: 'yaml-set',
					file: WORKSPACE_FILE,
					path: ['catalogs', group, name],
					value: version,
				},
			});
		}
	}
	return plan;
}
