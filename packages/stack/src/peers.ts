// Ядро гейта `pnpm peers check`: разбор ответа pnpm, ключ проблемы, файл baseline и сравнение.
// Только чистые функции: процесс pnpm и диск — у вызывающих.

// Файл baseline канона: по имени его команды из настроек.
export const peersBaselineFile = (command: string): string => `.${command}-peers-baseline.json`;

// Устойчивый ключ одной проблемы и запись baseline — одно и то же значение.
// Сырой JSON pnpm недетерминирован, поэтому в ключе нет версии объявившего пакета, wantedRange
// и parents[0].
export type PeerEntry =
	| { importer: string; peer: string; kind: 'unmet'; by: string; found: string }
	| { importer: string; peer: string; kind: 'missing'; by: string }
	| { importer: string; peer: string; kind: 'conflict' };

// Текущая проблема: ключ плюс текст для находки (не входит в ключ).
export interface PeerIssue {
	entry: PeerEntry;
	detail: string;
}

// Результат запуска pnpm как данные: порт процесса отдаёт его, разбор — чистый.
export type PeersRun =
	| { status: number | null; signal: string | null; stdout: string; stderr: string }
	| { error: string };
export type PeersOutcome = { issues: PeerIssue[] } | { unavailable: string };
// Порт процесса: запуск `pnpm peers check` в корне репозитория.
export type PeersReader = (repoRoot: string) => PeersRun;

// Линия версии: major, у 0.x — 0.minor, у 0.0.x — 0.0.patch. Пре-релиз и build отброшены,
// версия не по semver (link:, file:) остаётся как есть.
export function versionLine(version: string): string {
	const [major, minor, patch, ...rest] = version.replace(/[-+][\s\S]*$/, '').split('.');
	const digits = (p: string | undefined): p is string => p !== undefined && /^\d+$/.test(p);
	if (!digits(major) || !digits(minor) || !digits(patch) || rest.length > 0) return version;
	if (Number(major) > 0) return major;
	if (Number(minor) > 0) return `0.${minor}`;
	return `0.0.${patch}`;
}

export function peerKey(e: PeerEntry): string {
	const by = e.kind === 'conflict' ? '' : e.by;
	const found = e.kind === 'unmet' ? e.found : '';
	return JSON.stringify([e.importer, e.peer, e.kind, by, found]);
}

// Порядок записей везде — по ключу, сравнением строк по кодовым единицам.
function byKey<T>(items: readonly T[], key: (t: T) => string): T[] {
	return items
		.map((item) => ({ item, k: key(item) }))
		.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0))
		.map(({ item }) => item);
}

const sortEntries = (entries: readonly PeerEntry[]): PeerEntry[] => byKey(entries, peerKey);
const sortIssues = (issues: readonly PeerIssue[]): PeerIssue[] =>
	byKey(issues, (i) => peerKey(i.entry));

function isObject(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v !== '';

// Общая часть записи pnpm из bad и missing после проверки формы. by — parents[-1], пакет,
// который объявил peer.
interface PnpmRecord {
	by: string;
	byVersion: string;
	wantedRange: string;
	suffix: string;
}

// Сбой формы ответа pnpm; peersOutcome превращает его в unavailable.
class ShapeError extends Error {}

function pnpmRecord(raw: Record<string, unknown>, at: string): PnpmRecord {
	const isParent = (p: unknown): p is { name: string; version: string } =>
		isObject(p) && nonEmpty(p.name) && typeof p.version === 'string';
	const parents: unknown[] = Array.isArray(raw.parents) ? raw.parents : [];
	const last = parents.at(-1);
	if (!parents.every(isParent) || !isParent(last)) {
		throw new ShapeError(`${at}: "parents" is not a non-empty array of {name, version}`);
	}
	if (typeof raw.optional !== 'boolean') throw new ShapeError(`${at}: "optional" is not a boolean`);
	if (typeof raw.wantedRange !== 'string') {
		throw new ShapeError(`${at}: "wantedRange" is not a string`);
	}
	return {
		by: last.name,
		byVersion: last.version,
		wantedRange: raw.wantedRange,
		suffix: raw.optional ? ' (optional)' : '',
	};
}

// Записи поля bad или missing одного importer: peer, сама запись и её место для текста сбоя.
function pnpmGroup(
	importer: Record<string, unknown>,
	field: 'bad' | 'missing',
	at: string,
): [string, Record<string, unknown>, string][] {
	const group = importer[field];
	if (!isObject(group)) throw new ShapeError(`${at}: "${field}" is not an object`);
	const out: [string, Record<string, unknown>, string][] = [];
	for (const [peer, records] of Object.entries(group)) {
		const where = `${at}: ${field} ${JSON.stringify(peer)}`;
		if (peer === '') throw new ShapeError(`${where} has an empty name`);
		if (!Array.isArray(records)) throw new ShapeError(`${where} is not an array`);
		records.forEach((r: unknown, i) => {
			if (!isObject(r)) throw new ShapeError(`${where}[${i}] is not an object`);
			out.push([peer, r, `${where}[${i}]`]);
		});
	}
	return out;
}

// Разбор разобранного JSON в проблемы. Несколько исходных записей одного ключа — одна проблема
// с наименьшим текстом: так текст не зависит от порядка записей в ответе pnpm.
function pnpmIssues(json: unknown): PeerIssue[] {
	if (!isObject(json)) throw new ShapeError('top level is not an object');
	const seen = new Map<string, PeerIssue>();
	const add = (entry: PeerEntry, detail: string): void => {
		const k = peerKey(entry);
		const prev = seen.get(k);
		if (prev === undefined || detail < prev.detail) seen.set(k, { entry, detail });
	};
	for (const [importer, raw] of Object.entries(json)) {
		const at = `importer ${JSON.stringify(importer)}`;
		if (importer === '') throw new ShapeError(`${at} has an empty name`);
		if (!isObject(raw)) throw new ShapeError(`${at} is not an object`);
		for (const [peer, rec, where] of pnpmGroup(raw, 'bad', at)) {
			const r = pnpmRecord(rec, where);
			const found = rec.foundVersion;
			if (!nonEmpty(found)) {
				throw new ShapeError(`${where}: "foundVersion" is not a non-empty string`);
			}
			add(
				{ importer, peer, kind: 'unmet', by: r.by, found: versionLine(found) },
				`${r.by}@${r.byVersion} wants ${r.wantedRange}, found ${found}${r.suffix}`,
			);
		}
		for (const [peer, rec, where] of pnpmGroup(raw, 'missing', at)) {
			const r = pnpmRecord(rec, where);
			add(
				{ importer, peer, kind: 'missing', by: r.by },
				`${r.by}@${r.byVersion} wants ${r.wantedRange}, none installed${r.suffix}`,
			);
		}
		const conflicts = raw.conflicts;
		if (!Array.isArray(conflicts) || !conflicts.every(nonEmpty)) {
			throw new ShapeError(`${at}: "conflicts" is not an array of package names`);
		}
		for (const peer of conflicts) {
			add({ importer, peer, kind: 'conflict' }, 'no version satisfies every range');
		}
	}
	return sortIssues([...seen.values()]);
}

const firstLine = (text: string): string | undefined =>
	text
		.split('\n')
		.map((l) => l.trim())
		.find((l) => l !== '');

// Сбой запуска, сигнал, код кроме 0 и 1, не JSON или не та форма — unavailable, и чистым это
// не считается никогда.
export function peersOutcome(run: PeersRun): PeersOutcome {
	if ('error' in run) return { unavailable: `pnpm peers check did not start: ${run.error}` };
	if (run.signal !== null) return { unavailable: `pnpm peers check killed by ${run.signal}` };
	if (run.status !== 0 && run.status !== 1) {
		const line = firstLine(run.stderr);
		const tail = line === undefined ? '' : `: ${line}`;
		return { unavailable: `pnpm peers check exited with ${run.status}${tail}` };
	}
	let json: unknown;
	try {
		json = JSON.parse(run.stdout);
	} catch {
		return { unavailable: 'pnpm peers check output is not JSON' };
	}
	try {
		return { issues: pnpmIssues(json) };
	} catch (e) {
		if (!(e instanceof ShapeError)) throw e;
		return { unavailable: `pnpm peers check output has an unexpected shape: ${e.message}` };
	}
}

// Запись baseline из JSON: ровно ключи своего kind, все значения — непустые строки. Число ключей
// вместе с обязательными полями исключает лишние. Ключи собираются заново в порядке peerKey.
function baselineEntry(raw: unknown): PeerEntry | undefined {
	if (!isObject(raw)) return undefined;
	const size = Object.keys(raw).length;
	const { importer, peer, kind, by, found } = raw;
	if (!nonEmpty(importer) || !nonEmpty(peer)) return undefined;
	if (kind === 'conflict' && size === 3) return { importer, peer, kind };
	if (!nonEmpty(by)) return undefined;
	if (kind === 'missing' && size === 4) return { importer, peer, kind, by };
	if (kind === 'unmet' && size === 5 && nonEmpty(found)) return { importer, peer, kind, by, found };
	return undefined;
}

// Формат файла: { "version": 1, "peers": [<PeerEntry>…] }, оба ключа обязательны, других нет.
// Порядок записей при чтении не проверяется, повтор записи — проблема.
export function parsePeersBaseline(text: string): { entries: PeerEntry[] } | { problem: string } {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (e) {
		return { problem: `not JSON: ${e instanceof Error ? e.message : String(e)}` };
	}
	if (!isObject(raw) || raw.version !== 1) return { problem: 'version must be 1' };
	const unknownKey = Object.keys(raw).find((k) => k !== 'version' && k !== 'peers');
	if (unknownKey !== undefined) return { problem: `unknown field «${unknownKey}»` };
	if (!Array.isArray(raw.peers)) return { problem: '"peers" must be an array' };
	const entries: PeerEntry[] = [];
	const keys = new Set<string>();
	for (const [i, item] of raw.peers.entries()) {
		const entry = baselineEntry(item);
		if (entry === undefined) return { problem: `peers[${i}] is not a valid entry` };
		const k = peerKey(entry);
		if (keys.has(k)) return { problem: `peers[${i}] repeats an earlier entry` };
		keys.add(k);
		entries.push(entry);
	}
	return { entries };
}

// Поля записи в порядке ключа, лишние свойства не пишутся.
function plainEntry(e: PeerEntry): PeerEntry {
	switch (e.kind) {
		case 'unmet':
			return { importer: e.importer, peer: e.peer, kind: e.kind, by: e.by, found: e.found };
		case 'missing':
			return { importer: e.importer, peer: e.peer, kind: e.kind, by: e.by };
		case 'conflict':
			return { importer: e.importer, peer: e.peer, kind: e.kind };
	}
}

// Записи по ключу, перевод строки в конце. Отступ — таб, а два пробела, если ими отступает
// прежний текст файла.
export function serializePeersBaseline(entries: readonly PeerEntry[], previous?: string): string {
	const indent = previous !== undefined && /^ {2}/m.test(previous) ? '  ' : '\t';
	const peers = sortEntries(entries).map(plainEntry);
	return `${JSON.stringify({ version: 1, peers }, null, indent)}\n`;
}

export function comparePeers(
	current: readonly PeerIssue[],
	baseline: readonly PeerEntry[],
): { added: PeerIssue[]; stale: PeerEntry[] } {
	const recorded = new Set(baseline.map(peerKey));
	const now = new Set(current.map((i) => peerKey(i.entry)));
	return {
		added: sortIssues(current.filter((i) => !recorded.has(peerKey(i.entry)))),
		stale: sortEntries(baseline.filter((e) => !now.has(peerKey(e)))),
	};
}

// Baseline ∩ текущие: исправленное уходит, новое не добавляется.
export function lowerPeersBaseline(
	baseline: readonly PeerEntry[],
	current: readonly PeerIssue[],
): PeerEntry[] {
	const now = new Set(current.map((i) => peerKey(i.entry)));
	return sortEntries(baseline.filter((e) => now.has(peerKey(e))));
}
