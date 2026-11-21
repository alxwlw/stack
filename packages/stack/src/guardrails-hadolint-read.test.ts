import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, test } from 'bun:test';

import { parsePins } from './canon.ts';
import { readGuardrails } from './guardrails.ts';
import { gitleaksDirArgv } from './guardrails-gitleaks.ts';
import { hadolintArgv } from './guardrails-hadolint.ts';
import { type GuardrailRun, type GuardrailsPort } from './guardrails-port.ts';
import { repoDir, ROOT, withPrivateTmpdir } from './testkit.ts';

const ROOT_PINS = parsePins(readFileSync(join(ROOT, '.prototools'), 'utf8'));
const GL_PIN = ROOT_PINS.gitleaks ?? '';
const HL_PIN = ROOT_PINS.hadolint ?? '';
const PROTOTOOLS = `gitleaks = "${GL_PIN}"\nhadolint = "${HL_PIN}"\n`;
const NO_FILES = { skipped: 'no files' } as const;
const NO_BASE = { skipped: 'no --base outside GitHub Actions' } as const;

type Env = Readonly<Record<string, string>> | undefined;
type Row = GuardrailRun | ((cwd: string | undefined, env: Env) => GuardrailRun);

// Порт-фальшивка: таблица «команда + аргументы → результат или функция от cwd и env», вызов вне
// таблицы бросает; вызовы записаны.
function fakePort(table: Record<string, Row>, env: Record<string, string>) {
	const calls: string[] = [];
	const port: GuardrailsPort = {
		env,
		run: (cmd, argv, cwd, extra) => {
			const key = [cmd, ...argv].join(' ');
			calls.push(key);
			const hit = table[key];
			if (hit === undefined) throw new Error(`unexpected call: ${key}`);
			return typeof hit === 'function' ? hit(cwd, extra) : hit;
		},
	};
	return { port, calls };
}

const ok = (out: string, err = ''): GuardrailRun => ({ code: 0, out, err });
const tracked = (...paths: string[]): GuardrailRun => ok(paths.map((p) => `${p}\0`).join(''));
const BINS = { GITLEAKS_BIN: '/x/gl', HADOLINT_BIN: '/x/hl' };
const GIT = 'git ls-files -z';
const GL_VERSION = '/x/gl version';
const GL_DIR = `/x/gl ${gitleaksDirArgv().join(' ')}`;
const HL_VERSION = '/x/hl --version';
const hlRun = (files: string[]): string => `/x/hl ${hadolintArgv(files).join(' ')}`;
const hlBanner = `Haskell Dockerfile Linter ${HL_PIN}\n`;
const finding = (path: string): string =>
	JSON.stringify([
		{ code: 'DL3025', column: 1, file: path, level: 'warning', line: 4, message: 'json notation' },
	]);

const homes = (): string[] => readdirSync(tmpdir()).filter((n) => n.startsWith('stack-home-'));
const copies = (): string[] => readdirSync(tmpdir()).filter((n) => n.startsWith('stack-gitleaks-'));

describe('читатель: hadolint с портом-таблицей', () => {
	const dirs: string[] = [];
	afterAll(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
	});
	const repo = (files: Record<string, string>): string => {
		const dir = repoDir(files);
		dirs.push(dir);
		return dir;
	};
	const hadolintPart = (out: ReturnType<typeof readGuardrails>) => {
		if ('unavailable' in out) throw new Error(out.unavailable);
		return out.tools.hadolint;
	};

	test('четыре отслеживаемых Dockerfile, копия без чужого конфига, чистый HOME, всё убрано', () => {
		const TRACKED = [
			'Dockerfile',
			'apps/api/Dockerfile.prod',
			'deploy/web.Dockerfile',
			'build/Dockerfile',
			'Dockerfile.dockerignore',
		];
		const root = repo({
			...Object.fromEntries(TRACKED.map((p) => [p, 'FROM alpine:3.20\n'])),
			'local.Dockerfile': 'FROM alpine:3.20\n',
			'.hadolint.yaml': 'ignored: [DL3025]\n',
		});
		const set = TRACKED.slice(0, 4);
		let seen:
			| { cwd: string | undefined; env: Env; homeListing: string[]; conf: boolean; list: string[] }
			| undefined;
		let glCwd: string | undefined;
		const f = fakePort(
			{
				[GIT]: tracked(...TRACKED),
				[GL_VERSION]: ok(`${GL_PIN}\n`),
				[HL_VERSION]: ok(hlBanner),
				[GL_DIR]: (cwd) => {
					glCwd = cwd;
					return ok('[]');
				},
				[hlRun(set)]: (cwd, env) => {
					seen = {
						cwd,
						env,
						homeListing: env?.HOME === undefined ? ['?'] : readdirSync(env.HOME),
						conf: existsSync(join(cwd ?? root, '.hadolint.yaml')),
						list: cwd === undefined ? [] : readdirSync(cwd).sort(),
					};
					return ok('[]');
				},
			},
			BINS,
		);
		withPrivateTmpdir(() => {
			const out = readGuardrails(root, PROTOTOOLS, f.port);
			expect(out).toStrictEqual({
				tools: {
					actionlint: NO_FILES,
					shellcheck: NO_FILES,
					gitleaks: { version: GL_PIN, files: 5, violations: [] },
					hadolint: { version: HL_PIN, files: 4, violations: [] },
					'markdownlint-cli2': NO_FILES,
					yamllint: NO_FILES,
				},
				commits: NO_BASE,
			});
			expect(f.calls).toStrictEqual([GIT, GL_VERSION, HL_VERSION, GL_DIR, hlRun(set)]);
			expect(seen?.cwd).toBe(glCwd);
			expect(seen?.cwd).not.toBe(root);
			expect(seen?.conf).toBe(false);
			expect(seen?.list).toStrictEqual([
				'Dockerfile',
				'Dockerfile.dockerignore',
				'apps',
				'build',
				'deploy',
			]);
			expect(seen?.env?.HOME).toBeString();
			expect(seen?.env?.XDG_CONFIG_HOME).toBe(seen?.env?.HOME);
			expect(seen?.homeListing).toStrictEqual([]);
			expect(existsSync(seen?.env?.HOME ?? root)).toBe(false);
			expect(existsSync(glCwd ?? root)).toBe(false);
			expect(homes()).toStrictEqual([]);
			expect(copies()).toStrictEqual([]);
		});
	});

	test('Dockerfile нет — hadolint не ищется и не зовётся', () => {
		const root = repo({ 'README.txt': '# acme\n' });
		const f = fakePort(
			{ [GIT]: tracked('README.txt'), [GL_VERSION]: ok(`${GL_PIN}\n`), [GL_DIR]: ok('[]') },
			{ GITLEAKS_BIN: '/x/gl' },
		);
		const out = readGuardrails(root, PROTOTOOLS, f.port);
		expect(hadolintPart(out)).toStrictEqual(NO_FILES);
		expect(f.calls).toStrictEqual([GIT, GL_VERSION, GL_DIR]);
		expect(f.calls.some((c) => c.includes('hadolint') || c.includes('/x/hl'))).toBe(false);
	});

	test('нет пина hadolint — часть недоступна, остальное как без hadolint', () => {
		const root = repo({ Dockerfile: 'FROM alpine:3.20\n' });
		const f = fakePort(
			{ [GIT]: tracked('Dockerfile'), [GL_VERSION]: ok(`${GL_PIN}\n`), [GL_DIR]: ok('[]') },
			BINS,
		);
		const out = readGuardrails(root, `gitleaks = "${GL_PIN}"\n`, f.port);
		expect(out).toStrictEqual({
			tools: {
				actionlint: NO_FILES,
				shellcheck: NO_FILES,
				gitleaks: { version: GL_PIN, files: 1, violations: [] },
				hadolint: { unavailable: '.prototools has no hadolint pin' },
				'markdownlint-cli2': NO_FILES,
				yamllint: NO_FILES,
			},
			commits: NO_BASE,
		});
		expect(f.calls).toStrictEqual([GIT, GL_VERSION, GL_DIR]);
	});

	test('нет пина gitleaks, Dockerfile есть — копия всё равно нужна hadolint', () => {
		const root = repo({ Dockerfile: 'FROM alpine:3.20\n' });
		let cwd: string | undefined;
		const f = fakePort(
			{
				[GIT]: tracked('Dockerfile'),
				[HL_VERSION]: ok(hlBanner),
				[hlRun(['Dockerfile'])]: (c) => {
					cwd = c;
					return ok(finding('Dockerfile'));
				},
			},
			BINS,
		);
		const out = readGuardrails(root, `hadolint = "${HL_PIN}"\n`, f.port);
		expect(out).toStrictEqual({
			tools: {
				actionlint: NO_FILES,
				shellcheck: NO_FILES,
				gitleaks: { unavailable: '.prototools has no gitleaks pin' },
				hadolint: {
					version: HL_PIN,
					files: 1,
					violations: [
						{
							tool: 'hadolint',
							rule: 'DL3025',
							path: 'Dockerfile',
							line: 4,
							message: 'json notation',
						},
					],
				},
				'markdownlint-cli2': NO_FILES,
				yamllint: NO_FILES,
			},
			commits: { skipped: 'gitleaks unavailable' },
		});
		expect(cwd?.startsWith(join(tmpdir(), 'stack-gitleaks-'))).toBe(true);
		expect(existsSync(cwd ?? root)).toBe(false);
	});

	test('код 0, [] и строка в stderr — недоступность; находка warning — violations', () => {
		const root = repo({ Dockerfile: 'FROM alpine:3.20\n' });
		const line = "Error parsing your config file in '/c/.hadolint.yaml': bad";
		const base = {
			[GIT]: tracked('Dockerfile'),
			[GL_VERSION]: ok(`${GL_PIN}\n`),
			[GL_DIR]: ok('[]'),
			[HL_VERSION]: ok(hlBanner),
		};
		const broken = fakePort({ ...base, [hlRun(['Dockerfile'])]: ok('[]', `${line}\n`) }, BINS);
		expect(hadolintPart(readGuardrails(root, PROTOTOOLS, broken.port))).toStrictEqual({
			unavailable: line,
		});
		const found = fakePort({ ...base, [hlRun(['Dockerfile'])]: ok(finding('Dockerfile')) }, BINS);
		expect(hadolintPart(readGuardrails(root, PROTOTOOLS, found.port))).toMatchObject({
			version: HL_PIN,
			files: 1,
			violations: [{ tool: 'hadolint', rule: 'DL3025', path: 'Dockerfile', line: 4 }],
		});
	});

	describe('пометка hadolint по копии — пути репозитория', () => {
		const SHORT = "Error parsing your config file in  '.hadolint.yaml':";
		const broken = (path: string): GuardrailRun => ({
			code: 1,
			out: '',
			err: `Error parsing your config file in  '${path}/.hadolint.yaml':\\nAesonException "x"\n`,
		});
		const table = (answer: (cwd: string | undefined) => GuardrailRun) => ({
			[GIT]: tracked('Dockerfile'),
			[GL_VERSION]: ok(`${GL_PIN}\n`),
			[GL_DIR]: ok('[]'),
			[HL_VERSION]: ok(hlBanner),
			[hlRun(['Dockerfile'])]: answer,
		});

		test('путь копии (cwd вызова) заменён на путь репозитория', () => {
			const root = repo({ Dockerfile: 'FROM alpine:3.20\n' });
			const f = fakePort(
				table((cwd) => broken(cwd ?? '?')),
				BINS,
			);
			withPrivateTmpdir(() => {
				expect(hadolintPart(readGuardrails(root, PROTOTOOLS, f.port))).toStrictEqual({
					unavailable: SHORT,
				});
			});
		});

		test('голый каталог копии в причине — точка', () => {
			const root = repo({ Dockerfile: 'FROM alpine:3.20\n' });
			const f = fakePort(
				table((cwd) => ({ code: 1, out: '', err: `cwd: ${cwd}\n` })),
				BINS,
			);
			withPrivateTmpdir(() => {
				expect(hadolintPart(readGuardrails(root, PROTOTOOLS, f.port))).toStrictEqual({
					unavailable: 'cwd: .',
				});
			});
		});

		test('TMPDIR через символическую ссылку: realpath копии содержит строку копии — тот же результат', () => {
			const root = repo({ Dockerfile: 'FROM alpine:3.20\n' });
			const saved = process.env.TMPDIR;
			const base = mkdtempSync(join(tmpdir(), 'stack-link-'));
			// Как macOS: копия `<base>/tmp/X`, её realpath `<base>/private<base>/tmp/X` содержит строку копии.
			mkdirSync(join(base, 'private', base, 'tmp'), { recursive: true });
			symlinkSync(join(base, 'private', base, 'tmp'), join(base, 'tmp'));
			process.env.TMPDIR = join(base, 'tmp');
			let checked = false;
			const f = fakePort(
				table((cwd) => {
					const copy = cwd ?? '?';
					const real = realpathSync(copy);
					expect(real).not.toBe(copy);
					expect(real.includes(copy)).toBe(true);
					checked = true;
					return broken(real);
				}),
				BINS,
			);
			try {
				expect(hadolintPart(readGuardrails(root, PROTOTOOLS, f.port))).toStrictEqual({
					unavailable: SHORT,
				});
				expect(checked).toBe(true);
			} finally {
				if (saved === undefined) Reflect.deleteProperty(process.env, 'TMPDIR');
				else process.env.TMPDIR = saved;
				rmSync(base, { recursive: true, force: true });
			}
		});
	});

	test('порт бросил посреди hadolint — каталог HOME и копия всё равно удалены', () => {
		const root = repo({ Dockerfile: 'FROM alpine:3.20\n' });
		const f = fakePort(
			{
				[GIT]: tracked('Dockerfile'),
				[GL_VERSION]: ok(`${GL_PIN}\n`),
				[GL_DIR]: ok('[]'),
				[HL_VERSION]: ok(hlBanner),
				[hlRun(['Dockerfile'])]: () => {
					throw new Error('boom');
				},
			},
			BINS,
		);
		withPrivateTmpdir(() => {
			expect(() => readGuardrails(root, PROTOTOOLS, f.port)).toThrow('boom');
			expect(homes()).toStrictEqual([]);
			expect(copies()).toStrictEqual([]);
		});
	});

	test('TMPDIR недоступен — gitleaks и hadolint недоступны с copy:, ни один не запущен', () => {
		const root = repo({ Dockerfile: 'FROM alpine:3.20\n' });
		const f = fakePort(
			{
				[GIT]: tracked('Dockerfile'),
				[GL_VERSION]: ok(`${GL_PIN}\n`),
				[HL_VERSION]: ok(hlBanner),
			},
			BINS,
		);
		const saved = process.env.TMPDIR;
		process.env.TMPDIR = '/nonexistent';
		try {
			const out = readGuardrails(root, PROTOTOOLS, f.port);
			if ('unavailable' in out) throw new Error(out.unavailable);
			for (const part of [out.tools.gitleaks, out.tools.hadolint]) {
				expect('unavailable' in part && part.unavailable.startsWith('copy: ')).toBe(true);
			}
			expect(out.commits).toStrictEqual({ skipped: 'gitleaks unavailable' });
		} finally {
			if (saved === undefined) Reflect.deleteProperty(process.env, 'TMPDIR');
			else process.env.TMPDIR = saved;
		}
		expect(f.calls).toStrictEqual([GIT, GL_VERSION, HL_VERSION]);
	});

	test('tmp отказал после копии — hadolint недоступен с home:, gitleaks цел, исключения нет', () => {
		const root = repo({ Dockerfile: 'FROM alpine:3.20\n' });
		const saved = process.env.TMPDIR;
		const f = fakePort(
			{
				[GIT]: tracked('Dockerfile'),
				[GL_VERSION]: ok(`${GL_PIN}\n`),
				[HL_VERSION]: ok(hlBanner),
				[GL_DIR]: () => {
					process.env.TMPDIR = '/nonexistent';
					return ok('[]');
				},
			},
			BINS,
		);
		try {
			const out = readGuardrails(root, PROTOTOOLS, f.port);
			if ('unavailable' in out) throw new Error(out.unavailable);
			const part = out.tools.hadolint;
			expect('unavailable' in part && part.unavailable.startsWith('home: ')).toBe(true);
			expect(out.tools.gitleaks).toStrictEqual({ version: GL_PIN, files: 1, violations: [] });
		} finally {
			if (saved === undefined) Reflect.deleteProperty(process.env, 'TMPDIR');
			else process.env.TMPDIR = saved;
		}
		expect(f.calls).toStrictEqual([GIT, GL_VERSION, HL_VERSION, GL_DIR]);
	});
});
