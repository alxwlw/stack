import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type Profile, PROFILES, type StackConfig, StackConfigError } from './config.ts';
import { ownManifest, ownPackages, type StackManifest } from './own-packages.ts';
import type { Wanted } from './registry.ts';

export const SYNC_STRATEGIES = ['verbatim', 'create-if-absent'] as const;
export type SyncStrategy = (typeof SYNC_STRATEGIES)[number];

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

// Ключи записи manifest: Record<keyof CanonFile, true> не даёт полю без ключа и ключу без поля пройти tsc.
const ENTRY_KEYS: Record<keyof CanonFile, true> = {
	src: true,
	dest: true,
	appliesTo: true,
	strategy: true,
	group: true,
	satisfiedBy: true,
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v !== '';

const isProfile = (v: unknown): v is Profile => PROFILES.some((known) => known === v);
const isStrategy = (v: unknown): v is SyncStrategy => SYNC_STRATEGIES.some((known) => known === v);

// Нарушение manifest — дефект пакета, а не потребителя: обычная Error, не StackConfigError.
function checkEntry(raw: unknown, index: number): CanonFile {
	if (!isRecord(raw)) throw new Error(`canon manifest: entry ${index}: must be an object`);
	const at = isNonEmptyString(raw.dest) ? `entry ${index} (${raw.dest})` : `entry ${index}`;
	function bad(what: string): never {
		throw new Error(`canon manifest: ${at}: ${what}`);
	}
	for (const key of Object.keys(raw)) {
		if (!Object.hasOwn(ENTRY_KEYS, key)) bad(`unknown key ${JSON.stringify(key)}`);
	}
	const { src, dest, appliesTo, strategy, group, satisfiedBy } = raw;
	if (!isNonEmptyString(dest)) return bad('"dest" must be a non-empty string');
	if (!isNonEmptyString(src)) return bad('"src" must be a non-empty string');
	if (!Array.isArray(appliesTo) || appliesTo.length === 0) {
		return bad(
			`"appliesTo" must be a non-empty array of profiles, got ${JSON.stringify(appliesTo)}`,
		);
	}
	const profiles: Profile[] = [];
	for (const p of appliesTo as unknown[]) {
		if (!isProfile(p) || profiles.includes(p)) {
			return bad(
				`"appliesTo" has ${JSON.stringify(p)}: expected each of ${PROFILES.join(', ')} at most once`,
			);
		}
		profiles.push(p);
	}
	const file: CanonFile = { src, dest, appliesTo: profiles };
	if (strategy !== undefined) {
		if (!isStrategy(strategy)) {
			return bad(
				`"strategy" is ${JSON.stringify(strategy)}, expected one of ${SYNC_STRATEGIES.join(', ')}`,
			);
		}
		file.strategy = strategy;
	}
	if (group !== undefined) {
		if (!isNonEmptyString(group)) return bad('"group" must be a non-empty string');
		file.group = group;
	}
	if (satisfiedBy !== undefined) {
		if (strategy !== 'create-if-absent')
			return bad('"satisfiedBy" needs strategy "create-if-absent"');
		if (
			!Array.isArray(satisfiedBy) ||
			satisfiedBy.length === 0 ||
			!satisfiedBy.every(isNonEmptyString)
		) {
			return bad('"satisfiedBy" must be a non-empty array of non-empty strings');
		}
		file.satisfiedBy = satisfiedBy;
	}
	return file;
}

// Manifest целиком, до чтения первого src. Среди записей одного Profile dest не повторяется
// (group не учитывается: группы выбирает потребитель, любые две рано или поздно включат вместе).
function checkManifest(raw: unknown): CanonFile[] {
	const files = isRecord(raw) ? raw.files : undefined;
	if (!Array.isArray(files)) throw new Error('canon manifest: "files" must be an array');
	const entries = (files as unknown[]).map(checkEntry);
	// Ruling 33: план напишет оба файла, применитель оставит последний, и следующий план вечно
	// видит дрейф по проигравшей записи.
	for (const profile of PROFILES) {
		const seen = new Set<string>();
		for (const e of entries) {
			if (!e.appliesTo.includes(profile)) continue;
			if (seen.has(e.dest)) {
				throw new Error(`canon manifest: dest "${e.dest}" is listed twice for profile ${profile}`);
			}
			seen.add(e.dest);
		}
	}
	return entries;
}

export type CanonCatalogs = Record<string, Record<string, string>>;

// Канон одного прогона как значение: уже отфильтрован под профиль и группы, содержимое файлов
// прочитано, пины node и pnpm вычислены. Правила и план принимают его и не знают, где лежит каталог.
export interface Canon {
	files: { dest: string; content: string; strategy?: SyncStrategy; satisfiedBy?: string[] }[];
	catalogs: CanonCatalogs;
	pins: Pins;
	/** Включённые через with группы правил, в порядке RULE_GROUPS. */
	rules: RuleGroup[];
	/** Свои пакеты: приходят потребителю с каналом, прямо или зависимостью stack. */
	ownPackages: readonly Wanted[];
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

// Группа правила включает правило `stack check`, файлов и каталогов не даёт.
export const RULE_GROUPS = ['peers', 'repo-rules'] as const;
export type RuleGroup = (typeof RULE_GROUPS)[number];

export interface CanonGroups {
	files: string[];
	catalogs: string[];
	deprecated: readonly string[];
	rules: readonly string[];
}

// canon/ как значение: все записи манифеста с содержимым, каталоги и имена групп. Читается один раз;
// выбор под профиль и with — чистый шаг canonFor.
export interface CanonSource {
	entries: readonly (CanonFile & { content: string })[];
	catalogs: CanonCatalogs;
	groups: CanonGroups;
	/** package.json самого stack: его зависимости — свои пакеты, пришедшие транзитивно. */
	manifest: StackManifest;
}

// Единственное место, где canon/ и package.json пакета читаются с диска: manifest.json и catalogs.json
// по разу, каждый src по разу, package.json пакета один раз (не зависит от dir).
// Имена групп: файловые — поле group манифеста, каталожные — ключи catalogs.json кроме dev, устаревшие и
// группы правил — константы этого модуля.
export function readCanonSource(dir: string = canonDir()): CanonSource {
	const manifest = checkManifest(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')));
	const catalogs = JSON.parse(readFileSync(join(dir, 'catalogs.json'), 'utf8')) as CanonCatalogs;
	const entries = manifest.map((f) => ({
		...f,
		content: readFileSync(join(dir, f.src), 'utf8'),
	}));
	const groups: CanonGroups = {
		files: [...new Set(entries.flatMap((f) => (f.group == null ? [] : [f.group])))],
		catalogs: Object.keys(catalogs).filter((g) => g !== 'dev'),
		deprecated: DEPRECATED_GROUPS,
		rules: RULE_GROUPS,
	};
	return { entries, catalogs, groups, manifest: ownManifest() };
}

// Все имена, допустимые в `with`: файловые, каталожные, устаревшие и группы правил — без повторов,
// по алфавиту.
export function knownGroups(g: CanonGroups): string[] {
	return [...new Set([...g.files, ...g.catalogs, ...g.deprecated, ...g.rules])].sort();
}

export function assertKnownGroups(groups: readonly string[], source: CanonSource): void {
	const known = knownGroups(source.groups);
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

// Чистый шаг от источника к Canon: проверка групп, выбор записей, каталоги, пины, группы правил.
// Диск не трогает.
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
	const rules = RULE_GROUPS.filter((g) => cfg.with.includes(g));
	return {
		files,
		catalogs,
		pins: { ...rest, node, pnpm },
		rules,
		ownPackages: ownPackages(source.catalogs.dev, source.manifest),
	};
}

export function loadCanon(cfg: StackConfig, dir: string = canonDir()): Canon {
	return canonFor(readCanonSource(dir), cfg);
}

// Строковые значения верхнего уровня .prototools; таблица [plugins] и нестроковые значения — не пины.
export function parsePins(prototools: string): Record<string, string> {
	const parsed = Bun.TOML.parse(prototools) as Record<string, unknown>;
	return Object.fromEntries(
		Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === 'string'),
	);
}
