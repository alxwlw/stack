import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Glob } from 'bun';
import JSON5 from 'json5';
import { type Document, parseDocument } from 'yaml';

import type { Canon } from './canon.ts';
import type { Finding } from './findings.ts';

// package.json в этих каталогах не читаются: чужой или собранный файл — не предмет проверки.
export const SKIP = /node_modules|\.worktrees|\.moon\/cache|(^|\/)(dist|build)\//;

// Имена и порядок поиска — как у самого Renovate (расширения json, jsonc, json5 для каждого места; первый
// найденный файл и есть конфиг), без устаревшего package.json#renovate. JSON5.parse читает и JSONC.
export const RENOVATE_CONFIGS = [
	'renovate.json',
	'renovate.jsonc',
	'renovate.json5',
	'.github/renovate.json',
	'.github/renovate.jsonc',
	'.github/renovate.json5',
	'.gitlab/renovate.json',
	'.gitlab/renovate.jsonc',
	'.gitlab/renovate.json5',
	'.renovaterc',
	'.renovaterc.json',
	'.renovaterc.jsonc',
	'.renovaterc.json5',
];

export const WORKSPACE_FILE = 'pnpm-workspace.yaml';

export const MOON_TOOLCHAINS = '.moon/toolchains.yml';

export const DEPENDABOT_CONFIGS = ['.github/dependabot.yml', '.github/dependabot.yaml'];

// Репозиторий потребителя как значение: правила получают его и не читают диск сами.
export interface Repo {
	/** Содержимое прочитанных файлов; нечитаемый (каталог, нет прав) в files не попадает — его существование в paths. */
	files: ReadonlyMap<string, string>;
	/** Какие из прочитанных загрузчиком путей существуют — как у existsSync: каталог и нечитаемый файл тоже есть. */
	paths: ReadonlySet<string>;
	/** Разобранный pnpm-workspace.yaml; нет документа — файла нет или он не разобрался. */
	workspace?: Document;
	/** Разобранные package.json по пути от корня: корень — всегда, вложенные — только при pnpm-workspace.yaml. */
	packages: ReadonlyMap<string, Record<string, unknown>>;
	/** Первый конфиг Renovate в порядке поиска самого Renovate; config нет — файл не разобрался. */
	renovate?: { path: string; config?: unknown };
	/** Разобранный .moon/toolchains.yml (верхний уровень); нет поля — файла нет или он не разобрался. */
	moonToolchains?: Record<string, unknown>;
	/** Ровно одна находка unreadable-file на каждый неразобранный package.json, pnpm-workspace.yaml, первый конфиг Renovate и .moon/toolchains.yml. */
	unreadable: Finding[];
}

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

// Порядок находок: корневой package.json, pnpm-workspace.yaml, вложенные package.json, остальное (Renovate).
const rank = (f: Finding): number =>
	f.target === 'package.json'
		? 0
		: f.target === WORKSPACE_FILE
			? 1
			: basename(f.target) === 'package.json'
				? 2
				: 3;

// Прочитанное с диска по одному пути: текст, «файла нет» или ошибка чтения (файл есть, но не читается).
export type Read = { text: string } | { missing: true } | { failed: Error };

// Снимок диска: путь от корня → результат чтения. Порядок ключей — порядок чтения адаптера.
export type Snapshot = ReadonlyMap<string, Read>;

// Чистая часть: из снимка строит Repo. Здесь единственная классификация unreadable-file: сбой чтения и
// сбой разбора одной роли — одна находка. Разбираемые роли: package.json (корневой всегда; вложенные —
// только при pnpm-workspace.yaml среди путей), pnpm-workspace.yaml и первый из RENOVATE_CONFIGS среди
// путей (нечитаемый заслоняет остальные) и .moon/toolchains.yml. Остальные пути — только в paths, находки не дают.
// Порядок unreadable: по rank, равные — в порядке снимка.
export function repoFromSnapshot(snapshot: Snapshot): Repo {
	const files = new Map<string, string>();
	const paths = new Set<string>();
	for (const [path, read] of snapshot) {
		if ('missing' in read) continue;
		paths.add(path);
		if ('text' in read) files.set(path, read.text);
	}
	const packages = new Map<string, Record<string, unknown>>();
	const unreadable: Finding[] = [];
	const bad = (target: string, message: string) =>
		unreadable.push({ code: 'unreadable-file', target, message });

	const manifests = [...paths].filter(
		(p) => basename(p) === 'package.json' && (p === 'package.json' || paths.has(WORKSPACE_FILE)),
	);
	manifests.sort((a, b) => Number(b === 'package.json') - Number(a === 'package.json'));
	for (const file of manifests) {
		const read = snapshot.get(file) as Read;
		if ('failed' in read) {
			bad(file, `${file} does not parse: ${read.failed.message}`);
			continue;
		}
		try {
			const doc: unknown = JSON.parse((read as { text: string }).text);
			packages.set(
				file,
				doc !== null && typeof doc === 'object' && !Array.isArray(doc)
					? (doc as Record<string, unknown>)
					: {},
			);
		} catch (err) {
			bad(file, `${file} does not parse: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	let workspace: Document | undefined;
	const workspaceRead = snapshot.get(WORKSPACE_FILE);
	if (workspaceRead !== undefined && 'failed' in workspaceRead) {
		bad(WORKSPACE_FILE, `${WORKSPACE_FILE} does not parse: ${workspaceRead.failed.message}`);
	} else if (workspaceRead !== undefined && 'text' in workspaceRead) {
		const doc = parseDocument(workspaceRead.text);
		if (doc.errors.length === 0) workspace = doc;
		else {
			bad(
				WORKSPACE_FILE,
				`${WORKSPACE_FILE} does not parse: ${(doc.errors[0] as Error).message.split('\n')[0]}`,
			);
		}
	}

	const renovatePath = RENOVATE_CONFIGS.find((p) => paths.has(p));
	let renovate: Repo['renovate'];
	if (renovatePath !== undefined) {
		const read = snapshot.get(renovatePath) as Read;
		try {
			if ('failed' in read) throw read.failed;
			renovate = { path: renovatePath, config: JSON5.parse((read as { text: string }).text) };
		} catch {
			renovate = { path: renovatePath };
			bad(renovatePath, `${renovatePath} does not parse as JSON5`);
		}
	}
	let moonToolchains: Record<string, unknown> | undefined;
	const moonRead = snapshot.get(MOON_TOOLCHAINS);
	if (moonRead !== undefined && 'failed' in moonRead) {
		bad(MOON_TOOLCHAINS, `${MOON_TOOLCHAINS} does not parse: ${moonRead.failed.message}`);
	} else if (moonRead !== undefined && 'text' in moonRead) {
		const doc = parseDocument(moonRead.text);
		if (doc.errors.length > 0) {
			bad(
				MOON_TOOLCHAINS,
				`${MOON_TOOLCHAINS} does not parse: ${(doc.errors[0] as Error).message.split('\n')[0]}`,
			);
		} else {
			const top: unknown = doc.toJS();
			moonToolchains =
				top !== null && typeof top === 'object' && !Array.isArray(top)
					? (top as Record<string, unknown>)
					: {};
		}
	}
	unreadable.sort((a, b) => rank(a) - rank(b));
	return {
		files,
		paths,
		packages,
		unreadable,
		...(workspace && { workspace }),
		...(renovate && { renovate }),
		...(moonToolchains && { moonToolchains }),
	};
}

// Нет файла — так же, как его видит existsSync: ENOENT, ENOTDIR (путь под обычным файлом, например
// `.github` — файл) и ELOOP. Любая другая ошибка (EACCES, EISDIR) — файл есть, но не читается.
const MISSING = new Set(['ENOENT', 'ENOTDIR', 'ELOOP']);

function readFile(root: string, path: string): Read {
	try {
		return { text: readFileSync(join(root, path), 'utf8') };
	} catch (err) {
		const e = err instanceof Error ? err : new Error(String(err));
		const code = (e as { code?: string }).code;
		return code !== undefined && MISSING.has(code) ? { missing: true } : { failed: e };
	}
}

// Адаптер диска, без классификации: dest и satisfiedBy канон-файлов, конфиги Renovate и dependabot,
// .moon/toolchains.yml, pnpm-workspace.yaml, корневой package.json; если pnpm-workspace.yaml есть (текст или сбой чтения) —
// ещё вложенные package.json без SKIP.
export function readSnapshot(root: string, canon: Canon): Snapshot {
	const candidates = new Set<string>(['package.json', WORKSPACE_FILE]);
	for (const f of canon.files) {
		candidates.add(f.dest);
		for (const p of f.satisfiedBy ?? []) candidates.add(p);
	}
	for (const p of [...RENOVATE_CONFIGS, ...DEPENDABOT_CONFIGS, MOON_TOOLCHAINS]) candidates.add(p);
	const snapshot = new Map<string, Read>();
	for (const p of candidates) snapshot.set(p, readFile(root, p));
	const workspace = snapshot.get(WORKSPACE_FILE) as Read;
	if (!('missing' in workspace)) {
		for (const file of new Glob('**/package.json').scanSync({ cwd: root })) {
			if (!SKIP.test(file) && !candidates.has(file)) snapshot.set(file, readFile(root, file));
		}
	}
	return snapshot;
}

// Verbatim канон-файл сравнивается по содержимому, поэтому нечитаемый (например, каталог) для правила
// отсутствует: file-missing, затем sync падает с EISDIR — громко, намеренно. Create-if-absent
// dest/satisfiedBy и конфиги dependabot нужны правилам только как существующие пути.
export function loadRepo(root: string, canon: Canon): Repo {
	return repoFromSnapshot(readSnapshot(root, canon));
}
