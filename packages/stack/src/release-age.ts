import { isScalar, isSeq } from 'yaml';

import type { Canon } from './canon.ts';
import type { Drift } from './findings.ts';
import { SCOPE } from './own-packages.ts';
import { type Repo, WORKSPACE_FILE } from './repo.ts';

const KEY = 'minimumReleaseAgeExclude';

// Покрывает ли строка исключения версию пакета: голое имя, `@alxwlw/*` или `<имя>@<список через ||>`.
function covers(entry: string, name: string, version: string): boolean {
	const e = entry.trim();
	if (e === name || e === `${SCOPE}*`) return true;
	if (!e.startsWith(`${name}@`)) return false;
	return e
		.slice(name.length + 1)
		.split('||')
		.some((v) => v.trim() === version);
}

// Пока в pnpm-workspace.yaml включён minimumReleaseAge, свежий свой пакет канона (каталог dev и
// зависимости stack) pnpm install отвергает в день публикации: sync держит версии канона в minimumReleaseAgeExclude. Чужие записи
// и их порядок не трогаются, правка — только добавление версии к своей записи или новая запись.
// Правило называет намерение: позицию новой записи и создание списка (ключа нет, ключ без значения)
// решает применитель, поэтому находки не зависят друг от друга и любую из них можно удержать.
export function planReleaseAgeExcludes(repo: Repo, canon: Canon): Drift[] {
	const doc = repo.workspace;
	if (doc === undefined) return [];
	const age = Number(doc.get('minimumReleaseAge'));
	if (!(age > 0)) return [];
	const existing = doc.get(KEY);
	// Не последовательность (скаляр, map): структуру руками не ломаем.
	if (existing != null && !isSeq(existing)) return [];
	const items: (string | undefined)[] = (existing?.items ?? []).map((n) =>
		isScalar(n) && typeof n.value === 'string' ? n.value : undefined,
	);
	const plan: Drift[] = [];
	for (const { name, version } of canon.ownPackages) {
		if (items.some((s) => s !== undefined && covers(s, name, version))) continue;
		// Существующие элементы не сдвигаются, новые идут в конец: индекс своей записи верен при любом
		// подмножестве применённых правок.
		const own = items.findIndex((s) => s !== undefined && s.trim().startsWith(`${name}@`));
		plan.push({
			code: 'release-age-exclude',
			target: `${KEY}.${name}`,
			message: `${KEY} does not cover ${name}@${version}`,
			name,
			fix: `${KEY}: ${name}@${version}`,
			change:
				own >= 0
					? {
							kind: 'yaml-set',
							file: WORKSPACE_FILE,
							path: [KEY, own],
							value: `${items[own]} || ${version}`,
						}
					: { kind: 'yaml-append', file: WORKSPACE_FILE, path: [KEY], value: `${name}@${version}` },
		});
	}
	return plan;
}
