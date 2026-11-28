// Группа peers над Repo: правило — исход `pnpm peers check` против baseline (checkPeers); чтение
// readPeers и сама группа peersGroup — через порт pnpm. Отдельный модуль, потому что repo.ts берёт
// разбор baseline из peers.ts, и правило в peers.ts замкнуло бы цикл импортов.

import type { Finding } from './findings.ts';
import {
	comparePeers,
	type PeerEntry,
	peersBaselineFile,
	type PeersOutcome,
	peersOutcome,
	type PeersReader,
} from './peers.ts';
import { LOCKFILE, type Repo } from './repo.ts';
import type { RuleGroupModule } from './rule-group.ts';

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

// Чтение группы peers: без pnpm-lock.yaml порт не зовётся, исход — unavailable с причиной «no pnpm-lock.yaml».
// Без лока pnpm ответил бы `{}` с кодом 0, то есть «чисто», поэтому порт тогда не зовётся вовсе.
export function readPeers(repo: Repo, repoRoot: string, read: PeersReader): PeersOutcome {
	if (!repo.paths.has(LOCKFILE)) return { unavailable: `no ${LOCKFILE}` };
	return peersOutcome(read(repoRoot));
}

// Неразобранный baseline даёт находку в загрузчике, и пустым baseline он не считается.
export function checkPeers(repo: Repo, outcome: PeersOutcome, command: string): Finding[] {
	if ('unavailable' in outcome) {
		return [{ code: 'peers-unavailable', target: TARGET, message: outcome.unavailable }];
	}
	const file = peersBaselineFile(command);
	if (repo.paths.has(file) && repo.peersBaseline === undefined) return [];
	const { added, stale } = comparePeers(outcome.issues, repo.peersBaseline ?? []);
	return [
		...added.map((i): Finding => ({
			code: 'peer-dependency',
			target: where(i.entry),
			message: `${i.detail}; not in ${file}`,
		})),
		...stale.map((e): Finding => ({
			code: 'stale-peer-baseline',
			target: where(e),
			message: `recorded ${recorded(e)} is gone; drop it with: ${command} peers-baseline`,
		})),
	];
}

// Группа peers: исход читается через порт pnpm, пометок у группы нет.
export const peersGroup: RuleGroupModule<PeersReader> = (ctx, read) => ({
	findings: checkPeers(
		ctx.repo,
		readPeers(ctx.repo, ctx.repoRoot, read),
		ctx.canon.settings.command,
	),
	notes: [],
});
