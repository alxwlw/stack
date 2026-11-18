// `stack peers-baseline`: единственное место, где файл baseline группы peers пишется на диск.
// init — записать текущие проблемы в новый файл; lower — только убрать исправленные; grow — принять
// и новые; drop-fixed — убрать исправленные, если они есть, молча во всём остальном (sync-pr).

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Canon } from './canon.ts';
import {
	comparePeers,
	lowerPeersBaseline,
	PEERS_BASELINE,
	peersOutcome,
	type PeersReader,
	serializePeersBaseline,
} from './peers.ts';
import { loadRepo, LOCKFILE } from './repo.ts';

export type PeersBaselineMode = 'init' | 'lower' | 'grow' | 'drop-fixed';

export interface PeersBaselineResult {
	code: 0 | 1 | 2;
	out: string[];
	err: string[];
}

const failed = (code: 1 | 2, line: string): PeersBaselineResult => ({ code, out: [], err: [line] });
const quiet = (): PeersBaselineResult => ({ code: 0, out: [], err: [] });

// Порядок проверок: группа, разбор файла, есть ли файл для режима, лок, pnpm, рост в lower. Первая
// сработавшая решает; файл пишется только в самом конце. drop-fixed там, где делать нечего, молчит.
export function peersBaseline(
	repoRoot: string,
	canon: Canon,
	mode: PeersBaselineMode,
	readPeers: PeersReader,
): PeersBaselineResult {
	const dropFixed = mode === 'drop-fixed';
	if (!canon.rules.includes('peers')) {
		return dropFixed
			? quiet()
			: failed(2, 'peers-baseline needs "peers" in "with" of .stack.jsonc');
	}
	const repo = loadRepo(repoRoot, canon);
	// Неразобранный файл не перезаписывается: в нём могли быть записи, которых больше нигде нет.
	const broken = repo.unreadable.find((f) => f.target === PEERS_BASELINE);
	if (broken !== undefined) return failed(2, broken.message);
	const exists = repo.paths.has(PEERS_BASELINE);
	if (mode === 'init' && exists) return failed(2, `${PEERS_BASELINE} already exists`);
	if (mode !== 'init' && !exists) {
		return dropFixed ? quiet() : failed(2, `no ${PEERS_BASELINE}: run stack peers-baseline --init`);
	}
	if (!repo.paths.has(LOCKFILE)) return failed(1, `no ${LOCKFILE}`);
	const outcome = peersOutcome(readPeers(repoRoot));
	if ('unavailable' in outcome) return failed(1, outcome.unavailable);

	const current = outcome.issues;
	const baseline = repo.peersBaseline ?? [];
	const { added, stale } = comparePeers(current, baseline);
	if (mode === 'lower' && added.length > 0) {
		return {
			code: 1,
			out: [],
			err: [
				...added.map((i) => `new: ${i.entry.peer} in ${i.entry.importer} — ${i.detail}`),
				`${added.length} new entr(ies) — fix them or pass --allow-grow`,
			],
		};
	}
	if (dropFixed && stale.length === 0) return quiet();

	const next =
		mode === 'init' || mode === 'grow'
			? current.map((i) => i.entry)
			: lowerPeersBaseline(baseline, current);
	writeFileSync(
		join(repoRoot, PEERS_BASELINE),
		serializePeersBaseline(next, repo.files.get(PEERS_BASELINE)),
	);
	const wrote = `wrote ${PEERS_BASELINE}: ${next.length} entr(ies)`;
	const line =
		mode === 'init'
			? wrote
			: dropFixed
				? `dropped ${stale.length} fixed entr(ies) from ${PEERS_BASELINE}`
				: `${wrote} (-${stale.length} fixed, +${added.length} new)`;
	return { code: 0, out: [line], err: [] };
}
