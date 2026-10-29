import * as fs from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

import { check, plan, syncRepo } from './check.ts';
import { loadRepo } from './repo.ts';
import { ioError, repoDir, testCanon, testRepo } from './testkit.ts';

const canon = testCanon();
const FILE = '.moon/toolchains.yml';
const run = (yaml: string | Error | null, exceptions: { file: string; reason: string }[] = []) =>
	check(
		testRepo(canon, { [FILE]: yaml instanceof Error ? { failed: yaml } : yaml }),
		canon,
		exceptions,
	);

test('pnpm: {} и node: {} — находок нет', () => {
	expect(run('pnpm: {}\nnode: {}\n')).toEqual([]);
});

test('pnpm.version на другой версии — находка с адресом и текстом', () => {
	const findings = run("pnpm:\n  version: '9.0.0'\nnode: {}\n");
	expect(findings.map((f) => [f.code, f.target, f.message])).toEqual([
		[
			'moon-toolchain-version',
			'.moon/toolchains.yml:pnpm.version',
			'"9.0.0" pins pnpm a second time — .prototools owns the version; leave it unset (pnpm: {})',
		],
	]);
});

test('версия, равная пину .prototools, — тоже находка', () => {
	const findings = run("node:\n  version: '25.4.1'\n");
	expect(findings.map((f) => [f.code, f.target])).toEqual([
		['moon-toolchain-version', '.moon/toolchains.yml:node.version'],
	]);
});

test('ключ, которого нет в пинах канона (rust.version), — не находка; toString не считается пином', () => {
	expect(run("rust:\n  version: '1.80.0'\ntoString:\n  version: '1'\n")).toEqual([]);
});

test('несколько инструментов — по находке на каждый, version не строкой — не находка', () => {
	const findings = run("node:\n  version: '24.0.0'\npnpm:\n  version: 10\n");
	expect(findings.map((f) => f.target)).toEqual(['.moon/toolchains.yml:node.version']);
});

test('битый YAML — одна unreadable-file, правило молчит', () => {
	const findings = run("node:\n  version: '24.0.0'\n  : [\n");
	expect(findings.map((f) => f.code)).toEqual(['unreadable-file']);
	expect(findings[0]?.target).toBe(FILE);
	expect(findings[0]?.message).toStartWith(`${FILE} does not parse: `);
	expect(findings[0]?.message).not.toContain('\n');
});

test('каталог на месте файла (EISDIR) — одна unreadable-file, правило молчит', () => {
	const findings = run(ioError('EISDIR', 'illegal operation on a directory'));
	expect(findings.map((f) => [f.code, f.target, f.message])).toEqual([
		['unreadable-file', FILE, `${FILE} does not parse: EISDIR: illegal operation on a directory`],
	]);
});

test('пустой файл и не-словарь — находок нет, moonToolchains — пустой словарь', () => {
	expect(run('')).toEqual([]);
	expect(run('- node\n- pnpm\n')).toEqual([]);
	expect(testRepo(canon, { [FILE]: '- node\n' }).moonToolchains).toEqual({});
	expect(testRepo(canon, { [FILE]: '' }).moonToolchains).toEqual({});
});

test('node: без значения (null) — находок нет', () => {
	expect(run('node:\npnpm:\n')).toEqual([]);
});

test('исключение { file } держит находку; без находки — stale-exception', () => {
	const exception = { file: FILE, reason: 'moon качает свой node' };
	const held = run("node:\n  version: '24.0.0'\n", [exception]);
	expect(held.map((f) => [f.code, f.suppressedBy?.reason])).toEqual([
		['moon-toolchain-version', 'moon качает свой node'],
	]);
	expect(run('node: {}\n', [exception]).map((f) => f.code)).toEqual(['stale-exception']);
});

test('sync не трогает .moon/toolchains.yml: находка не Drift', () => {
	const yaml = "node:\n  version: '24.0.0'\n";
	expect(plan(testRepo(canon, { [FILE]: yaml }), canon)).toEqual([]);
	const dir = repoDir({
		'package.json': JSON.stringify({ name: 'r', packageManager: 'pnpm@10.99.0' }),
		[FILE]: yaml,
	});
	expect(syncRepo(dir, canon, []).applied).toEqual([]);
	expect(fs.readFileSync(join(dir, FILE), 'utf8')).toBe(yaml);
});

test('loadRepo с диска читает .moon/toolchains.yml', () => {
	const dir = repoDir({
		'package.json': JSON.stringify({ name: 'r', packageManager: 'pnpm@10.99.0' }),
		[FILE]: "pnpm:\n  version: '9.0.0'\n",
	});
	expect(loadRepo(dir, canon).moonToolchains).toEqual({ pnpm: { version: '9.0.0' } });
});
