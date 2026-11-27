import { expect, test } from 'bun:test';

import { loadCanon } from './canon.ts';
import { check, plan } from './check.ts';
import { OWNER_SOURCE, testCanon, testRepo } from './testkit.ts';
import { pinCopies, pinSiteKind } from './toolchain-pins.ts';
import { planToolchainPins } from './toolchain-pins-rule.ts';

const PINS = { node: '26.13.1', pnpm: '12.21.0', bun: '1.4.4', proto: '0.64.0' };
const canon = testCanon({ pins: PINS });
const DOCKERFILE =
	'FROM node:26.11.1-alpine AS base\nRUN npm install -g pnpm@11.28.5\nFROM oven/bun:1.4-alpine\n';
const SYNCED =
	'FROM node:26.13.1-alpine AS base\nRUN npm install -g pnpm@12.21.0\nFROM oven/bun:1.4-alpine\n';
const WORKFLOW =
	"jobs:\n  a:\n    steps:\n      - uses: moonrepo/setup-toolchain@v0\n        with:\n          proto-version: '0.60.2'\n";
const HOLD = [{ file: '.prototools', reason: 'own toolchain' }];
const codes = <F extends { code: string }>(found: F[], code: string) =>
	found.filter((f) => f.code === code);

test('Dockerfile с двумя разошедшимися копиями — одна находка и одна правка всего файла', () => {
	const repo = testRepo(canon, { 'apps/api/Dockerfile': DOCKERFILE });
	expect(planToolchainPins(repo, canon, [])).toStrictEqual([
		{
			code: 'toolchain-pin',
			target: 'apps/api/Dockerfile',
			file: 'apps/api/Dockerfile',
			message:
				'node 26.11.1 instead of 26.13.1 (line 1), pnpm 11.28.5 instead of 12.21.0 (line 2): pin copies follow .prototools',
			fix: 'apps/api/Dockerfile: node 26.11.1 → 26.13.1, pnpm 11.28.5 → 12.21.0',
			change: { kind: 'write', file: 'apps/api/Dockerfile', content: SYNCED },
		},
	]);
	expect(plan(repo, canon).map((d) => d.code)).toStrictEqual(['toolchain-pin']);
});

test('чистые файлы и репозиторий без копий — находок нет', () => {
	expect(planToolchainPins(testRepo(canon, { Dockerfile: SYNCED }), canon, [])).toStrictEqual([]);
	expect(planToolchainPins(testRepo(canon), canon, [])).toStrictEqual([]);
});

test('находки идут по пути файла; повторы в fix схлопнуты, в message — каждая копия', () => {
	const repo = testRepo(canon, {
		'b/Dockerfile': 'FROM node:24-slim AS a\nFROM node:24-slim AS b\n',
		'.github/workflows/ci.yml': WORKFLOW,
		'a/Dockerfile': SYNCED,
	});
	const found = planToolchainPins(repo, canon, []);
	expect(found.map((d) => d.target)).toStrictEqual(['.github/workflows/ci.yml', 'b/Dockerfile']);
	expect(found[0]?.fix).toBe('.github/workflows/ci.yml: proto 0.60.2 → 0.64.0');
	expect(found[1]?.message).toBe(
		'node 24 instead of 26 (line 1), node 24 instead of 26 (line 2): pin copies follow .prototools',
	);
	expect(found[1]?.fix).toBe('b/Dockerfile: node 24 → 26');
});

test('отставший .prototools без исключения: копии сверяются с пинами канона', () => {
	const repo = testRepo(canon, {
		'.prototools': 'node = "26.11.1"\npnpm = "11.28.5"\n',
		Dockerfile: DOCKERFILE,
	});
	expect(planToolchainPins(repo, canon, []).map((d) => d.change)).toStrictEqual([
		{ kind: 'write', file: 'Dockerfile', content: SYNCED },
	]);
});

test('удержанный .prototools: сверка с пинами собственного файла, инструмент без пина не сверяется', () => {
	const own = 'node = "24.11.0"\npnpm = "12.21.0"\n\n[plugins]\nx = "file://./x.toml"\n';
	const repo = testRepo(canon, {
		'.prototools': own,
		Dockerfile: 'FROM node:26-slim\nFROM oven/bun:1.3-slim\n',
	});
	expect(planToolchainPins(repo, canon, HOLD).map((d) => d.fix)).toStrictEqual([
		'Dockerfile: node 26 → 24',
	]);
	expect(planToolchainPins(repo, canon, []).map((d) => d.fix)).toStrictEqual([
		'Dockerfile: bun 1.3 → 1.4',
	]);
});

test.each([
	['файла нет', null],
	['файл не разбирается', 'node = = "24"\n'],
])('удержанный .prototools, %s: пинов нет — находок нет', (_name, own) => {
	const repo = testRepo(canon, { '.prototools': own, Dockerfile: 'FROM node:24-slim\n' });
	expect(planToolchainPins(repo, canon, HOLD)).toStrictEqual([]);
});

test('файл, которым владеет канон, правило не смотрит', () => {
	const dest = '.github/workflows/stack-check.yml';
	const owned = testCanon({ pins: PINS, files: [{ dest, content: 'jobs: {}\n' }] });
	const repo = testRepo(owned, { [dest]: WORKFLOW });
	expect(planToolchainPins(repo, owned, [])).toStrictEqual([]);
	expect(plan(repo, owned).map((d) => d.code)).toStrictEqual(['file-drift']);
});

test('check: исключение на файл удерживает находку; на чистом файле оно — stale-exception', () => {
	const hold = [{ file: 'Dockerfile', reason: 'image is built elsewhere' }];
	const held = check(testRepo(canon, { Dockerfile: DOCKERFILE }), canon, hold);
	expect(codes(held, 'toolchain-pin').map((f) => f.suppressedBy?.reason)).toStrictEqual([
		'image is built elsewhere',
	]);
	expect(codes(held, 'stale-exception')).toStrictEqual([]);
	const clean = check(testRepo(canon, { Dockerfile: SYNCED }), canon, hold);
	expect(codes(clean, 'toolchain-pin')).toStrictEqual([]);
	expect(codes(clean, 'stale-exception').map((f) => f.target)).toStrictEqual(['Dockerfile']);
});

test('check передаёт исключения в план: при удержанном .prototools сверка идёт с собственными пинами', () => {
	const repo = testRepo(canon, {
		'.prototools': 'node = "24.11.0"\npnpm = "12.21.0"\n',
		Dockerfile: 'FROM node:24-slim\n',
	});
	expect(codes(check(repo, canon, HOLD), 'toolchain-pin')).toStrictEqual([]);
	expect(codes(check(repo, canon, []), 'toolchain-pin')).toHaveLength(1);
});

// Канон-файлы workflow ни в одну группу не входят, поэтому with пуст.
test('в канон-файлах копий пинов нет — правило вправе их не смотреть', () => {
	let seen = 0;
	for (const profile of OWNER_SOURCE.settings.profiles) {
		for (const f of loadCanon({ profile, with: [], exceptions: [] }).files) {
			const kind = pinSiteKind(f.dest);
			if (kind === undefined) continue;
			seen += 1;
			expect(pinCopies(kind, f.content)).toStrictEqual([]);
		}
	}
	expect(seen).toBeGreaterThan(0);
});
