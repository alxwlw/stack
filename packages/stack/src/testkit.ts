import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { stringify } from 'yaml';

import { type Canon, canonDir, canonFor, readCanonSource } from './canon.ts';
import type { Profile } from './config.ts';
import { STACK_RENOVATE_PRESET } from './deps.ts';
import { type Read, RENOVATE_CONFIGS, type Repo, repoFromSnapshot } from './repo.ts';

// Не канон-файл: схема конфигурации лежит рядом с пакетом, а не в canon/.
export const SCHEMA_PATH = join(import.meta.dir, '..', 'schema.json');

// Канон для тестов правил. Пины нарочно не равны реальным пинам канона: иначе константа,
// зашитая в правило, осталась бы незамеченной (engines-node в deps.ts, packageManager в package-manager.ts).
export function testCanon(over: Partial<Canon> = {}): Canon {
	return { files: [], catalogs: {}, pins: { node: '25.4.1', pnpm: '10.99.0' }, ...over };
}

// Содержимое канон-файла по его dest, как его видит loadCanon: все группы включены. Тесты, сверяющие
// канон с корнем репозитория или с самим собой, берут файл здесь, а не по пути в canon/files.
export function canonFile(dest: string, profile: Profile = 'node'): string {
	const source = readCanonSource();
	const g = source.groups;
	const canon = canonFor(source, { profile, with: [...g.files, ...g.catalogs], exceptions: [] });
	const file = canon.files.find((f) => f.dest === dest);
	if (!file) throw new Error(`no canon file ${dest} for profile ${profile}`);
	return file.content;
}

// Связка (Bundle в GLOSSARY): запись canon/bundles.json.
export type Bundle = { match: string[]; required: string[]; sameVersion: string[][] };

const BUNDLE_KEYS = ['match', 'required', 'sameVersion'];
const isStrings = (v: unknown): v is string[] =>
	Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string' && s !== '');

// Читатель формы bundles.json: опечатка в ключе записи иначе молча сделала бы сверку пустой.
// Шаблоны читает Bun.Glob, поэтому синтаксис Renovate, который он читает иначе, отклоняется.
export function parseBundles(text: string, file: string): Record<string, Bundle> {
	const data: unknown = JSON.parse(text);
	if (typeof data !== 'object' || data === null || Array.isArray(data)) {
		throw new Error(`${file}: верх — не объект «имя → запись»`);
	}
	const names = Object.keys(data);
	if (names.length === 0) throw new Error(`${file}: ни одной записи`);
	const out: Record<string, Bundle> = {};
	for (const name of names) {
		const at = `${file}: ${name}`;
		const entry: unknown = (data as Record<string, unknown>)[name];
		if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
			throw new Error(`${at}: запись — не объект`);
		}
		const rec = entry as Record<string, unknown>;
		for (const key of Object.keys(rec)) {
			if (!BUNDLE_KEYS.includes(key)) throw new Error(`${at}: лишний ключ ${key}`);
		}
		for (const key of BUNDLE_KEYS) {
			if (!(key in rec)) throw new Error(`${at}: нет ключа ${key}`);
		}
		if (!isStrings(rec.match)) throw new Error(`${at}: match — непустой массив непустых строк`);
		if (!isStrings(rec.required)) {
			throw new Error(`${at}: required — непустой массив непустых строк`);
		}
		const groups = rec.sameVersion;
		if (!Array.isArray(groups) || groups.length === 0 || !groups.every(isStrings)) {
			throw new Error(`${at}: sameVersion — непустой массив непустых массивов непустых строк`);
		}
		for (const p of [...rec.match, ...groups.flat()]) {
			if (p.startsWith('!') || p.startsWith('/')) {
				throw new Error(
					`${at}: шаблон ${p} — отрицание или regex Renovate, Bun.Glob читает их иначе`,
				);
			}
		}
		for (const n of rec.required) {
			if (/[*?[\]{}!]/.test(n)) throw new Error(`${at}: required ${n} — точное имя, а не шаблон`);
		}
		out[name] = { match: rec.match, required: rec.required, sameVersion: groups };
	}
	return out;
}

// Связки читают только тесты, в Canon они не попадают (решение 11 индекса).
export function canonBundles(): Record<string, Bundle> {
	return parseBundles(readFileSync(join(canonDir(), 'bundles.json'), 'utf8'), 'canon/bundles.json');
}

export function matchesAny(patterns: readonly string[], name: string): boolean {
	return patterns.some((p) => new Bun.Glob(p).match(name));
}

// Репозиторий, согласованный с каноном: файлы канона, pnpm-workspace.yaml с его каталогами,
// package.json с packageManager на пине, renovate.json5 с пресетом. Правила, которых тест не касается, молчат.
// Если канон сам кладёт конфиг Renovate (любое из имён RENOVATE_CONFIGS), своего не добавляется:
// у репозитория один конфиг, и содержимое берётся из канона.
export function canonRepoFiles(canon: Canon): Map<string, string> {
	const files = new Map<string, string>();
	for (const f of canon.files) files.set(f.dest, f.content);
	files.set(
		'pnpm-workspace.yaml',
		stringify({ packages: ['packages/*'], catalogs: canon.catalogs }),
	);
	files.set(
		'package.json',
		JSON.stringify({ name: 'repo', packageManager: `pnpm@${canon.pins.pnpm}` }),
	);
	if (!canon.files.some((f) => RENOVATE_CONFIGS.includes(f.dest))) {
		files.set('renovate.json5', `{ extends: ['${STACK_RENOVATE_PRESET}'] }\n`);
	}
	return files;
}

// Ошибка чтения, как её отдаёт fs: сообщение `<код>: <текст>`, поле code.
export function ioError(code: string, message: string): Error {
	return Object.assign(new Error(`${code}: ${message}`), { code });
}

// canonRepoFiles + правки теста: строка — текст файла, Read кладётся как есть, null удаляет файл.
export function testRepo(canon: Canon, over: Record<string, string | Read | null> = {}): Repo {
	const snapshot = new Map<string, Read>();
	for (const [path, text] of canonRepoFiles(canon)) snapshot.set(path, { text });
	for (const [path, value] of Object.entries(over)) {
		if (value === null) snapshot.delete(path);
		else snapshot.set(path, typeof value === 'string' ? { text: value } : value);
	}
	return repoFromSnapshot(snapshot);
}

// Единственный сборщик каталога на диске: ключ — путь от корня, вложенные каталоги создаются.
export function repoDir(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), 'stack-repo-'));
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), content);
	}
	return dir;
}

// git без портов: тесты гоняют настоящий бинарь. stdout; ненулевой код — throw со stderr.
export function git(dir: string, ...args: string[]): string {
	const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
	if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
	return r.stdout;
}

// Конфигурация git на время файла тестов: у владельца глобально commit.gpgsign=true, в CI нет идентичности.
// Возвращает функцию, которая возвращает прежние значения.
export function isolateGitConfig(): () => void {
	const dir = mkdtempSync(join(tmpdir(), 'stack-gitconfig-'));
	const config = join(dir, 'gitconfig');
	writeFileSync(
		config,
		'[user]\n\tname = test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n',
	);
	const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
	const savedNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
	process.env.GIT_CONFIG_GLOBAL = config;
	process.env.GIT_CONFIG_NOSYSTEM = '1';
	return () => {
		if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
		else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
		if (savedNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
		else process.env.GIT_CONFIG_NOSYSTEM = savedNoSystem;
	};
}

// repoDir(files) под git: commit всех файлов на main и bare-remote origin с этим commit.
export function gitRepo(files: Record<string, string>): { dir: string; remote: string } {
	const dir = repoDir(files);
	const remote = mkdtempSync(join(tmpdir(), 'stack-remote-'));
	git(remote, 'init', '--bare');
	git(dir, 'init', '-b', 'main');
	git(dir, 'add', '-A');
	git(dir, 'commit', '-m', 'base');
	git(dir, 'remote', 'add', 'origin', remote);
	git(dir, 'push', 'origin', 'main');
	return { dir, remote };
}
