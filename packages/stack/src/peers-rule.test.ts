import { expect, test } from 'bun:test';

import type { Finding } from './findings.ts';
import { type PeerEntry, type PeerIssue, PEERS_BASELINE, type PeersRun } from './peers.ts';
import { checkPeers, peersGroup, readPeers } from './peers-rule.ts';
import { LOCKFILE, type Read, type Repo, repoFromSnapshot } from './repo.ts';
import { fakePeersReader, groupContext, ONE_BAD } from './testkit.ts';

// Repo из снимка: pnpm-lock.yaml есть, если не сказано иное; baseline — записи или сырой текст.
function repoWith(
	baseline?: readonly PeerEntry[] | string,
	{ lock = true }: { lock?: boolean } = {},
): Repo {
	const snapshot = new Map<string, Read>([['package.json', { text: '{}' }]]);
	if (lock) snapshot.set(LOCKFILE, { text: 'lockfileVersion: x\n' });
	if (baseline !== undefined) {
		const text =
			typeof baseline === 'string' ? baseline : JSON.stringify({ version: 1, peers: baseline });
		snapshot.set(PEERS_BASELINE, { text });
	}
	return repoFromSnapshot(snapshot);
}

const UNMET: PeerIssue = {
	entry: { importer: '.', peer: 'peer', kind: 'unmet', by: 'decl', found: '1' },
	detail: 'decl@1.0.0 wants ^2.0.0, found 1.0.0',
};
const MISSING: PeerIssue = {
	entry: { importer: 'packages/a', peer: 'react', kind: 'missing', by: 'ui-kit' },
	detail: 'ui-kit@3.1.0 wants ^19.0.0, none installed (optional)',
};

const NO_LOCK: Finding = {
	code: 'peers-unavailable',
	target: 'pnpm peers check',
	message: 'no pnpm-lock.yaml',
};

const CLEAN_RUN: PeersRun = { status: 0, signal: null, stdout: '{}', stderr: '' };

test('readPeers: без pnpm-lock.yaml порт не зовётся, исход — unavailable', () => {
	const port = fakePeersReader(CLEAN_RUN);
	expect(readPeers(repoWith(undefined, { lock: false }), '/r', port.read)).toStrictEqual({
		unavailable: 'no pnpm-lock.yaml',
	});
	expect(port.calls).toStrictEqual([]);
});

test('readPeers: с pnpm-lock.yaml порт зовётся в корне репозитория', () => {
	const port = fakePeersReader(CLEAN_RUN);
	expect(readPeers(repoWith(), '/r', port.read)).toStrictEqual({ issues: [] });
	expect(port.calls).toStrictEqual(['/r']);
});

test('peersGroup: находки правила по ответу порта, пометок нет', () => {
	const port = fakePeersReader({ status: 1, signal: null, stdout: ONE_BAD, stderr: '' });
	expect(peersGroup(groupContext(repoWith()), port.read)).toStrictEqual({
		findings: [
			{
				code: 'peer-dependency',
				target: 'peer in .',
				message: 'decl@1.0.0 wants ^2.0.0, found 1.0.0; not in .stack-peers-baseline.json',
			},
		],
		notes: [],
	});
});

test('peersGroup: без pnpm-lock.yaml — peers-unavailable', () => {
	const port = fakePeersReader(CLEAN_RUN);
	expect(peersGroup(groupContext(repoWith(undefined, { lock: false })), port.read)).toStrictEqual({
		findings: [NO_LOCK],
		notes: [],
	});
});

test('исход unavailable — одна находка с этой причиной', () => {
	const unavailable = { unavailable: 'pnpm peers check exited with 2: ERR_PNPM_BOOM nope' };
	const expected: Finding[] = [
		{
			code: 'peers-unavailable',
			target: 'pnpm peers check',
			message: 'pnpm peers check exited with 2: ERR_PNPM_BOOM nope',
		},
	];
	expect(checkPeers(repoWith(), unavailable)).toStrictEqual(expected);
	// Сбой pnpm сообщается и при битом baseline: загрузчик даёт свою находку, правило — свою.
	expect(checkPeers(repoWith('{'), unavailable)).toStrictEqual(expected);
});

test('нет baseline — каждая запись даёт peer-dependency', () => {
	expect(checkPeers(repoWith(), { issues: [MISSING, UNMET] })).toStrictEqual([
		{
			code: 'peer-dependency',
			target: 'peer in .',
			message: 'decl@1.0.0 wants ^2.0.0, found 1.0.0; not in .stack-peers-baseline.json',
		},
		{
			code: 'peer-dependency',
			target: 'react in packages/a',
			message:
				'ui-kit@3.1.0 wants ^19.0.0, none installed (optional); not in .stack-peers-baseline.json',
		},
	]);
});

test('запись baseline, которой больше нет, — stale-peer-baseline', () => {
	const baseline: PeerEntry[] = [
		{ importer: '.', peer: 'zod', kind: 'unmet', by: 'abitype', found: '4' },
		{ importer: '.', peer: 'viem', kind: 'conflict' },
		{ importer: 'packages/b', peer: 'react', kind: 'missing', by: 'ui-kit' },
	];
	expect(checkPeers(repoWith(baseline), { issues: [] })).toStrictEqual([
		{
			code: 'stale-peer-baseline',
			target: 'viem in .',
			message: 'recorded conflict is gone; drop it with: stack peers-baseline',
		},
		{
			code: 'stale-peer-baseline',
			target: 'zod in .',
			message: 'recorded unmet by abitype (found 4) is gone; drop it with: stack peers-baseline',
		},
		{
			code: 'stale-peer-baseline',
			target: 'react in packages/b',
			message: 'recorded missing by ui-kit is gone; drop it with: stack peers-baseline',
		},
	]);
});

test('новые и протухшие вместе — сначала все peer-dependency, потом все stale-peer-baseline', () => {
	const stale: PeerEntry = { importer: '.', peer: 'abc', kind: 'conflict' };
	const codes = checkPeers(repoWith([stale]), { issues: [UNMET, MISSING] }).map((f) => [
		f.code,
		f.target,
	]);
	expect(codes).toStrictEqual([
		['peer-dependency', 'peer in .'],
		['peer-dependency', 'react in packages/a'],
		['stale-peer-baseline', 'abc in .'],
	]);
});

test('baseline не разобрался — сравнения нет, находку даёт загрузчик', () => {
	const broken = repoWith('{"version":1,"peers":[{}]}');
	expect(checkPeers(broken, { issues: [UNMET] })).toStrictEqual([]);
	expect(broken.unreadable.map((f) => [f.code, f.target])).toStrictEqual([
		['unreadable-file', '.stack-peers-baseline.json'],
	]);
	// Сбой чтения — тот же случай: файл есть, а записей нет.
	const unread = repoFromSnapshot(
		new Map<string, Read>([
			[LOCKFILE, { text: 'lockfileVersion: x\n' }],
			[PEERS_BASELINE, { failed: new Error('EACCES') }],
		]),
	);
	expect(checkPeers(unread, { issues: [UNMET] })).toStrictEqual([]);
	expect(unread.unreadable).toHaveLength(1);
});

test('всё в baseline — находок нет', () => {
	const repo = repoWith([MISSING.entry, UNMET.entry]);
	expect(checkPeers(repo, { issues: [UNMET, MISSING] })).toStrictEqual([]);
	// Пустой baseline — тоже baseline: без записей нечему протухнуть.
	expect(checkPeers(repoWith([]), { issues: [] })).toStrictEqual([]);
});
