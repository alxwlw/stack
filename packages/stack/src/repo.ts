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
	/** Ровно одна находка unreadable-file на каждый неразобранный package.json, pnpm-workspace.yaml и первый конфиг Renovate. */
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

// Чистая часть: разбирает package.json (по basename; вложенные — только при pnpm-workspace.yaml среди
// путей), pnpm-workspace.yaml и первый из RENOVATE_CONFIGS. Пути — ключи files и extra (существующие
// пути, которые не разбираются: не прочитанные или удержанные от разбора). Порядок unreadable: корневой package.json, pnpm-workspace.yaml, вложенные
// package.json в порядке files, конфиг Renovate.
export function repoFromFiles(
	files: ReadonlyMap<string, string>,
	extra: Iterable<string> = [],
): Repo {
	const paths = new Set([...files.keys(), ...extra]);
	const packages = new Map<string, Record<string, unknown>>();
	const unreadable: Finding[] = [];
	const manifests = [...files.keys()].filter(
		(p) => basename(p) === 'package.json' && (p === 'package.json' || paths.has(WORKSPACE_FILE)),
	);
	manifests.sort((a, b) => Number(b === 'package.json') - Number(a === 'package.json'));
	let workspace: Document | undefined;
	const workspaceText = files.get(WORKSPACE_FILE);
	if (workspaceText !== undefined) {
		const doc = parseDocument(workspaceText);
		if (doc.errors.length === 0) workspace = doc;
		else {
			unreadable.push({
				code: 'unreadable-file',
				target: WORKSPACE_FILE,
				message: `${WORKSPACE_FILE} does not parse: ${(doc.errors[0] as Error).message.split('\n')[0]}`,
			});
		}
	}
	for (const file of manifests) {
		try {
			const doc: unknown = JSON.parse(files.get(file) as string);
			packages.set(
				file,
				doc !== null && typeof doc === 'object' && !Array.isArray(doc)
					? (doc as Record<string, unknown>)
					: {},
			);
		} catch (err) {
			unreadable.push({
				code: 'unreadable-file',
				target: file,
				message: `${file} does not parse: ${err instanceof Error ? err.message : String(err)}`,
			});
		}
	}
	const path = RENOVATE_CONFIGS.find((p) => files.has(p));
	let renovate: Repo['renovate'];
	if (path !== undefined) {
		try {
			renovate = { path, config: JSON5.parse(files.get(path) as string) };
		} catch {
			renovate = { path };
			unreadable.push({
				code: 'unreadable-file',
				target: path,
				message: `${path} does not parse as JSON5`,
			});
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
	};
}

type Read = { text: string } | { missing: true } | { failed: Error };

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

// Диск: dest и satisfiedBy канон-файлов, конфиги Renovate и dependabot, pnpm-workspace.yaml,
// корневой package.json; при pnpm-workspace.yaml — ещё вложенные package.json без SKIP.
// Ровно одна unreadable-file приходится на package.json (корневой и вложенные), pnpm-workspace.yaml и
// конфиг Renovate. Verbatim канон-файл сравнивается по содержимому, поэтому нечитаемый (например,
// каталог) для правила отсутствует: file-missing, затем sync падает с EISDIR — громко, намеренно.
// Create-if-absent dest/satisfiedBy и конфиги dependabot нужны правилам только как существующие пути.
export function loadRepo(root: string, canon: Canon): Repo {
	const candidates = new Set<string>(['package.json', WORKSPACE_FILE]);
	for (const f of canon.files) {
		candidates.add(f.dest);
		for (const p of f.satisfiedBy ?? []) candidates.add(p);
	}
	for (const p of [...RENOVATE_CONFIGS, ...DEPENDABOT_CONFIGS]) candidates.add(p);
	const files = new Map<string, string>();
	const unreadableExisting = new Set<string>();
	const failedManifests: Finding[] = [];
	const failedRenovate = new Set<string>();
	const add = (path: string) => {
		const r = readFile(root, path);
		if ('text' in r) files.set(path, r.text);
		else if ('failed' in r) {
			unreadableExisting.add(path);
			if (basename(path) === 'package.json' || path === WORKSPACE_FILE) {
				failedManifests.push({
					code: 'unreadable-file',
					target: path,
					message: `${path} does not parse: ${r.failed.message}`,
				});
			} else if (RENOVATE_CONFIGS.includes(path)) failedRenovate.add(path);
		}
	};
	for (const p of candidates) add(p);
	if (files.has(WORKSPACE_FILE) || unreadableExisting.has(WORKSPACE_FILE)) {
		for (const file of new Glob('**/package.json').scanSync({ cwd: root })) {
			if (!SKIP.test(file) && !candidates.has(file)) add(file);
		}
	}
	// Первый найденный конфиг Renovate, в том числе нечитаемый, заслоняет остальные.
	const first = RENOVATE_CONFIGS.find((p) => files.has(p) || failedRenovate.has(p));
	const failedFirst = first !== undefined && failedRenovate.has(first) ? first : undefined;
	const forParse = new Map(files);
	if (failedFirst !== undefined) for (const p of RENOVATE_CONFIGS) forParse.delete(p);
	const repo = { ...repoFromFiles(forParse, [...files.keys(), ...unreadableExisting]), files };
	if (failedManifests.length === 0 && failedFirst === undefined) return repo;
	const unreadable = [...repo.unreadable, ...failedManifests];
	if (failedFirst !== undefined) {
		unreadable.push({
			code: 'unreadable-file',
			target: failedFirst,
			message: `${failedFirst} does not parse as JSON5`,
		});
	}
	unreadable.sort((a, b) => rank(a) - rank(b));
	return failedFirst === undefined
		? { ...repo, unreadable }
		: { ...repo, renovate: { path: failedFirst }, unreadable };
}
