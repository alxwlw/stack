import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

import { main } from './main.mjs';

function call(argv: string[], out?: (s: string) => void) {
	const o: string[] = [];
	const e: string[] = [];
	const code = main(argv, {}, out ?? ((s) => o.push(s)), (s) => e.push(s));
	return { code, out: o, err: e };
}

test('main: каталог вне git — код 2 и одна строка «repo-rules: …», без исключения', () => {
	const r = call(['-C', mkdtempSync(join(tmpdir(), 'rr-main-')), 'check']);
	expect(r.code).toBe(2);
	expect(r.out).toStrictEqual([]);
	expect(r.err).toHaveLength(1);
	expect(r.err[0]).toStartWith('repo-rules: git rev-parse failed');
});

test('main: неизвестный флаг — код 2, строка начинается с «repo-rules: » и несёт usage', () => {
	const r = call(['check', '--nope']);
	expect(r.code).toBe(2);
	expect(r.err).toHaveLength(1);
	expect(r.err[0]).toStartWith('repo-rules: ');
	expect(r.err[0]).toContain('repo-rules [-C <dir>] check [--json]');
});

test('main: --version — код 0 и версия из package.json пакета', () => {
	const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8')) as {
		version: string;
	};
	expect(call(['--version'])).toStrictEqual({ code: 0, out: [pkg.version], err: [] });
});

test('main: ошибка не RepoRulesError — «internal error» и код 2', () => {
	const r = call(['--version'], () => {
		throw new Error('boom');
	});
	expect(r.code).toBe(2);
	expect(r.err).toHaveLength(1);
	expect(r.err[0]).toStartWith('repo-rules: internal error: Error: boom');
});
