import { isScalar, isSeq } from 'yaml';

import type { Canon } from './canon.ts';
import type { Drift } from './findings.ts';
import { type Repo, WORKSPACE_FILE } from './repo.ts';

const KEY = 'minimumReleaseAgeExclude';

// Покрывает ли строка исключения версию пакета: голое имя, `<образец>*` (образец канона — префикс,
// с которого начинается имя) или `<имя>@<список через ||>`.
function covers(entry: string, name: string, version: string, patterns: readonly string[]): boolean {
	const e = entry.trim();
	if (e === name) return true;
	if (e.endsWith('*') && patterns.some((p) => p.endsWith('/') && e === `${p}*` && name.startsWith(p)))
		return true;
	if (!e.startsWith(`${name}@`)) return false;
	return e
		.slice(name.length + 1)
		.split('||')
		.some((v) => v.trim() === version);
}

// Пока в pnpm-workspace.yaml включён minimumReleaseAge, свежий свой пакет канона (каталог dev и
// зависимости stack) pnpm install отвергает в день публикации: sync держит версии канона в
// minimumReleaseAgeExclude. Чужие записи и их порядок не трогаются. Своя запись, не покрывающая
// версию, приводится к одной текущей (список не растёт от релиза к релизу); запись, которая версию
// уже покрывает, не трогается; нет записи — новая в конец.
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
		if (items.some((s) => s !== undefined && covers(s, name, version, canon.settings.ownPackages))) continue;
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
							value: `${name}@${version}`,
						}
					: { kind: 'yaml-append', file: WORKSPACE_FILE, path: [KEY], value: `${name}@${version}` },
		});
	}
	return plan;
}
