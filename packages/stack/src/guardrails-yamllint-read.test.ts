import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, test } from 'bun:test';

import { parsePins } from './canon.ts';
import { readGuardrails } from './guardrails.ts';
import { gitleaksDirArgv } from './guardrails-gitleaks.ts';
import { type GuardrailRun, type GuardrailsPort } from './guardrails-port.ts';
import { guardrailsNotes } from './guardrails-rule.ts';
import { YAMLLINT_VERSION, yamllintArgv } from './guardrails-yamllint.ts';
import { repoDir, ROOT, withPrivateTmpdir } from './testkit.ts';

const ROOT_PINS = parsePins(readFileSync(join(ROOT, '.prototools'), 'utf8'));
const GL_PIN = ROOT_PINS.gitleaks ?? '';
const UV_PIN = ROOT_PINS.uv ?? '';
const PROTOTOOLS = `gitleaks = "${GL_PIN}"\nuv = "${UV_PIN}"\n`;
const NO_FILES = { skipped: 'no files' } as const;
const NO_BASE = { skipped: 'no --base outside GitHub Actions' } as const;
const NO_CONFIG = 'no yamllint config among tracked files (.yamllint)';

type Row = GuardrailRun | ((cwd: string | undefined) => GuardrailRun);

// Порт-фальшивка: таблица «команда + аргументы → результат или функция от cwd», вызов вне таблицы
// бросает; вызовы записаны.
function fakePort(table: Record<string, Row>, env: Record<string, string>) {
	const calls: string[] = [];
	const port: GuardrailsPort = {
		env,
		run: (cmd, argv, cwd) => {
			const key = [cmd, ...argv].join(' ');
			calls.push(key);
			const hit = table[key];
			if (hit === undefined) throw new Error(`unexpected call: ${key}`);
			return typeof hit === 'function' ? hit(cwd) : hit;
		},
	};
	return { port, calls };
}

const ok = (out: string, err = ''): GuardrailRun => ({ code: 0, out, err });
const tracked = (...paths: string[]): GuardrailRun => ok(paths.map((p) => `${p}\0`).join(''));
const GIT = 'git ls-files -z';
const GL_VERSION = '/x/gl version';
const GL_DIR = `/x/gl ${gitleaksDirArgv().join(' ')}`;
const UV_VERSION = '/x/uv --version';
const UV_RUN = `/x/uv ${yamllintArgv('.yamllint').join(' ')}`;
const uvBanner = `uv ${UV_PIN} (x86_64-unknown-linux-gnu)\n`;
const BINS = { GITLEAKS_BIN: '/x/gl', UV_BIN: '/x/uv' };
const CANON_CONFIGS = ['.yamllint', '.yamllint-canon-ignores', '.yamllint-ignores'];
const part = (out: ReturnType<typeof readGuardrails>) => {
	if ('unavailable' in out) throw new Error(out.unavailable);
	return out.tools.yamllint;
};

describe('читатель: yamllint с портом-таблицей', () => {
	const dirs: string[] = [];
	afterAll(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
	});
	const repo = (files: Record<string, string>): string => {
		const dir = repoDir(files);
		dirs.push(dir);
		return dir;
	};

	test('YAML и канонные конфиги отслеживаются — uv в копии с argv из yamllintArgv, пометка', () => {
		const TRACKED = [...CANON_CONFIGS, 'a.yml', 'docs/b.yaml', 'c.txt'];
		const root = repo(Object.fromEntries(TRACKED.map((p) => [p, 'x: 1\n'])));
		let glCwd: string | undefined;
		let uvCwd: string | undefined;
		let list: string[] = [];
		const f = fakePort(
			{
				[GIT]: tracked(...TRACKED),
				[GL_VERSION]: ok(`${GL_PIN}\n`),
				[UV_VERSION]: ok(uvBanner),
				[GL_DIR]: (cwd) => {
					glCwd = cwd;
					return ok('[]');
				},
				[UV_RUN]: (cwd) => {
					uvCwd = cwd;
					list = cwd === undefined ? [] : readdirSync(cwd).sort();
					return ok('');
				},
			},
			BINS,
		);
		withPrivateTmpdir(() => {
			const out = readGuardrails(root, PROTOTOOLS, f.port);
			if ('unavailable' in out) throw new Error(out.unavailable);
			// В наборе два YAML-файла; конфиги без суффикса .yaml/.yml и прочие файлы в набор не входят.
			expect(out.tools.yamllint).toStrictEqual({
				version: YAMLLINT_VERSION,
				files: 2,
				violations: [],
			});
			expect(out.commits).toStrictEqual(NO_BASE);
			expect(f.calls).toStrictEqual([GIT, GL_VERSION, UV_VERSION, GL_DIR, UV_RUN]);
			expect(uvCwd).toBe(glCwd);
			expect(uvCwd).not.toBe(root);
			expect(list).toStrictEqual([...CANON_CONFIGS, 'a.yml', 'c.txt', 'docs'].sort());
			expect(existsSync(uvCwd ?? root)).toBe(false);
			expect(guardrailsNotes(out)).toContain(
				`guardrails yamllint ${YAMLLINT_VERSION}: 2 file(s), 0 finding(s)`,
			);
		});
	});

	test('находки uv разбираются в violations', () => {
		const TRACKED = [...CANON_CONFIGS, 'dup.yml'];
		const root = repo(Object.fromEntries(TRACKED.map((p) => [p, 'x: 1\n'])));
		const f = fakePort(
			{
				[GIT]: tracked(...TRACKED),
				[GL_VERSION]: ok(`${GL_PIN}\n`),
				[UV_VERSION]: ok(uvBanner),
				[GL_DIR]: ok('[]'),
				[UV_RUN]: {
					code: 1,
					out: './dup.yml:2:1: [error] duplication of key "a" in mapping (key-duplicates)\n',
					err: '',
				},
			},
			BINS,
		);
		expect(part(readGuardrails(root, PROTOTOOLS, f.port))).toStrictEqual({
			version: YAMLLINT_VERSION,
			files: 1,
			violations: [
				{
					tool: 'yamllint',
					rule: 'key-duplicates',
					path: 'dup.yml',
					line: 2,
					message: 'duplication of key "a" in mapping',
				},
			],
		});
	});

	test('YAML нет — часть skipped, ни proto bin uv, ни вызова uv', () => {
		const root = repo({ 'README.txt': '# acme\n', '.yamllint': 'extends: default\n' });
		const f = fakePort(
			{
				[GIT]: tracked('README.txt', '.yamllint'),
				[GL_VERSION]: ok(`${GL_PIN}\n`),
				[GL_DIR]: ok('[]'),
			},
			{ GITLEAKS_BIN: '/x/gl' },
		);
		expect(part(readGuardrails(root, PROTOTOOLS, f.port))).toStrictEqual(NO_FILES);
		expect(f.calls).toStrictEqual([GIT, GL_VERSION, GL_DIR]);
		expect(f.calls.some((c) => c.includes('uv'))).toBe(false);
	});

	test('отслеживаемого конфига нет, неотслеживаемый .yamllint в корне — недоступность, uv не зовётся', () => {
		const root = repo({ 'a.yml': 'x: 1\n', '.yamllint': 'extends: default\n' });
		const f = fakePort(
			{
				[GIT]: tracked('a.yml'),
				[GL_VERSION]: ok(`${GL_PIN}\n`),
				[GL_DIR]: ok('[]'),
			},
			{ GITLEAKS_BIN: '/x/gl' },
		);
		expect(part(readGuardrails(root, PROTOTOOLS, f.port))).toStrictEqual({
			unavailable: NO_CONFIG,
		});
		expect(f.calls).toStrictEqual([GIT, GL_VERSION, GL_DIR]);
	});

	test('.prototools без пина uv — недоступность, остальное цело', () => {
		const root = repo({ '.yamllint': 'x: 1\n', 'a.yml': 'x: 1\n' });
		const f = fakePort(
			{
				[GIT]: tracked('.yamllint', 'a.yml'),
				[GL_VERSION]: ok(`${GL_PIN}\n`),
				[GL_DIR]: ok('[]'),
			},
			BINS,
		);
		const out = readGuardrails(root, `gitleaks = "${GL_PIN}"\n`, f.port);
		expect(part(out)).toStrictEqual({ unavailable: '.prototools has no uv pin' });
		if ('unavailable' in out) throw new Error(out.unavailable);
		expect(out.tools.gitleaks).toStrictEqual({ version: GL_PIN, files: 2, violations: [] });
		expect(f.calls).toStrictEqual([GIT, GL_VERSION, GL_DIR]);
	});

	test('нет пина gitleaks, YAML есть — копия нужна yamllint', () => {
		const TRACKED = ['.yamllint', 'a.yml'];
		const root = repo(Object.fromEntries(TRACKED.map((p) => [p, 'x: 1\n'])));
		let cwd: string | undefined;
		const f = fakePort(
			{
				[GIT]: tracked(...TRACKED),
				[UV_VERSION]: ok(uvBanner),
				[UV_RUN]: (c) => {
					cwd = c;
					return ok('');
				},
			},
			BINS,
		);
		const out = readGuardrails(root, `uv = "${UV_PIN}"\n`, f.port);
		expect(part(out)).toStrictEqual({ version: YAMLLINT_VERSION, files: 1, violations: [] });
		if ('unavailable' in out) throw new Error(out.unavailable);
		expect(out.tools.gitleaks).toStrictEqual({ unavailable: '.prototools has no gitleaks pin' });
		expect(cwd?.startsWith(join(tmpdir(), 'stack-gitleaks-'))).toBe(true);
		expect(existsSync(cwd ?? root)).toBe(false);
	});

	test('сбой uv — недоступность со строкой stderr; uv другой версии — недоступность', () => {
		const TRACKED = ['.yamllint', 'a.yml'];
		const root = repo(Object.fromEntries(TRACKED.map((p) => [p, 'x: 1\n'])));
		const base = {
			[GIT]: tracked(...TRACKED),
			[GL_VERSION]: ok(`${GL_PIN}\n`),
			[GL_DIR]: ok('[]'),
		};
		const failed = fakePort(
			{
				...base,
				[UV_VERSION]: ok(uvBanner),
				[UV_RUN]: {
					code: 1,
					out: '',
					err: 'error: No solution found when resolving tool dependencies:\n  x\n',
				},
			},
			BINS,
		);
		expect(part(readGuardrails(root, PROTOTOOLS, failed.port))).toStrictEqual({
			unavailable: 'error: No solution found when resolving tool dependencies:',
		});
		const other = fakePort({ ...base, [UV_VERSION]: ok('uv 0.0.1 (x)\n') }, BINS);
		expect(part(readGuardrails(root, PROTOTOOLS, other.port))).toStrictEqual({
			unavailable: `uv 0.0.1 at /x/uv, .prototools pins ${UV_PIN} (from UV_BIN)`,
		});
		expect(other.calls).toStrictEqual([GIT, GL_VERSION, UV_VERSION, GL_DIR]);
	});

	test('причина yamllint с путём копии — путь репозитория', () => {
		const TRACKED = ['.yamllint', 'a.yml'];
		const root = repo(Object.fromEntries(TRACKED.map((p) => [p, 'x: 1\n'])));
		const f = fakePort(
			{
				[GIT]: tracked(...TRACKED),
				[GL_VERSION]: ok(`${GL_PIN}\n`),
				[GL_DIR]: ok('[]'),
				[UV_VERSION]: ok(uvBanner),
				[UV_RUN]: (cwd) => ({
					code: 2,
					out: '',
					err: `Traceback\nFileNotFoundError: [Errno 2] No such file or directory: '${cwd}/.yamllint-ignores'\n`,
				}),
			},
			BINS,
		);
		withPrivateTmpdir((tmp) => {
			const p = part(readGuardrails(root, PROTOTOOLS, f.port));
			if (!('unavailable' in p)) throw new Error('expected unavailable');
			expect(p.unavailable).toBe(
				"FileNotFoundError: [Errno 2] No such file or directory: '.yamllint-ignores'",
			);
			expect(p.unavailable).not.toContain(tmp);
		});
	});

	test('TMPDIR недоступен — yamllint недоступен с copy:, uv не запущен', () => {
		const TRACKED = ['.yamllint', 'a.yml'];
		const root = repo(Object.fromEntries(TRACKED.map((p) => [p, 'x: 1\n'])));
		const f = fakePort(
			{ [GIT]: tracked(...TRACKED), [GL_VERSION]: ok(`${GL_PIN}\n`), [UV_VERSION]: ok(uvBanner) },
			BINS,
		);
		const saved = process.env.TMPDIR;
		process.env.TMPDIR = '/nonexistent';
		try {
			const p = part(readGuardrails(root, PROTOTOOLS, f.port));
			expect('unavailable' in p && p.unavailable.startsWith('copy: ')).toBe(true);
		} finally {
			if (saved === undefined) Reflect.deleteProperty(process.env, 'TMPDIR');
			else process.env.TMPDIR = saved;
		}
		expect(f.calls).toStrictEqual([GIT, GL_VERSION, UV_VERSION]);
	});
});
