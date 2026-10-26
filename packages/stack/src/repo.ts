import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Glob } from 'bun';
import JSON5 from 'json5';

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

export const DEPENDABOT_CONFIGS = ['.github/dependabot.yml', '.github/dependabot.yaml'];

// Репозиторий потребителя как значение: правила получают его и не читают диск сами.
export interface Repo {
	/** Прочитанные файлы как текст; нет ключа — нет файла. */
	files: ReadonlyMap<string, string>;
	/** Разобранные package.json по пути от корня: корень — всегда, вложенные — только при pnpm-workspace.yaml. */
	packages: ReadonlyMap<string, Record<string, unknown>>;
	/** Первый конфиг Renovate в порядке поиска самого Renovate; config нет — файл не разобрался. */
	renovate?: { path: string; config?: unknown };
	/** Ровно одна находка unreadable-file на каждый неразобранный файл. */
	unreadable: Finding[];
}

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

// Чистая часть: разбирает package.json (по basename) и первый из RENOVATE_CONFIGS.
// Порядок unreadable: корневой package.json, вложенные в порядке files, конфиг Renovate.
export function repoFromFiles(files: ReadonlyMap<string, string>): Repo {
	const packages = new Map<string, Record<string, unknown>>();
	const unreadable: Finding[] = [];
	const manifests = [...files.keys()].filter((p) => basename(p) === 'package.json');
	manifests.sort((a, b) => Number(b === 'package.json') - Number(a === 'package.json'));
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
	return renovate ? { files, packages, renovate, unreadable } : { files, packages, unreadable };
}

type Read = { text: string } | { missing: true } | { failed: Error };

// ENOENT — нет файла. Любая другая ошибка (EACCES, EISDIR) — файл есть, но не читается.
function readFile(root: string, path: string): Read {
	try {
		return { text: readFileSync(join(root, path), 'utf8') };
	} catch (err) {
		const e = err instanceof Error ? err : new Error(String(err));
		return (e as { code?: string }).code === 'ENOENT' ? { missing: true } : { failed: e };
	}
}

// Диск: dest и satisfiedBy канон-файлов, конфиги Renovate и dependabot, pnpm-workspace.yaml,
// корневой package.json; при pnpm-workspace.yaml — ещё вложенные package.json без SKIP.
// Нечитаемый package.json и нечитаемый конфиг Renovate дают ту же unreadable-file, что нечитаемый
// разбор; у канон-файлов и dependabot нечитаемый путь — просто нет файла.
export function loadRepo(root: string, canon: Canon): Repo {
	const paths = new Set<string>(['package.json', 'pnpm-workspace.yaml']);
	for (const f of canon.files) {
		paths.add(f.dest);
		for (const p of f.satisfiedBy ?? []) paths.add(p);
	}
	for (const p of [...RENOVATE_CONFIGS, ...DEPENDABOT_CONFIGS]) paths.add(p);
	const files = new Map<string, string>();
	const failedManifests: Finding[] = [];
	const failedRenovate = new Set<string>();
	const add = (path: string) => {
		const r = readFile(root, path);
		if ('text' in r) files.set(path, r.text);
		else if ('failed' in r && basename(path) === 'package.json') {
			failedManifests.push({
				code: 'unreadable-file',
				target: path,
				message: `${path} does not parse: ${r.failed.message}`,
			});
		} else if ('failed' in r && RENOVATE_CONFIGS.includes(path)) failedRenovate.add(path);
	};
	for (const p of paths) add(p);
	if (files.has('pnpm-workspace.yaml')) {
		for (const file of new Glob('**/package.json').scanSync({ cwd: root })) {
			if (!SKIP.test(file) && !paths.has(file)) add(file);
		}
	}
	// Первый найденный конфиг Renovate, в том числе нечитаемый, заслоняет остальные.
	const first = RENOVATE_CONFIGS.find((p) => files.has(p) || failedRenovate.has(p));
	const failedFirst = first !== undefined && failedRenovate.has(first) ? first : undefined;
	const forParse = new Map(files);
	if (failedFirst !== undefined) for (const p of RENOVATE_CONFIGS) forParse.delete(p);
	const repo = { ...repoFromFiles(forParse), files };
	if (failedManifests.length === 0 && failedFirst === undefined) return repo;
	const rank = (f: Finding) =>
		f.target === 'package.json' ? 0 : basename(f.target) === 'package.json' ? 1 : 2;
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
