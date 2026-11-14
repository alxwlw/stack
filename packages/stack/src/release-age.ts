import { isScalar, isSeq } from 'yaml';

import type { Canon } from './canon.ts';
import type { Drift } from './findings.ts';
import { type Repo, WORKSPACE_FILE } from './repo.ts';

const KEY = 'minimumReleaseAgeExclude';
const SCOPE = '@alxwlw/';

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

// Пока в pnpm-workspace.yaml включён minimumReleaseAge, свежий @alxwlw/* из канона pnpm install
// отвергает в день публикации: sync держит версии канона в minimumReleaseAgeExclude. Чужие записи
// и их порядок не трогаются, правка — только добавление версии к своей записи или новая запись.
export function planReleaseAgeExcludes(repo: Repo, canon: Canon): Drift[] {
	const doc = repo.workspace;
	if (doc === undefined) return [];
	const age = Number(doc.get('minimumReleaseAge'));
	if (!(age > 0)) return [];
	const existing = doc.get(KEY);
	// Ключ есть, а значения нет (`minimumReleaseAgeExclude:`): setIn по индексу в null бросает,
	// поэтому первая запись создаёт последовательность целиком.
	const empty = doc.has(KEY) && existing == null;
	// Не последовательность (скаляр, map): структуру руками не ломаем.
	if (existing != null && !isSeq(existing)) return [];
	const items: (string | undefined)[] = (existing?.items ?? []).map((n) =>
		isScalar(n) && typeof n.value === 'string' ? n.value : undefined,
	);
	let length = items.length;
	const plan: Drift[] = [];
	for (const [name, version] of Object.entries(canon.catalogs.dev ?? {})) {
		if (!name.startsWith(SCOPE)) continue;
		if (items.some((s) => s !== undefined && covers(s, name, version))) continue;
		const own = items.findIndex((s) => s !== undefined && s.trim().startsWith(`${name}@`));
		const extend = own >= 0;
		const seed = empty && !extend && length === 0;
		const path = seed ? [KEY] : [KEY, extend ? own : length];
		if (!extend) length++;
		const entry = extend ? `${items[own]} || ${version}` : `${name}@${version}`;
		plan.push({
			code: 'release-age-exclude',
			target: `${KEY}.${name}`,
			message: `${KEY} does not cover ${name}@${version}`,
			name,
			fix: `${KEY}: ${name}@${version}`,
			change: {
				kind: 'yaml-set',
				file: WORKSPACE_FILE,
				path,
				value: seed ? [entry] : entry,
			},
		});
	}
	return plan;
}
