import { expect, test } from 'bun:test';

import { alignToPin, pinCopies, pinSiteKind, rewritePinCopies } from './toolchain-pins.ts';

const PINS = { node: '26.13.1', bun: '1.4.4', pnpm: '12.21.0', proto: '0.64.0' };

test.each([
	['Dockerfile', 'dockerfile'],
	['apps/api/Dockerfile', 'dockerfile'],
	['apps/api/Dockerfile.dev', 'dockerfile'],
	['scripts/ui-check.Dockerfile', 'dockerfile'],
	['.github/workflows/ci.yml', 'workflow'],
	['.github/workflows/ci.yaml', 'workflow'],
	['.github/actions/setup/action.yml', 'workflow'],
	['.github/actions/a/b/action.yaml', 'workflow'],
	['apps/api/Dockerfile.dockerignore', undefined],
	['apps/api/dockerfile', undefined],
	['apps/api/MyDockerfile', undefined],
	['.github/workflows/sub/ci.yml', undefined],
	['.github/workflows/notes.txt', undefined],
	['.github/actions/setup/other.yml', undefined],
	['apps/.github/workflows/ci.yml', undefined],
	['action.yml', undefined],
	['package.json', undefined],
] as const)('pinSiteKind(%s) → %s', (path, kind) => {
	expect(pinSiteKind(path)).toBe(kind);
});

test.each([
	['26.11.1', '26.13.1', '26.13.1'],
	['26.11', '26.13.1', '26.13'],
	['24', '26.13.1', '26'],
	['1.4', '1.4.4', '1.4'],
	['26.11.1', '26', undefined],
	['26.11.1', '26.13.1-rc.1', undefined],
	['26.11.1', 'latest', undefined],
] as const)('alignToPin(%s, %s) → %s', (found, pin, want) => {
	expect(alignToPin(found, pin)).toBe(want);
});

const DOCKERFILE = [
	'# syntax=docker/dockerfile:1',
	'# node 26.11.1 and pnpm@11.28.5 match .prototools',
	'FROM node:26.11.1-alpine AS base',
	'RUN npm install -g pnpm@11.28.5',
	'FROM base AS deps',
	'FROM oven/bun:1.4-alpine AS runtime',
	'',
].join('\n');
const DOCKERFILE_SYNCED = DOCKERFILE.replace('node:26.11.1-alpine', 'node:26.13.1-alpine').replace(
	'RUN npm install -g pnpm@11.28.5',
	'RUN npm install -g pnpm@12.21.0',
);

test('dockerfile: копии в порядке строк; комментарий и чужой образ копиями не являются', () => {
	expect(
		pinCopies('dockerfile', DOCKERFILE).map(({ tool, version, line }) => ({ tool, version, line })),
	).toStrictEqual([
		{ tool: 'node', version: '26.11.1', line: 3 },
		{ tool: 'pnpm', version: '11.28.5', line: 4 },
		{ tool: 'bun', version: '1.4', line: 6 },
	]);
});

test('dockerfile: две разошедшиеся копии переписаны одной правкой, совпавшая по префиксу не тронута', () => {
	expect(rewritePinCopies('dockerfile', DOCKERFILE, PINS)).toStrictEqual({
		text: DOCKERFILE_SYNCED,
		changes: [
			{ tool: 'node', line: 3, from: '26.11.1', to: '26.13.1' },
			{ tool: 'pnpm', line: 4, from: '11.28.5', to: '12.21.0' },
		],
	});
});

test('переписанный текст чист: повторный проход ничего не меняет', () => {
	expect(rewritePinCopies('dockerfile', DOCKERFILE_SYNCED, PINS)).toStrictEqual({
		text: DOCKERFILE_SYNCED,
		changes: [],
	});
});

test('dockerfile: CRLF сохраняется', () => {
	const crlf = (s: string) => s.replaceAll('\n', '\r\n');
	expect(rewritePinCopies('dockerfile', crlf(DOCKERFILE), PINS).text).toBe(crlf(DOCKERFILE_SYNCED));
});

// Строка Dockerfile → она же после правки при PINS.
test.each([
	['FROM node:24-slim', 'FROM node:26-slim'],
	['FROM node:26.11-slim', 'FROM node:26.13-slim'],
	['FROM node:26.11.1', 'FROM node:26.13.1'],
	['FROM node:27', 'FROM node:26'],
	['FROM node:26.11.1-alpine3.22', 'FROM node:26.13.1-alpine3.22'],
	['from node:24-slim as deps', 'from node:26-slim as deps'],
	['  FROM node:24', '  FROM node:26'],
	[
		'FROM --platform=$BUILDPLATFORM node:24-alpine AS b',
		'FROM --platform=$BUILDPLATFORM node:26-alpine AS b',
	],
	['FROM oven/bun:1.4.2-slim AS build', 'FROM oven/bun:1.4.4-slim AS build'],
	[
		'RUN corepack enable && corepack prepare pnpm@11.15.0 --activate',
		'RUN corepack enable && corepack prepare pnpm@12.21.0 --activate',
	],
	['RUN npm i -g pnpm@11', 'RUN npm i -g pnpm@12'],
	['RUN npm i -g "pnpm@11.15.0"', 'RUN npm i -g "pnpm@12.21.0"'],
	['RUN npm i -g pnpm@11.15.0+sha512.abc123 && pnpm -v', 'RUN npm i -g pnpm@12.21.0 && pnpm -v'],
])('dockerfile: %s → %s', (line, want) => {
	expect(rewritePinCopies('dockerfile', `${line}\n`, PINS).text).toBe(`${want}\n`);
	// Последняя строка без перевода строки.
	expect(rewritePinCopies('dockerfile', line, PINS).text).toBe(want);
});

// Не копии: ни находки, ни правки.
test.each([
	'FROM node:26.13.1-alpine',
	'FROM node:26-slim',
	'FROM oven/bun:1.4-alpine',
	'RUN npm i -g pnpm@12.21.0+sha512.abc123',
])('dockerfile: совпавшая копия не меняется — %s', (line) => {
	expect(rewritePinCopies('dockerfile', `${line}\n`, PINS)).toStrictEqual({
		text: `${line}\n`,
		changes: [],
	});
});

test.each([
	'FROM node',
	'FROM node:lts',
	'FROM node:alpine',
	'FROM node:24rc',
	'FROM node:24.1.2.3',
	'FROM node:${NODE_VERSION}-alpine',
	'FROM node:$NODE_VERSION',
	'ARG NODE_VERSION=24.1.0',
	'FROM node:24@sha256:0123456789abcdef',
	'FROM node:24-slim@sha256:0123456789abcdef',
	'FROM node@sha256:0123456789abcdef',
	'FROM docker.io/library/node:24',
	'FROM docker.io/node:24',
	'FROM library/node:24',
	'FROM ghcr.io/acme/node:24',
	'FROM acme/oven/bun:1.4.2',
	'FROM mynode:24',
	'FROM nginx:1.27-alpine',
	'FROM base AS deps',
	'# FROM node:24-slim',
	'COPY --from=node:24-slim /usr/local/bin/node /usr/local/bin/',
	'RUN npm i -g pnpm@latest',
	'RUN npm i -g pnpm@11.x',
	'RUN npm i -g pnpm@12.0.0-rc.1',
	'RUN npm i -g @pnpm/exe@11.0.0',
	'RUN npm i -g my-pnpm@11.0.0',
	'  # pnpm@11.15.0 matches package.json',
])('dockerfile: не копия — %s', (line) => {
	expect(pinCopies('dockerfile', `${line}\n`)).toStrictEqual([]);
	expect(rewritePinCopies('dockerfile', `${line}\n`, PINS)).toStrictEqual({
		text: `${line}\n`,
		changes: [],
	});
});

test('инструмент без пина или с пином не из трёх чисел не сверяется', () => {
	expect(rewritePinCopies('dockerfile', DOCKERFILE, {}).changes).toStrictEqual([]);
	expect(
		rewritePinCopies('dockerfile', DOCKERFILE, { node: '26', pnpm: 'latest' }).changes,
	).toStrictEqual([]);
	expect(rewritePinCopies('dockerfile', DOCKERFILE, { node: '26.13.1' }).changes).toStrictEqual([
		{ tool: 'node', line: 3, from: '26.11.1', to: '26.13.1' },
	]);
});

const WORKFLOW = [
	'name: ci',
	'on: push',
	'jobs:',
	'  test:',
	'    runs-on: ubuntu-latest',
	'    strategy:',
	'      matrix:',
	'        node-version: [24, 26]',
	'        include:',
	'          - node-version: 24',
	'    steps:',
	'      - uses: moonrepo/setup-toolchain@v0',
	'        with:',
	"          proto-version: '0.60.2' # pinned on purpose",
	'          auto-install: true',
	'      - uses: actions/setup-node@v4',
	'        with: { node-version: 24, cache: pnpm }',
	'      - uses: oven-sh/setup-bun@v2',
	'        with:',
	'          bun-version: "1.4.2"',
	'      - uses: actions/setup-node@v4',
	'        with:',
	'          node-version: ${{ matrix.node-version }}',
	"      - run: 'echo node-version: 24'",
	'        env:',
	'          node-version: 24',
	'  call:',
	'    uses: ./.github/workflows/ci.yml',
	'    with:',
	"      node-version: '24'",
	'',
].join('\n');
const WORKFLOW_SYNCED = WORKFLOW.replace("'0.60.2'", "'0.64.0'")
	.replace('{ node-version: 24,', '{ node-version: 26,')
	.replace('"1.4.2"', '"1.4.4"')
	.replace("node-version: '24'", "node-version: '26'");

test('workflow: копии — только входы под with; матрица, выражение, env и текст run не тронуты', () => {
	expect(rewritePinCopies('workflow', WORKFLOW, PINS)).toStrictEqual({
		text: WORKFLOW_SYNCED,
		changes: [
			{ tool: 'proto', line: 14, from: '0.60.2', to: '0.64.0' },
			{ tool: 'node', line: 17, from: '24', to: '26' },
			{ tool: 'bun', line: 20, from: '1.4.2', to: '1.4.4' },
			{ tool: 'node', line: 30, from: '24', to: '26' },
		],
	});
	expect(rewritePinCopies('workflow', WORKFLOW_SYNCED, PINS).changes).toStrictEqual([]);
});

test('workflow: CRLF, кавычки и комментарий в строке сохраняются', () => {
	const crlf = (s: string) => s.replaceAll('\n', '\r\n');
	expect(rewritePinCopies('workflow', crlf(WORKFLOW), PINS).text).toBe(crlf(WORKFLOW_SYNCED));
});

const step = (input: string) =>
	`runs:\n  using: composite\n  steps:\n    - uses: actions/setup-node@v4\n      with:\n        ${input}\n`;

test('workflow: значение без кавычек, которое YAML прочитал бы другим числом, получает кавычки', () => {
	const sync = (input: string, pins: Record<string, string>) =>
		rewritePinCopies('workflow', step(input), pins).text;
	expect(sync('node-version: 26.9', { node: '26.10.2' })).toBe(step("node-version: '26.10'"));
	expect(sync('node-version: 26.9', { node: '26.13.1' })).toBe(step('node-version: 26.13'));
	expect(sync('node-version: 24', { node: '26.13.1' })).toBe(step('node-version: 26'));
	expect(sync('proto-version: 0.60.2', { proto: '0.64.0' })).toBe(step('proto-version: 0.64.0'));
	expect(sync('node-version: "26.9"', { node: '26.10.2' })).toBe(step('node-version: "26.10"'));
});

test.each([
	'node-version: latest',
	'bun-version: latest',
	"node-version: 'lts/*'",
	'node-version: 26.x',
	"node-version: '>=24'",
	'node-version: [24, 26]',
	'node-version: ${{ inputs.node }}',
	'node-version-file: .nvmrc',
	'pnpm-version: 11',
	'# node-version: 24',
])('workflow: не копия — %s', (input) => {
	expect(pinCopies('workflow', step(input))).toStrictEqual([]);
	expect(rewritePinCopies('workflow', step(input), PINS)).toStrictEqual({
		text: step(input),
		changes: [],
	});
});

test.each([
	['несколько документов', 'with:\n  node-version: 24\n---\nwith:\n  node-version: 24\n'],
	['ошибка разбора', 'jobs: [1, 2\nwith:\n  node-version: 24\n'],
	['пустой файл', ''],
])('workflow: %s — копий нет, текст не меняется', (_name, text) => {
	expect(pinCopies('workflow', text)).toStrictEqual([]);
	expect(rewritePinCopies('workflow', text, PINS)).toStrictEqual({ text, changes: [] });
});
