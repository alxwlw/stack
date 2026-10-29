import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type Profile, type StackConfig, StackConfigError } from './config.ts';

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
	pins: Pins;
}

// Пины инструментов из .prototools канона: node и pnpm обязательны, прочие строки верхнего уровня допустимы.
export type Pins = {
	readonly node: string;
	readonly pnpm: string;
	readonly [tool: string]: string;
};

export function canonDir(): string {
	return join(dirname(fileURLToPath(import.meta.url)), '..', 'canon');
}

// Устаревшие группы принимаются ради старых .stack.jsonc и ничего не включают.
const DEPRECATED_GROUPS: readonly string[] = ['renovate'];

export interface CanonGroups {
	files: string[];
	catalogs: string[];
	deprecated: readonly string[];
}

// canon/ как значение: все записи манифеста с содержимым, каталоги и имена групп. Читается один раз;
// выбор под профиль и with — чистый шаг canonFor.
export interface CanonSource {
	entries: readonly (CanonFile & { content: string })[];
	catalogs: CanonCatalogs;
	groups: CanonGroups;
}

// Единственное место, где canon/ читается с диска: manifest.json и catalogs.json по разу, каждый src по разу.
// Имена групп: файловые — поле group манифеста, каталожные — ключи catalogs.json кроме dev.
export function readCanonSource(dir: string = canonDir()): CanonSource {
	const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
		files: CanonFile[];
	};
	const catalogs = JSON.parse(readFileSync(join(dir, 'catalogs.json'), 'utf8')) as CanonCatalogs;
	const entries = manifest.files.map((f) => ({
		...f,
		content: readFileSync(join(dir, f.src), 'utf8'),
	}));
	const groups: CanonGroups = {
		files: [...new Set(entries.flatMap((f) => (f.group == null ? [] : [f.group])))],
		catalogs: Object.keys(catalogs).filter((g) => g !== 'dev'),
		deprecated: DEPRECATED_GROUPS,
	};
	return { entries, catalogs, groups };
}

export function assertKnownGroups(groups: readonly string[], source: CanonSource): void {
	const g = source.groups;
	const known = [...g.files, ...g.catalogs, ...g.deprecated].sort();
	for (const name of groups) {
		if (!known.includes(name)) {
			throw new StackConfigError(
				`unknown group "${name}" in "with", expected one of: ${known.join(', ')}`,
			);
		}
	}
}

// Единственный предикат выбора: запись приходит в канон профиля, если профиль в appliesTo, а группа
// (если есть) включена через with. Им же пользуются гварды тестов, у которых нет права на свою копию.
export function selectEntries(source: CanonSource, cfg: StackConfig): CanonSource['entries'] {
	return source.entries.filter(
		(f) => f.appliesTo.includes(cfg.profile) && (f.group == null || cfg.with.includes(f.group)),
	);
}

// Чистый шаг от источника к Canon: проверка групп, выбор записей, каталоги, пины. Диск не трогает.
export function canonFor(source: CanonSource, cfg: StackConfig): Canon {
	assertKnownGroups(cfg.with, source);
	const files = selectEntries(source, cfg).map((f) => ({
		dest: f.dest,
		content: f.content,
		strategy: f.strategy,
		satisfiedBy: f.satisfiedBy,
	}));
	const all = source.catalogs;
	const groups = ['dev', ...cfg.with];
	const catalogs = Object.fromEntries(
		groups.filter((g) => g in all).map((g) => [g, all[g] as Record<string, string>]),
	);
	// Единственное место, где канон-файл читается как данные, а не копируется: пин node нужен
	// правилу engines-node и пин pnpm — правилу package-manager, они одинаковы во всех профилях.
	const prototools = files.find((f) => f.dest === '.prototools');
	if (!prototools) {
		throw new Error('canon manifest has no .prototools entry for profile ' + cfg.profile);
	}
	const { node, pnpm, ...rest } = parsePins(prototools.content);
	if (!node) throw new Error('canon .prototools has no node pin');
	// Пин pnpm нужен правилу package-manager: поле packageManager — второй источник версии pnpm.
	if (!pnpm) throw new Error('canon .prototools has no pnpm pin');
	return { files, catalogs, pins: { ...rest, node, pnpm } };
}

export function loadCanon(cfg: StackConfig, dir: string = canonDir()): Canon {
	return canonFor(readCanonSource(dir), cfg);
}

// Строковые значения верхнего уровня .prototools; таблица [plugins] и нестроковые значения — не пины.
function parsePins(prototools: string): Record<string, string> {
	const parsed = Bun.TOML.parse(prototools) as Record<string, unknown>;
	return Object.fromEntries(
		Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === 'string'),
	);
}
