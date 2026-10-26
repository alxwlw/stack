import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { stringify } from 'yaml';

import { type Canon, canonGroups, loadCanon } from './canon.ts';
import type { Profile } from './config.ts';
import { STACK_RENOVATE_PRESET } from './deps.ts';
import { RENOVATE_CONFIGS, type Repo, repoFromFiles } from './repo.ts';

// Канон для тестов правил. Пины нарочно не равны реальным пинам канона: иначе константа,
// зашитая в правило, осталась бы незамеченной (engines-node в deps.ts, packageManager в package-manager.ts).
export function testCanon(over: Partial<Canon> = {}): Canon {
	return { files: [], catalogs: {}, pins: { node: '25.4.1', pnpm: '10.99.0' }, ...over };
}

// Содержимое канон-файла по его dest, как его видит loadCanon: все группы включены. Тесты, сверяющие
// канон с корнем репозитория или с самим собой, берут файл здесь, а не по пути в canon/files.
export function canonFile(dest: string, profile: Profile = 'node'): string {
	const g = canonGroups();
	const canon = loadCanon({ profile, with: [...g.files, ...g.catalogs], exceptions: [] });
	const file = canon.files.find((f) => f.dest === dest);
	if (!file) throw new Error(`no canon file ${dest} for profile ${profile}`);
	return file.content;
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

// canonRepoFiles + правки теста; null удаляет файл.
export function testRepo(canon: Canon, over: Record<string, string | null> = {}): Repo {
	const files = canonRepoFiles(canon);
	for (const [path, content] of Object.entries(over)) {
		if (content === null) files.delete(path);
		else files.set(path, content);
	}
	return repoFromFiles(files);
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
