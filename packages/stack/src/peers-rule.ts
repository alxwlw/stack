// Правило группы peers над Repo: исход `pnpm peers check` против baseline. Отдельный модуль, потому
// что repo.ts берёт разбор baseline из peers.ts, и правило в peers.ts замкнуло бы цикл импортов.

import type { Finding } from './findings.ts';
import { comparePeers, type PeerEntry, PEERS_BASELINE, type PeersOutcome } from './peers.ts';
import { LOCKFILE, type Repo } from './repo.ts';

const TARGET = 'pnpm peers check';

const where = (e: PeerEntry): string => `${e.peer} in ${e.importer}`;

// Запись baseline словами: вид, объявивший пакет и линия найденной версии, если они есть у вида.
function recorded(e: PeerEntry): string {
	switch (e.kind) {
		case 'unmet':
			return `unmet by ${e.by} (found ${e.found})`;
		case 'missing':
			return `missing by ${e.by}`;
		case 'conflict':
			return 'conflict';
	}
}

// Без лока pnpm ответил бы `{}` с кодом 0, то есть «чисто», поэтому исход тогда не читается вовсе.
// Неразобранный baseline даёт находку в загрузчике, и пустым baseline он не считается.
export function checkPeers(repo: Repo, outcome: PeersOutcome | undefined): Finding[] {
	if (!repo.paths.has(LOCKFILE)) {
		return [{ code: 'peers-unavailable', target: TARGET, message: `no ${LOCKFILE}` }];
	}
	if (outcome === undefined) throw new Error('checkPeers: no pnpm peers check outcome');
	if ('unavailable' in outcome) {
		return [{ code: 'peers-unavailable', target: TARGET, message: outcome.unavailable }];
	}
	if (repo.paths.has(PEERS_BASELINE) && repo.peersBaseline === undefined) return [];
	const { added, stale } = comparePeers(outcome.issues, repo.peersBaseline ?? []);
	return [
		...added.map((i): Finding => ({
			code: 'peer-dependency',
			target: where(i.entry),
			message: `${i.detail}; not in ${PEERS_BASELINE}`,
		})),
		...stale.map((e): Finding => ({
			code: 'stale-peer-baseline',
			target: where(e),
			message: `recorded ${recorded(e)} is gone; drop it with: stack peers-baseline`,
		})),
	];
}
