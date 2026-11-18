import { expect, test } from 'bun:test';

import {
	comparePeers,
	lowerPeersBaseline,
	parsePeersBaseline,
	type PeerEntry,
	type PeerIssue,
	peersOutcome,
	type PeersRun,
	serializePeersBaseline,
	versionLine,
} from './peers.ts';

// Запись pnpm в форме замера: parents[-1] — пакет, объявивший peer.
interface Rec {
	parents: { name: string; version: string }[];
	optional: boolean;
	wantedRange: string;
	foundVersion?: string;
	resolvedFrom?: [];
}

interface Importer {
	bad?: Record<string, Rec[]>;
	missing?: Record<string, Rec[]>;
	conflicts?: string[];
}

// Ответ `pnpm peers check --lockfile-only --json`: у каждого importer все четыре поля, как у pnpm.
function pnpmJson(importers: Record<string, Importer>): string {
	const out: Record<string, unknown> = {};
	for (const [name, i] of Object.entries(importers)) {
		out[name] = {
			bad: i.bad ?? {},
			missing: i.missing ?? {},
			conflicts: i.conflicts ?? [],
			intersections: {},
		};
	}
	return JSON.stringify(out, null, 2);
}

function ran(stdout: string, status = 1): PeersRun {
	return { status, signal: null, stdout, stderr: '' };
}

// Текущие проблемы из JSON pnpm — через тот же разбор, что и в бою.
function issuesOf(importers: Record<string, Importer>): PeerIssue[] {
	const outcome = peersOutcome(ran(pnpmJson(importers)));
	if (!('issues' in outcome)) throw new Error(`unexpected outcome: ${JSON.stringify(outcome)}`);
	return outcome.issues;
}

const by = (name: string, version: string): { name: string; version: string } => ({
	name,
	version,
});

test('versionLine: major, 0.minor, 0.0.patch; пре-релиз и build отброшены, не-semver как есть', () => {
	const lines = [
		'7.1.0-beta',
		'19.2.6',
		'0.14.29',
		'0.0.3',
		'3.25.76+sha.1',
		'link:../x',
		'file:../my-pkg',
		'7.1',
		'1.2.3.4',
	].map(versionLine);
	expect(lines).toStrictEqual([
		'7',
		'19',
		'0.14',
		'0.0.3',
		'3',
		'link:../x',
		'file:../my-pkg',
		'7.1',
		'1.2.3.4',
	]);
});

test('peersOutcome: bad, missing и conflicts становятся записями с объявившим пакетом из parents[-1]', () => {
	const json = pnpmJson({
		'.': {
			missing: {
				ethers: [
					{
						parents: [by('@nomiclabs/hardhat-ethers', '2.2.3')],
						optional: false,
						wantedRange: '^5.0.0',
					},
					{ parents: [by('@typechain/hardhat', '9.1.0')], optional: false, wantedRange: '^6.1.0' },
					{
						parents: [by('@typechain/hardhat', '9.1.0'), by('@typechain/ethers-v6', '0.5.1')],
						optional: false,
						wantedRange: '6.x',
					},
				],
			},
			conflicts: ['ethers'],
		},
	});
	expect(peersOutcome(ran(json, 1))).toStrictEqual({
		issues: [
			{
				entry: { importer: '.', peer: 'ethers', kind: 'conflict' },
				detail: 'no version satisfies every range',
			},
			{
				entry: { importer: '.', peer: 'ethers', kind: 'missing', by: '@nomiclabs/hardhat-ethers' },
				detail: '@nomiclabs/hardhat-ethers@2.2.3 wants ^5.0.0, none installed',
			},
			{
				entry: { importer: '.', peer: 'ethers', kind: 'missing', by: '@typechain/ethers-v6' },
				detail: '@typechain/ethers-v6@0.5.1 wants 6.x, none installed',
			},
			{
				entry: { importer: '.', peer: 'ethers', kind: 'missing', by: '@typechain/hardhat' },
				detail: '@typechain/hardhat@9.1.0 wants ^6.1.0, none installed',
			},
		],
	});
});

test('peersOutcome: optional bad из harness — unmet с линией found и суффиксом (optional)', () => {
	const json = pnpmJson({
		'.': {},
		'apps/server': {
			bad: {
				typescript: [
					{
						parents: [by('@nestjs/swagger', '12.0.5')],
						optional: true,
						wantedRange: '^5.5.0 || ^6.0.0',
						foundVersion: '7.1.0-beta',
						resolvedFrom: [],
					},
				],
			},
		},
	});
	expect(peersOutcome(ran(json, 1))).toStrictEqual({
		issues: [
			{
				entry: {
					importer: 'apps/server',
					peer: 'typescript',
					kind: 'unmet',
					by: '@nestjs/swagger',
					found: '7',
				},
				detail: '@nestjs/swagger@12.0.5 wants ^5.5.0 || ^6.0.0, found 7.1.0-beta (optional)',
			},
		],
	});
});

test('peersOutcome: тот же лок с другим порядком записей и другим parents[0] даёт тот же результат', () => {
	const old = (via: string): Rec => ({
		parents: [by(via, '3.0.0'), by('use-sync-external-store', '1.2.0')],
		optional: false,
		wantedRange: '^16.8.0 || ^17.0.0 || ^18.0.0',
		foundVersion: '19.2.6',
	});
	const fresh = (via: string): Rec => ({
		parents: [by(via, '4.0.0'), by('use-sync-external-store', '1.4.0')],
		optional: false,
		wantedRange: '^18.0.0',
		foundVersion: '19.2.6',
	});
	const zod = (via: string): Rec => ({
		parents: [by(via, '5.0.0'), by('abitype', '1.0.8')],
		optional: true,
		wantedRange: '^3.22.0',
		foundVersion: '4.4.3',
	});
	const first = pnpmJson({
		'apps/web': { bad: { react: [old('swr'), fresh('zustand')], zod: [zod('viem')] } },
		'.': { conflicts: ['ethers'] },
	});
	const second = pnpmJson({
		'.': { conflicts: ['ethers'] },
		'apps/web': { bad: { zod: [zod('wagmi')], react: [fresh('jotai'), old('valtio')] } },
	});
	const a = peersOutcome(ran(first));
	expect(a).toStrictEqual({
		issues: [
			{
				entry: { importer: '.', peer: 'ethers', kind: 'conflict' },
				detail: 'no version satisfies every range',
			},
			{
				entry: {
					importer: 'apps/web',
					peer: 'react',
					kind: 'unmet',
					by: 'use-sync-external-store',
					found: '19',
				},
				detail: 'use-sync-external-store@1.2.0 wants ^16.8.0 || ^17.0.0 || ^18.0.0, found 19.2.6',
			},
			{
				entry: { importer: 'apps/web', peer: 'zod', kind: 'unmet', by: 'abitype', found: '4' },
				detail: 'abitype@1.0.8 wants ^3.22.0, found 4.4.3 (optional)',
			},
		],
	});
	expect(peersOutcome(ran(second))).toStrictEqual(a);
});

test('peersOutcome: две исходные записи одного ключа — одна запись, detail наименьший', () => {
	const json = pnpmJson({
		'.': {
			bad: {
				react: [
					{
						parents: [by('use-sync-external-store', '1.4.0')],
						optional: false,
						wantedRange: '^18.0.0',
						foundVersion: '19.2.6',
					},
					{
						parents: [by('use-sync-external-store', '1.2.0')],
						optional: false,
						wantedRange: '^16.8.0 || ^17.0.0 || ^18.0.0',
						foundVersion: '19.2.6',
					},
				],
			},
		},
	});
	expect(peersOutcome(ran(json))).toStrictEqual({
		issues: [
			{
				entry: {
					importer: '.',
					peer: 'react',
					kind: 'unmet',
					by: 'use-sync-external-store',
					found: '19',
				},
				detail: 'use-sync-external-store@1.2.0 wants ^16.8.0 || ^17.0.0 || ^18.0.0, found 19.2.6',
			},
		],
	});
});

test('peersOutcome: код 0 и пустой объект — нет записей', () => {
	expect(peersOutcome(ran('{}', 0))).toStrictEqual({ issues: [] });
});

test('peersOutcome: сбои запуска и не та форма — unavailable, не чисто', () => {
	const shape = 'pnpm peers check output has an unexpected shape: ';
	const rec = {
		parents: [{ name: 'decl', version: '1.0.0' }],
		optional: false,
		wantedRange: '^2.0.0',
		foundVersion: '1.0.0',
	};
	const one = (importer: unknown): string => JSON.stringify({ '.': importer });
	const imp = (patch: Record<string, unknown>): string =>
		one({ bad: {}, missing: {}, conflicts: [], intersections: {}, ...patch });
	const cases: [PeersRun, string][] = [
		[{ error: 'spawn pnpm ENOENT' }, 'pnpm peers check did not start: spawn pnpm ENOENT'],
		[
			{ status: null, signal: 'SIGTERM', stdout: '', stderr: 'x' },
			'pnpm peers check killed by SIGTERM',
		],
		[
			{ status: 2, signal: null, stdout: '{}', stderr: '\n ERR_PNPM_X boom\nmore' },
			'pnpm peers check exited with 2: ERR_PNPM_X boom',
		],
		[
			{ status: 2, signal: null, stdout: '{}', stderr: ' \n\t\n' },
			'pnpm peers check exited with 2',
		],
		[ran('Usage: pnpm …', 1), 'pnpm peers check output is not JSON'],
		[ran('', 0), 'pnpm peers check output is not JSON'],
		[ran('[]', 0), `${shape}top level is not an object`],
		[ran('null', 0), `${shape}top level is not an object`],
		[ran(one([]), 1), `${shape}importer "." is not an object`],
		[ran(JSON.stringify({ '': {} }), 1), `${shape}importer "" has an empty name`],
		[
			ran(one({ missing: {}, conflicts: [], intersections: {} }), 1),
			`${shape}importer ".": "bad" is not an object`,
		],
		[ran(imp({ missing: [] }), 1), `${shape}importer ".": "missing" is not an object`],
		[
			ran(imp({ conflicts: { ethers: 1 } }), 1),
			`${shape}importer ".": "conflicts" is not an array of package names`,
		],
		[
			ran(imp({ conflicts: ['ethers', ''] }), 1),
			`${shape}importer ".": "conflicts" is not an array of package names`,
		],
		[ran(imp({ bad: { peer: rec } }), 1), `${shape}importer ".": bad "peer" is not an array`],
		[ran(imp({ bad: { '': [rec] } }), 1), `${shape}importer ".": bad "" has an empty name`],
		[
			ran(imp({ bad: { peer: [rec, 'x'] } }), 1),
			`${shape}importer ".": bad "peer"[1] is not an object`,
		],
		[
			ran(imp({ bad: { peer: [{ ...rec, foundVersion: undefined }] } }), 1),
			`${shape}importer ".": bad "peer"[0]: "foundVersion" is not a non-empty string`,
		],
		[
			ran(imp({ bad: { peer: [{ ...rec, foundVersion: '' }] } }), 1),
			`${shape}importer ".": bad "peer"[0]: "foundVersion" is not a non-empty string`,
		],
		[
			ran(imp({ missing: { peer: [{ ...rec, parents: [] }] } }), 1),
			`${shape}importer ".": missing "peer"[0]: "parents" is not a non-empty array of {name, version}`,
		],
		[
			ran(imp({ missing: { peer: [{ ...rec, parents: [{ name: 'decl' }] }] } }), 1),
			`${shape}importer ".": missing "peer"[0]: "parents" is not a non-empty array of {name, version}`,
		],
		[
			ran(imp({ missing: { peer: [{ ...rec, parents: [{ name: '', version: '1.0.0' }] }] } }), 1),
			`${shape}importer ".": missing "peer"[0]: "parents" is not a non-empty array of {name, version}`,
		],
		// Битый не последний элемент parents: проверяется каждый, а не только объявивший пакет.
		[
			ran(
				imp({
					missing: {
						peer: [
							{
								...rec,
								parents: [
									{ name: '', version: '1.0.0' },
									{ name: 'decl', version: '1.0.0' },
								],
							},
						],
					},
				}),
				1,
			),
			`${shape}importer ".": missing "peer"[0]: "parents" is not a non-empty array of {name, version}`,
		],
		[
			ran(imp({ missing: { peer: [{ ...rec, optional: 'no' }] } }), 1),
			`${shape}importer ".": missing "peer"[0]: "optional" is not a boolean`,
		],
		[
			ran(imp({ missing: { peer: [{ ...rec, wantedRange: 2 }] } }), 1),
			`${shape}importer ".": missing "peer"[0]: "wantedRange" is not a string`,
		],
	];
	expect(cases.map(([run]) => peersOutcome(run))).toStrictEqual(
		cases.map(([, unavailable]) => ({ unavailable })),
	);
});

const unmetZod4: PeerEntry = {
	importer: '.',
	peer: 'zod',
	kind: 'unmet',
	by: 'abitype',
	found: '4',
};
const unmetViem: PeerEntry = {
	importer: 'apps/web',
	peer: '@turnkey/viem',
	kind: 'unmet',
	by: '@liqpro/liq-turnkey',
	found: '0.14',
};
const missingEthers: PeerEntry = {
	importer: '.',
	peer: 'ethers',
	kind: 'missing',
	by: '@typechain/hardhat',
};
const conflictEthers: PeerEntry = { importer: '.', peer: 'ethers', kind: 'conflict' };

test('baseline: serialize и parse — круг, отсортировано, таб по умолчанию, два пробела от previous', () => {
	const xs: PeerEntry[] = [unmetViem, unmetZod4, missingEthers, conflictEthers];
	const sorted = [conflictEthers, missingEthers, unmetZod4, unmetViem];
	const text = serializePeersBaseline(xs);
	expect(parsePeersBaseline(text)).toStrictEqual({ entries: sorted });
	expect(text).toBe(
		[
			'{',
			'\t"version": 1,',
			'\t"peers": [',
			'\t\t{',
			'\t\t\t"importer": ".",',
			'\t\t\t"peer": "ethers",',
			'\t\t\t"kind": "conflict"',
			'\t\t},',
			'\t\t{',
			'\t\t\t"importer": ".",',
			'\t\t\t"peer": "ethers",',
			'\t\t\t"kind": "missing",',
			'\t\t\t"by": "@typechain/hardhat"',
			'\t\t},',
			'\t\t{',
			'\t\t\t"importer": ".",',
			'\t\t\t"peer": "zod",',
			'\t\t\t"kind": "unmet",',
			'\t\t\t"by": "abitype",',
			'\t\t\t"found": "4"',
			'\t\t},',
			'\t\t{',
			'\t\t\t"importer": "apps/web",',
			'\t\t\t"peer": "@turnkey/viem",',
			'\t\t\t"kind": "unmet",',
			'\t\t\t"by": "@liqpro/liq-turnkey",',
			'\t\t\t"found": "0.14"',
			'\t\t}',
			'\t]',
			'}',
			'',
		].join('\n'),
	);
	// Поля пишутся в порядке ключа, в каком бы порядке их ни собрал вызывающий.
	const shuffled: PeerEntry = {
		found: '4',
		by: 'abitype',
		kind: 'unmet',
		peer: 'zod',
		importer: '.',
	};
	expect(serializePeersBaseline([shuffled], '{\n  "version": 1,\n  "peers": []\n}\n')).toBe(
		'{\n  "version": 1,\n  "peers": [\n    {\n      "importer": ".",\n      "peer": "zod",\n      "kind": "unmet",\n      "by": "abitype",\n      "found": "4"\n    }\n  ]\n}\n',
	);
	expect(serializePeersBaseline([], '{\n\t"version": 1,\n\t"peers": []\n}\n')).toBe(
		'{\n\t"version": 1,\n\t"peers": []\n}\n',
	);
});

test('baseline: битый файл — problem, по случаю на текст', () => {
	const file = (peers: unknown[]): string => JSON.stringify({ version: 1, peers });
	const cases: [string, string][] = [
		['{"version":2,"peers":[]}', 'version must be 1'],
		['{"peers":[]}', 'version must be 1'],
		['[]', 'version must be 1'],
		['null', 'version must be 1'],
		['{"version":1}', '"peers" must be an array'],
		['{"version":1,"peers":{}}', '"peers" must be an array'],
		['{"version":1,"peers":[],"x":1}', 'unknown field «x»'],
		[file([{ ...conflictEthers, found: '6' }]), 'peers[0] is not a valid entry'],
		[
			file([{ importer: '.', peer: 'zod', kind: 'unmet', by: 'abitype' }]),
			'peers[0] is not a valid entry',
		],
		[file([{ ...unmetZod4, importer: '' }]), 'peers[0] is not a valid entry'],
		[file([{ ...unmetZod4, peer: '' }]), 'peers[0] is not a valid entry'],
		[file([{ ...unmetZod4, found: '' }]), 'peers[0] is not a valid entry'],
		[file([{ ...unmetZod4, found: 4 }]), 'peers[0] is not a valid entry'],
		[file([{ ...unmetZod4, extra: 'x' }]), 'peers[0] is not a valid entry'],
		[file([unmetZod4, { ...missingEthers, by: 7 }]), 'peers[1] is not a valid entry'],
		[file([unmetZod4, { ...missingEthers, extra: 'x' }]), 'peers[1] is not a valid entry'],
		[file([{ importer: '.', peer: 'zod', kind: 'constructor' }]), 'peers[0] is not a valid entry'],
		[file(['zod']), 'peers[0] is not a valid entry'],
		[file([unmetZod4, { ...unmetZod4 }]), 'peers[1] repeats an earlier entry'],
	];
	expect(cases.map(([text]) => parsePeersBaseline(text))).toStrictEqual(
		cases.map(([, problem]) => ({ problem })),
	);
	const broken = parsePeersBaseline('{');
	expect('problem' in broken && broken.problem).toStartWith('not JSON: ');
});

test('comparePeers: новое — added, исчезнувшее — stale, patch внутри линии — ни то ни другое', () => {
	const baseline: PeerEntry[] = [unmetZod4, unmetViem];
	const zodAt = (foundVersion: string): Importer => ({
		bad: {
			zod: [
				{ parents: [by('abitype', '1.0.8')], optional: true, wantedRange: '^3.22.0', foundVersion },
			],
		},
	});
	const current = issuesOf({
		'.': zodAt('4.4.3'),
		'apps/web': {
			bad: {
				'@turnkey/sdk-browser': [
					{
						parents: [by('@liqpro/liq-turnkey', '2.1.0')],
						optional: false,
						wantedRange: '^8.2.1',
						foundVersion: '6.0.0',
					},
				],
			},
		},
	});
	expect(comparePeers(current, baseline)).toStrictEqual({
		added: [
			{
				entry: {
					importer: 'apps/web',
					peer: '@turnkey/sdk-browser',
					kind: 'unmet',
					by: '@liqpro/liq-turnkey',
					found: '6',
				},
				detail: '@liqpro/liq-turnkey@2.1.0 wants ^8.2.1, found 6.0.0',
			},
		],
		stale: [unmetViem],
	});

	const back = issuesOf({ '.': zodAt('3.25.76') });
	expect(comparePeers(back, [unmetZod4])).toStrictEqual({
		added: [
			{
				entry: { ...unmetZod4, found: '3' },
				detail: 'abitype@1.0.8 wants ^3.22.0, found 3.25.76 (optional)',
			},
		],
		stale: [unmetZod4],
	});
});

test('comparePeers: версия объявившего пакета, пре-релиз и patch — тихо, 0.14 → 0.15 — новая линия', () => {
	const typescript: PeerEntry = {
		importer: '.',
		peer: 'typescript',
		kind: 'unmet',
		by: '@solana/codecs',
		found: '7',
	};
	const lock = (viem: string): Record<string, Importer> => ({
		'.': {
			bad: {
				typescript: [
					{
						parents: [by('@solana/codecs', '5.5.2')],
						optional: true,
						wantedRange: '>=5.3.3',
						foundVersion: '7.1.0',
					},
				],
			},
		},
		'apps/web': {
			bad: {
				'@turnkey/viem': [
					{
						parents: [by('@liqpro/liq-turnkey', '2.1.0')],
						optional: false,
						wantedRange: '^0.14.37',
						foundVersion: viem,
					},
				],
			},
		},
	});
	expect(comparePeers(issuesOf(lock('0.14.50')), [unmetViem, typescript])).toStrictEqual({
		added: [],
		stale: [],
	});
	const moved = comparePeers(issuesOf(lock('0.15.0')), [unmetViem, typescript]);
	expect(moved.added.map((i) => i.entry)).toStrictEqual([{ ...unmetViem, found: '0.15' }]);
	expect(moved.stale).toStrictEqual([unmetViem]);
});

test('comparePeers: added и stale отсортированы по ключу', () => {
	const issue = (entry: PeerEntry): PeerIssue => ({ entry, detail: `d ${entry.peer}` });
	expect(
		comparePeers([issue(unmetViem), issue(unmetZod4), issue(conflictEthers)], [missingEthers]),
	).toStrictEqual({
		added: [issue(conflictEthers), issue(unmetZod4), issue(unmetViem)],
		stale: [missingEthers],
	});
	expect(comparePeers([], [unmetViem, missingEthers, conflictEthers])).toStrictEqual({
		added: [],
		stale: [conflictEthers, missingEthers, unmetViem],
	});
});

test('lowerPeersBaseline: остаётся только то, что ещё есть; новое не добавляется', () => {
	const issue = (entry: PeerEntry): PeerIssue => ({ entry, detail: 'd' });
	expect(
		lowerPeersBaseline([unmetZod4, missingEthers], [issue(missingEthers), issue(unmetViem)]),
	).toStrictEqual([missingEthers]);
	expect(
		lowerPeersBaseline(
			[unmetViem, unmetZod4, missingEthers],
			[issue(unmetZod4), issue(conflictEthers), issue(unmetViem)],
		),
	).toStrictEqual([unmetZod4, unmetViem]);
});
