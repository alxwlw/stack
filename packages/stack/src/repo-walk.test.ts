import { chmodSync } from 'node:fs';
import { join } from 'node:path';

import { Glob } from 'bun';
import { expect, test } from 'bun:test';

import { readSnapshot, SKIP } from './repo.ts';
import { repoDir, testCanon } from './testkit.ts';

const ROOT = join(import.meta.dir, '..', '..', '..');
const root = process.getuid?.() === 0;

// Каталог, который не читается (например, данные контейнера под чужим uid), не роняет снимок.
test.skipIf(root)('нечитаемый каталог в дереве: снимок не бросает и читает Dockerfile', () => {
	const dir = repoDir({ 'apps/api/Dockerfile': 'FROM node:24\n', 'data/pg/f': 'x' });
	chmodSync(join(dir, 'data/pg'), 0o000);
	try {
		const snapshot = readSnapshot(dir, testCanon());
		expect(snapshot.get('apps/api/Dockerfile')).toStrictEqual({ text: 'FROM node:24\n' });
		expect(snapshot.has('data/pg/f')).toBe(false);
	} finally {
		chmodSync(join(dir, 'data/pg'), 0o755);
	}
});

test.skipIf(root)('нечитаемый каталог при pnpm-workspace.yaml: вложенный package.json в снимке', () => {
	const dir = repoDir({
		'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
		'packages/a/package.json': '{}',
		'data/pg/f': 'x',
	});
	chmodSync(join(dir, 'data/pg'), 0o000);
	try {
		const snapshot = readSnapshot(dir, testCanon());
		expect(snapshot.get('packages/a/package.json')).toStrictEqual({ text: '{}' });
	} finally {
		chmodSync(join(dir, 'data/pg'), 0o755);
	}
});

test('обход не заходит в скрытые каталоги и SKIP, но читает workflow и action .github', () => {
	const dir = repoDir({
		'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
		'packages/a/package.json': '{}',
		'.devcontainer/Dockerfile': 'FROM node:24\n',
		'node_modules/x/package.json': '{}',
		'dist/Dockerfile': 'FROM node:24\n',
		'sub/build/Dockerfile': 'FROM node:24\n',
		'sub/Dockerfile': 'FROM node:24\n',
		'.github/workflows/ci.yml': 'a: 1\n',
		'.github/actions/x/action.yml': 'a: 1\n',
	});
	const keys = [...readSnapshot(dir, testCanon()).keys()];
	for (const path of [
		'packages/a/package.json',
		'sub/Dockerfile',
		'.github/workflows/ci.yml',
		'.github/actions/x/action.yml',
	]) {
		expect(keys).toContain(path);
	}
	for (const path of [
		'.devcontainer/Dockerfile',
		'node_modules/x/package.json',
		'dist/Dockerfile',
		'sub/build/Dockerfile',
	]) {
		expect(keys).not.toContain(path);
	}
});

test('вложенные package.json репозитория — те же, что отдавал Glob', () => {
	const old = [...new Glob('**/package.json').scanSync({ cwd: ROOT })]
		.filter((f) => !SKIP.test(f))
		.sort();
	const now = [...readSnapshot(ROOT, testCanon()).keys()]
		.filter((f) => f.split('/').at(-1) === 'package.json')
		.sort();
	expect(old.length).toBeGreaterThan(1);
	expect(now).toStrictEqual(old);
});
