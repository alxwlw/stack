import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

import { loadCanon } from './canon.ts';
import { syncRepo } from './check.ts';
import { readSnapshot } from './repo.ts';
import { BARE, repoDir, runCli as run, testCanon } from './testkit.ts';

const PINS = { node: '26.13.1', pnpm: '12.21.0', bun: '1.4.4', proto: '0.64.0' };
const canon = testCanon({ pins: PINS });
const DOCKERFILE =
	'FROM node:26.11.1-alpine AS base\nRUN npm install -g pnpm@11.28.5\nFROM oven/bun:1.4-alpine\n';
const SYNCED =
	'FROM node:26.13.1-alpine AS base\nRUN npm install -g pnpm@12.21.0\nFROM oven/bun:1.4-alpine\n';
const WORKFLOW =
	"jobs:\n  a:\n    steps:\n      - uses: moonrepo/setup-toolchain@v0\n        with:\n          proto-version: '0.60.2'\n";
const HOLD = { file: '.prototools', reason: 'own toolchain' };
const crlf = (text: string) => text.replaceAll('\n', '\r\n');
const read = (dir: string, path: string) => readFileSync(join(dir, path), 'utf8');
const NODE_PINS = loadCanon({ profile: 'node', with: [], exceptions: [] }).pins;

test('снимок читает Dockerfile и workflow по шаблонам и не читает остальное', () => {
	const yes = [
		'Dockerfile',
		'apps/api/Dockerfile',
		'apps/api/Dockerfile.dev',
		'scripts/ui.Dockerfile',
		'.github/workflows/ci.yml',
		'.github/workflows/b.yaml',
		'.github/actions/setup/action.yml',
	];
	const no = [
		'apps/api/Dockerfile.dockerignore',
		'apps/api/dockerfile',
		'node_modules/x/Dockerfile',
		'dist/Dockerfile',
		'apps/api/build/Dockerfile',
		'.worktrees/w/Dockerfile',
		'.devcontainer/Dockerfile',
		'.github/workflows/notes.txt',
		'.github/workflows/sub/x.yml',
	];
	const dir = repoDir(Object.fromEntries([...yes, ...no].map((p) => [p, 'x\n'])));
	const snapshot = readSnapshot(dir, testCanon());
	const read = [...snapshot].filter(([, r]) => 'text' in r).map(([p]) => p);
	expect(read.sort()).toStrictEqual([...yes].sort());
});

test('sync на диске с CRLF: правятся только цифры, второй sync пуст', () => {
	const dir = repoDir({
		'apps/api/Dockerfile': crlf(DOCKERFILE),
		'.github/workflows/ci.yml': crlf(WORKFLOW),
	});
	const first = syncRepo(dir, canon, []);
	expect(first.applied.map((d) => d.target)).toStrictEqual([
		'.github/workflows/ci.yml',
		'apps/api/Dockerfile',
	]);
	expect(read(dir, 'apps/api/Dockerfile')).toBe(crlf(SYNCED));
	expect(read(dir, '.github/workflows/ci.yml')).toBe(crlf(WORKFLOW.replace('0.60.2', '0.64.0')));
	expect(syncRepo(dir, canon, []).applied).toStrictEqual([]);
});

const PROTOTOOLS = 'node = "26.13.1"\npnpm = "12.21.0"\n';
const withPrototools = testCanon({
	pins: PINS,
	files: [{ dest: '.prototools', content: PROTOTOOLS }],
});

test('отставший .prototools: один sync двигает и его, и Dockerfile, второй пуст', () => {
	const dir = repoDir({
		'.prototools': 'node = "26.11.1"\npnpm = "11.28.5"\n',
		Dockerfile: DOCKERFILE,
	});
	const first = syncRepo(dir, withPrototools, []);
	expect(first.applied.map((d) => d.code)).toStrictEqual(['file-drift', 'toolchain-pin']);
	expect(read(dir, '.prototools')).toBe(PROTOTOOLS);
	expect(read(dir, 'Dockerfile')).toBe(SYNCED);
	expect(syncRepo(dir, withPrototools, []).applied).toStrictEqual([]);
});

test('удержанный .prototools: Dockerfile идёт за собственными пинами файла', () => {
	const own = 'node = "24.11.0"\npnpm = "12.21.0"\n';
	const dir = repoDir({ '.prototools': own, Dockerfile: 'FROM node:26-slim\n' });
	const { applied, held } = syncRepo(dir, withPrototools, [HOLD]);
	expect(read(dir, 'Dockerfile')).toBe('FROM node:24-slim\n');
	expect(read(dir, '.prototools')).toBe(own);
	expect(applied.map((d) => d.code)).toStrictEqual(['toolchain-pin']);
	expect(held.map((d) => d.code)).toStrictEqual(['file-drift']);
});

test('исключение на файл: Dockerfile не тронут, находка удержана', () => {
	const dir = repoDir({ 'apps/api/Dockerfile': DOCKERFILE });
	const { applied, held } = syncRepo(dir, canon, [
		{ file: 'apps/api/Dockerfile', reason: 'image is built elsewhere' },
	]);
	expect(read(dir, 'apps/api/Dockerfile')).toBe(DOCKERFILE);
	expect(applied).toStrictEqual([]);
	expect(held.map((d) => d.code)).toStrictEqual(['toolchain-pin']);
});

test('файл канона с ключом версии: после sync текст канона, находки нет', () => {
	const dest = '.github/workflows/stack-check.yml';
	const owned = testCanon({ pins: PINS, files: [{ dest, content: 'jobs: {}\n' }] });
	const dir = repoDir({ [dest]: WORKFLOW });
	const first = syncRepo(dir, owned, []);
	expect(first.applied.map((d) => d.code)).toStrictEqual(['file-drift']);
	expect(read(dir, dest)).toBe('jobs: {}\n');
	expect(syncRepo(dir, owned, []).applied).toStrictEqual([]);
});

const bunMinor = NODE_PINS.bun?.split('.').slice(0, 2).join('.') ?? '';
const CLI_DOCKERFILE = `FROM node:1.0.0-slim AS deps\nRUN npm i -g pnpm@1.0.0\nFROM oven/bun:${bunMinor}-alpine\n`;
const CLI_SYNCED = `FROM node:${NODE_PINS.node}-slim AS deps\nRUN npm i -g pnpm@${NODE_PINS.pnpm}\nFROM oven/bun:${bunMinor}-alpine\n`;
const pinLines = (err: string) => err.split('\n').filter((l) => l.startsWith('toolchain-pin: '));

async function synced() {
	const dir = repoDir(BARE);
	await run(['init', '--profile', 'node'], dir);
	await run(['sync'], dir);
	return dir;
}

test('CLI: check находит копии, sync переписывает, повторный check и sync чисты', async () => {
	expect(bunMinor).toMatch(/^\d+\.\d+$/);
	const dir = await synced();
	const path = join(dir, 'apps/api/Dockerfile');
	await Bun.write(path, CLI_DOCKERFILE);
	const checked = await run(['check'], dir);
	expect(checked.code).toBe(1);
	expect(pinLines(checked.err)).toStrictEqual([
		`toolchain-pin: apps/api/Dockerfile — node 1.0.0 instead of ${NODE_PINS.node} (line 1), pnpm 1.0.0 instead of ${NODE_PINS.pnpm} (line 2): pin copies follow .prototools`,
	]);
	const fixed = await run(['sync'], dir);
	expect(fixed.out).toContain(
		`apps/api/Dockerfile: node 1.0.0 → ${NODE_PINS.node}, pnpm 1.0.0 → ${NODE_PINS.pnpm}`,
	);
	expect(read(dir, 'apps/api/Dockerfile')).toBe(CLI_SYNCED);
	expect((await run(['check'], dir)).code).toBe(0);
	expect((await run(['sync'], dir)).out).toContain('canon already up to date');
});

test('CLI: исключение на файл — check чист и сообщает allowed, sync файл не трогает', async () => {
	const dir = await synced();
	const config = read(dir, '.stack.jsonc');
	const hold = '{ "file": "apps/api/Dockerfile", "reason": "image is built elsewhere" }';
	expect(config).toContain('"exceptions"');
	await Bun.write(
		join(dir, '.stack.jsonc'),
		config.replace(/"exceptions"\s*:\s*\[/, (m) => `${m}${hold},`),
	);
	await Bun.write(join(dir, 'apps/api/Dockerfile'), CLI_DOCKERFILE);
	const checked = await run(['check'], dir);
	expect(checked.code).toBe(0);
	expect(
		checked.err
			.split('\n')
			.filter((l) => l.startsWith('allowed (image is built elsewhere): apps/api/Dockerfile — ')),
	).toHaveLength(1);
	await run(['sync'], dir);
	expect(read(dir, 'apps/api/Dockerfile')).toBe(CLI_DOCKERFILE);
});

test('CLI: workflow с proto-version — check находит, sync правит только версию', async () => {
	const dir = await synced();
	const path = '.github/workflows/build.yml';
	const text = WORKFLOW.replace('0.60.2', '0.0.1');
	await Bun.write(join(dir, path), text);
	const checked = await run(['check'], dir);
	expect(checked.code).toBe(1);
	expect(pinLines(checked.err)).toHaveLength(1);
	await run(['sync'], dir);
	expect(read(dir, path)).toBe(text.replace("'0.0.1'", `'${NODE_PINS.proto}'`));
	expect((await run(['check'], dir)).code).toBe(0);
});
