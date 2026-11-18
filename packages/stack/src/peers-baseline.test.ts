import { existsSync, readFileSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

import type { PeerEntry, PeersReader, PeersRun } from './peers.ts';
import { peersBaseline, type PeersBaselineResult } from './peers-baseline.ts';
import { repoDir, testCanon } from './testkit.ts';

const CANON = testCanon({ rules: ['peers'] });
const FILE = '.stack-peers-baseline.json';

// Записи плана: A — unmet zod от abitype (found 4.4.3 → линия 4), B — missing ethers от
// @typechain/hardhat, C — conflict react. Литералы, а не вывод кода под тестом.
const A: PeerEntry = { importer: '.', peer: 'zod', kind: 'unmet', by: 'abitype', found: '4' };
const B: PeerEntry = { importer: '.', peer: 'ethers', kind: 'missing', by: '@typechain/hardhat' };
const C: PeerEntry = { importer: '.', peer: 'react', kind: 'conflict' };

const REC_A = {
	parents: [{ name: 'abitype', version: '1.0.8' }],
	optional: true,
	wantedRange: '^3 >=3.22.0',
	foundVersion: '4.4.3',
	resolvedFrom: [],
};
const REC_B = {
	parents: [{ name: '@typechain/hardhat', version: '9.1.0' }],
	optional: false,
	wantedRange: '^6.1.0',
};

// Ответ pnpm с заданными записями: bad zod (A), missing ethers (B), conflicts react (C).
function pnpmRun(...entries: PeerEntry[]): PeersRun {
	const has = (e: PeerEntry): boolean => entries.includes(e);
	const json = {
		'.': {
			bad: has(A) ? { zod: [REC_A] } : {},
			missing: has(B) ? { ethers: [REC_B] } : {},
			conflicts: has(C) ? ['react'] : [],
			intersections: {},
		},
	};
	return { status: entries.length ? 1 : 0, signal: null, stdout: JSON.stringify(json), stderr: '' };
}

// Фальшивый порт: считает вызовы и отдаёт заданный результат.
function port(run: PeersRun): { read: PeersReader; calls: () => number } {
	let n = 0;
	return {
		read: () => {
			n += 1;
			return run;
		},
		calls: () => n,
	};
}

// Текст baseline, построенный независимо от serializePeersBaseline.
const baselineText = (entries: PeerEntry[], indent: string = '\t'): string =>
	`${JSON.stringify({ version: 1, peers: entries }, null, indent)}\n`;

// Репо с локом (если не сказано иное) и baseline (если задан).
function repo(baseline?: string, { lock = true }: { lock?: boolean } = {}): string {
	const files: Record<string, string> = { 'package.json': '{}' };
	if (lock) files['pnpm-lock.yaml'] = 'lockfileVersion: x\n';
	if (baseline !== undefined) files[FILE] = baseline;
	return repoDir(files);
}

const read = (dir: string): string => readFileSync(join(dir, FILE), 'utf8');

// Время изменения в прошлом: файл, который команда не пишет, его сохраняет.
const PAST = 1_000_000_000;
function backdate(dir: string): void {
	utimesSync(join(dir, FILE), PAST, PAST);
}
const untouched = (dir: string): boolean => statSync(join(dir, FILE)).mtimeMs === PAST * 1000;

test('init: пишет все текущие записи, отсортированные, табом; второй init — код 2, файл тот же', () => {
	const dir = repo();
	const p = port(pnpmRun(A, B));
	expect(peersBaseline(dir, CANON, 'init', p.read)).toStrictEqual({
		code: 0,
		out: ['wrote .stack-peers-baseline.json: 2 entr(ies)'],
		err: [],
	});
	expect(read(dir)).toBe(
		'{\n\t"version": 1,\n\t"peers": [\n' +
			'\t\t{\n\t\t\t"importer": ".",\n\t\t\t"peer": "ethers",\n\t\t\t"kind": "missing",\n\t\t\t"by": "@typechain/hardhat"\n\t\t},\n' +
			'\t\t{\n\t\t\t"importer": ".",\n\t\t\t"peer": "zod",\n\t\t\t"kind": "unmet",\n\t\t\t"by": "abitype",\n\t\t\t"found": "4"\n\t\t}\n' +
			'\t]\n}\n',
	);
	backdate(dir);
	const before = read(dir);
	expect(peersBaseline(dir, CANON, 'init', p.read)).toStrictEqual({
		code: 2,
		out: [],
		err: ['.stack-peers-baseline.json already exists'],
	});
	expect(read(dir)).toBe(before);
	expect(untouched(dir)).toBe(true);
	expect(p.calls()).toBe(1);
});

test('lower: исправленная запись уходит, файл переписан, вывод с -1 fixed', () => {
	const dir = repo(baselineText([A, B]));
	expect(peersBaseline(dir, CANON, 'lower', port(pnpmRun(B)).read)).toStrictEqual({
		code: 0,
		out: ['wrote .stack-peers-baseline.json: 1 entr(ies) (-1 fixed, +0 new)'],
		err: [],
	});
	expect(read(dir)).toBe(baselineText([B]));
});

test('lower: новая запись — код 1, строки new: и подсказка --allow-grow, файл не тронут', () => {
	const dir = repo(baselineText([A]));
	backdate(dir);
	expect(peersBaseline(dir, CANON, 'lower', port(pnpmRun(A, B)).read)).toStrictEqual({
		code: 1,
		out: [],
		err: [
			'new: ethers in . — @typechain/hardhat@9.1.0 wants ^6.1.0, none installed',
			'1 new entr(ies) — fix them or pass --allow-grow',
		],
	});
	expect(read(dir)).toBe(baselineText([A]));
	expect(untouched(dir)).toBe(true);
});

test('grow: новая запись принята, вывод +1 new', () => {
	const dir = repo(baselineText([A]));
	expect(peersBaseline(dir, CANON, 'grow', port(pnpmRun(A, B)).read)).toStrictEqual({
		code: 0,
		out: ['wrote .stack-peers-baseline.json: 2 entr(ies) (-0 fixed, +1 new)'],
		err: [],
	});
	expect(read(dir)).toBe(baselineText([B, A]));
});

test('grow: исправленная запись тоже уходит — в файле ровно текущие', () => {
	const dir = repo(baselineText([A, B]));
	expect(peersBaseline(dir, CANON, 'grow', port(pnpmRun(B, C)).read)).toStrictEqual({
		code: 0,
		out: ['wrote .stack-peers-baseline.json: 2 entr(ies) (-1 fixed, +1 new)'],
		err: [],
	});
	expect(read(dir)).toBe(baselineText([B, C]));
});

test('drop-fixed: убирает исправленное, новое не добавляет и не мешает; нечего убирать — файл не тронут, вывода нет', () => {
	const dir = repo(baselineText([A, B]));
	const p = port(pnpmRun(B, C));
	expect(peersBaseline(dir, CANON, 'drop-fixed', p.read)).toStrictEqual({
		code: 0,
		out: ['dropped 1 fixed entr(ies) from .stack-peers-baseline.json'],
		err: [],
	});
	expect(read(dir)).toBe(baselineText([B]));
	backdate(dir);
	expect(peersBaseline(dir, CANON, 'drop-fixed', p.read)).toStrictEqual({
		code: 0,
		out: [],
		err: [],
	});
	expect(read(dir)).toBe(baselineText([B]));
	expect(untouched(dir)).toBe(true);
});

test('drop-fixed: нет файла или группа выключена — код 0, порт не зовётся', () => {
	const quiet: PeersBaselineResult = { code: 0, out: [], err: [] };
	const noFile = repo();
	const p = port(pnpmRun(A));
	expect(peersBaseline(noFile, CANON, 'drop-fixed', p.read)).toStrictEqual(quiet);
	expect(existsSync(join(noFile, FILE))).toBe(false);
	const groupOff = repo(baselineText([A, B]));
	backdate(groupOff);
	expect(peersBaseline(groupOff, testCanon(), 'drop-fixed', p.read)).toStrictEqual(quiet);
	expect(untouched(groupOff)).toBe(true);
	expect(p.calls()).toBe(0);
});

test('группа выключена — init, lower и grow: код 2, сообщение называет with, порт не зовётся', () => {
	const p = port(pnpmRun(A));
	for (const mode of ['init', 'lower', 'grow'] as const) {
		expect(peersBaseline(repo(), testCanon(), mode, p.read)).toStrictEqual({
			code: 2,
			out: [],
			err: ['peers-baseline needs "peers" in "with" of .stack.jsonc'],
		});
	}
	expect(p.calls()).toBe(0);
});

test('lower и grow без файла — код 2 с подсказкой --init, файл не создан, порт не зовётся', () => {
	const p = port(pnpmRun(A));
	for (const mode of ['lower', 'grow'] as const) {
		const dir = repo();
		expect(peersBaseline(dir, CANON, mode, p.read)).toStrictEqual({
			code: 2,
			out: [],
			err: ['no .stack-peers-baseline.json: run stack peers-baseline --init'],
		});
		expect(existsSync(join(dir, FILE))).toBe(false);
	}
	expect(p.calls()).toBe(0);
});

test('битый baseline — код 2 с причиной разбора, файл не тронут, порт не зовётся', () => {
	const p = port(pnpmRun(A));
	for (const mode of ['init', 'lower', 'grow', 'drop-fixed'] as const) {
		const dir = repo('{"version":2,"peers":[]}\n');
		backdate(dir);
		expect(peersBaseline(dir, CANON, mode, p.read)).toStrictEqual({
			code: 2,
			out: [],
			err: ['.stack-peers-baseline.json does not parse: version must be 1'],
		});
		expect(read(dir)).toBe('{"version":2,"peers":[]}\n');
		expect(untouched(dir)).toBe(true);
	}
	expect(p.calls()).toBe(0);
});

test('нет pnpm-lock.yaml — код 1 no pnpm-lock.yaml, порт не зовётся', () => {
	const p = port(pnpmRun(A));
	const dir = repo(undefined, { lock: false });
	expect(peersBaseline(dir, CANON, 'init', p.read)).toStrictEqual({
		code: 1,
		out: [],
		err: ['no pnpm-lock.yaml'],
	});
	expect(existsSync(join(dir, FILE))).toBe(false);
	expect(p.calls()).toBe(0);
});

test('pnpm недоступен — код 1 с причиной, файл не тронут', () => {
	const dir = repo(baselineText([A]));
	backdate(dir);
	const p = port({ error: 'spawn pnpm ENOENT' });
	expect(peersBaseline(dir, CANON, 'lower', p.read)).toStrictEqual({
		code: 1,
		out: [],
		err: ['pnpm peers check did not start: spawn pnpm ENOENT'],
	});
	expect(read(dir)).toBe(baselineText([A]));
	expect(untouched(dir)).toBe(true);
	expect(p.calls()).toBe(1);
});

test('файл с отступом в два пробела — после lower остаётся два пробела', () => {
	const dir = repo(baselineText([A, B], '  '));
	expect(peersBaseline(dir, CANON, 'lower', port(pnpmRun(B)).read).code).toBe(0);
	expect(read(dir)).toBe(baselineText([B], '  '));
});
