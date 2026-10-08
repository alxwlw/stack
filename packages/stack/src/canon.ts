import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Profile, StackConfig } from './config.ts';

export type SyncStrategy = 'verbatim' | 'create-if-absent';

export interface CanonFile {
	src: string;
	dest: string;
	appliesTo: Profile[];
	strategy?: SyncStrategy;
	/** Группа, включаемая через `with` в .stack.jsonc. Без группы файл обязателен всем. */
	group?: string;
	/** Для create-if-absent: другие пути, любой из которых тоже закрывает засев (у конфига несколько законных имён). */
	satisfiedBy?: string[];
}

export type CanonCatalogs = Record<string, Record<string, string>>;

// Канон одного прогона как значение: уже отфильтрован под профиль и группы, содержимое файлов
// прочитано, пины node и pnpm вычислены. Правила и план принимают его и не знают, где лежит каталог.
export interface Canon {
	files: { dest: string; content: string; strategy?: SyncStrategy; satisfiedBy?: string[] }[];
	catalogs: CanonCatalogs;
	nodePin: string;
	pnpmPin: string;
	/** Бот зависимостей репо. renovate добавляет правило renovate-ignore (конфиг Renovate должен отключать `@alxwlw/*`); dependabot-ignore по-прежнему проверяет .github/dependabot.yml, если файл есть. */
	bot?: 'dependabot' | 'renovate';
}

export function canonDir(): string {
	return join(dirname(fileURLToPath(import.meta.url)), '..', 'canon');
}

export function loadManifest(dir: string = canonDir()): CanonFile[] {
	const raw = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
		files: CanonFile[];
	};
	return raw.files;
}

export function filesFor(cfg: StackConfig, dir: string = canonDir()): CanonFile[] {
	return loadManifest(dir).filter(
		(f) => f.appliesTo.includes(cfg.profile) && (f.group == null || cfg.with.includes(f.group)),
	);
}

export function loadCatalogs(dir: string = canonDir()): CanonCatalogs {
	return JSON.parse(readFileSync(join(dir, 'catalogs.json'), 'utf8')) as CanonCatalogs;
}

export function loadCanon(cfg: StackConfig, dir: string = canonDir()): Canon {
	const files = filesFor(cfg, dir).map((f) => ({
		dest: f.dest,
		content: readFileSync(join(dir, f.src), 'utf8'),
		strategy: f.strategy,
		satisfiedBy: f.satisfiedBy,
	}));
	const all = loadCatalogs(dir);
	const groups = ['dev', ...cfg.with.filter((g) => g !== 'dev')];
	const catalogs = Object.fromEntries(
		groups.filter((g) => g in all).map((g) => [g, all[g] as Record<string, string>]),
	);
	// Единственное место, где канон-файл читается как данные, а не копируется: пин node нужен
	// правилу engines-node и пин pnpm — правилу package-manager, они одинаковы во всех профилях.
	const prototools = files.find((f) => f.dest === '.prototools');
	if (!prototools) {
		throw new Error('canon manifest has no .prototools entry for profile ' + cfg.profile);
	}
	const pin = /^node\s*=\s*"([^"]+)"/m.exec(prototools.content);
	if (!pin?.[1]) throw new Error('canon .prototools has no node pin');
	// Пин pnpm нужен правилу package-manager: поле packageManager — второй источник версии pnpm.
	const pnpm = /^pnpm\s*=\s*"([^"]+)"/m.exec(prototools.content);
	if (!pnpm?.[1]) throw new Error('canon .prototools has no pnpm pin');
	return {
		files,
		catalogs,
		nodePin: pin[1],
		pnpmPin: pnpm[1],
		bot: cfg.with.includes('renovate') ? 'renovate' : 'dependabot',
	};
}
