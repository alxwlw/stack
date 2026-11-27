import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, test } from 'bun:test';

import { parsePins } from './canon.ts';
import { readGuardrails } from './guardrails.ts';
import { gitleaksDirArgv } from './guardrails-gitleaks.ts';
import {
	markdownlintCommand,
	type MarkdownlintReport,
	type MarkdownlintResult,
} from './guardrails-markdownlint.ts';
import { type GuardrailRun, type GuardrailsPort } from './guardrails-port.ts';
import { guardrailsNotes } from './guardrails-rule.ts';
import { prBase } from './pr-base.ts';
import { repoDir, ROOT, withPrivateTmpdir } from './testkit.ts';

const NO_PR = prBase(undefined, {});

const NO_FILES = { skipped: 'no files' } as const;
// Ни пина, ни бинарника: из внешних инструментов в этих фикстурах нужен один раннер stack.
const PROTOTOOLS = '';
const GIT = 'git ls-files -z';
const GL_PIN = parsePins(readFileSync(join(ROOT, '.prototools'), 'utf8')).gitleaks ?? '';
const GL_VERSION = '/x/gl version';
const GL_DIR = `/x/gl ${gitleaksDirArgv().join(' ')}`;
const { cmd: RUN_CMD, argv: RUN_ARGV } = markdownlintCommand();
const RUN = [RUN_CMD, ...RUN_ARGV].join(' ');

type Row = GuardrailRun | ((cwd: string | undefined) => GuardrailRun);

// Порт-фальшивка: таблица «команда + аргументы → результат или функция от cwd», вызов вне таблицы
// бросает; вызовы записаны.
function fakePort(table: Record<string, Row>, env: NodeJS.ProcessEnv = {}) {
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

const ok = (out: string): GuardrailRun => ({ code: 0, out, err: '' });
const tracked = (...paths: string[]): GuardrailRun => ok(paths.map((p) => `${p}\0`).join(''));
const reportOf = (
	results: MarkdownlintResult[],
	over: Partial<MarkdownlintReport> = {},
): GuardrailRun =>
	ok(JSON.stringify({ version: '9.8.7', code: 0, formatted: true, results, ...over }));
const part = (out: ReturnType<typeof readGuardrails>) => {
	if ('unavailable' in out) throw new Error(out.unavailable);
	return out.tools['markdownlint-cli2'];
};
const warning: MarkdownlintResult = {
	fileName: 'docs/a.md',
	lineNumber: 4,
	ruleNames: ['MD040', 'fenced-code-language'],
	ruleDescription: 'Fenced code blocks should have a language specified',
	errorDetail: null,
	severity: 'warning',
};

describe('читатель: markdownlint-cli2 с портом-таблицей', () => {
	const dirs: string[] = [];
	afterAll(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
	});
	const repo = (files: Record<string, string>): string => {
		const dir = repoDir(files);
		dirs.push(dir);
		return dir;
	};

	test('причина markdownlint: путь копии — путь репозитория, голый каталог — точка', () => {
		const root = repo({ 'README.md': '# x\n' });
		const f = fakePort({
			[GIT]: tracked('README.md'),
			[RUN]: (c) => ({ code: 1, out: '', err: `boom ${c}/x in ${c}\n` }),
		});
		withPrivateTmpdir(() => {
			expect(part(readGuardrails(root, PROTOTOOLS, f.port, NO_PR))).toStrictEqual({
				unavailable: 'boom x in .',
			});
		});
	});

	test('Markdown есть — раннер в копии с командой markdownlintCommand, неотслеживаемого нет, версия из отчёта', () => {
		const TRACKED = ['README.md', 'docs/a.md', 'docs/b.mdx', 'c.txt'];
		const root = repo({
			...Object.fromEntries(TRACKED.map((p) => [p, '# x\n'])),
			'local.md': 'x\n',
		});
		let cwd: string | undefined;
		let list: string[] = [];
		const f = fakePort({
			[GIT]: tracked(...TRACKED),
			[RUN]: (dir) => {
				cwd = dir;
				list = dir === undefined ? [] : readdirSync(dir).sort();
				return reportOf([warning]);
			},
		});
		withPrivateTmpdir(() => {
			const out = readGuardrails(root, PROTOTOOLS, f.port, NO_PR);
			expect(part(out)).toStrictEqual({
				version: '9.8.7',
				files: 3,
				violations: [
					{
						tool: 'markdownlint-cli2',
						rule: 'MD040',
						path: 'docs/a.md',
						line: 4,
						message: 'Fenced code blocks should have a language specified',
					},
				],
			});
			expect(f.calls).toStrictEqual([GIT, RUN]);
			expect(cwd).not.toBeUndefined();
			expect(cwd).not.toBe(root);
			expect(list).toStrictEqual(['README.md', 'c.txt', 'docs']);
			expect(existsSync(join(cwd ?? root, 'README.md'))).toBe(false);
			expect(guardrailsNotes(out)).toContain(
				'guardrails markdownlint-cli2 9.8.7: 3 file(s), 1 finding(s)',
			);
		});
	});

	test('Markdown нет — раннер не вызван, часть skipped', () => {
		const root = repo({ 'a.txt': 'x\n', 'b.markdown': '# x\n', 'C.MD': '# x\n' });
		const f = fakePort({ [GIT]: tracked('a.txt', 'b.markdown', 'C.MD') });
		expect(part(readGuardrails(root, PROTOTOOLS, f.port, NO_PR))).toStrictEqual(NO_FILES);
		expect(f.calls).toStrictEqual([GIT]);
	});

	test('раннер недоступен (код 2, stderr) — часть недоступна с этой строкой, прочие части целы', () => {
		const root = repo({ 'README.md': '# x\n' });
		const f = fakePort({
			[GIT]: tracked('README.md'),
			[RUN]: {
				code: 2,
				out: '',
				err: "Unable to use configuration file '/c/.markdownlint-cli2.jsonc'\n",
			},
		});
		const out = readGuardrails(root, PROTOTOOLS, f.port, NO_PR);
		expect(part(out)).toStrictEqual({
			unavailable: "Unable to use configuration file '/c/.markdownlint-cli2.jsonc'",
		});
		if ('unavailable' in out) throw new Error(out.unavailable);
		expect(out.tools.actionlint).toStrictEqual(NO_FILES);
		expect(out.commits).toStrictEqual({ skipped: 'gitleaks unavailable' });
	});

	test('нет конфига — код отчёта 2, недоступность no globs', () => {
		const root = repo({ 'README.md': '# x\n' });
		const f = fakePort({ [GIT]: tracked('README.md'), [RUN]: reportOf([], { code: 2 }) });
		expect(part(readGuardrails(root, PROTOTOOLS, f.port, NO_PR))).toStrictEqual({
			unavailable: 'no globs: the markdownlint-cli2 config is missing or lists none',
		});
	});

	test('TMPDIR недоступен — часть недоступна с copy:, раннер не запущен', () => {
		const root = repo({ 'README.md': '# x\n' });
		const f = fakePort({ [GIT]: tracked('README.md') });
		const saved = process.env.TMPDIR;
		process.env.TMPDIR = '/nonexistent';
		try {
			const p = part(readGuardrails(root, PROTOTOOLS, f.port, NO_PR));
			expect('unavailable' in p && p.unavailable.startsWith('copy: ')).toBe(true);
		} finally {
			if (saved === undefined) Reflect.deleteProperty(process.env, 'TMPDIR');
			else process.env.TMPDIR = saved;
		}
		expect(f.calls).toStrictEqual([GIT]);
	});

	test('тот же каталог копии, что у gitleaks, и копия убрана', () => {
		const root = repo({ 'README.md': '# x\n' });
		let glCwd: string | undefined;
		let mdCwd: string | undefined;
		const f = fakePort(
			{
				[GIT]: tracked('README.md'),
				[GL_VERSION]: ok(`${GL_PIN}\n`),
				[GL_DIR]: (dir) => {
					glCwd = dir;
					return ok('[]');
				},
				[RUN]: (dir) => {
					mdCwd = dir;
					return reportOf([]);
				},
			},
			{ GITLEAKS_BIN: '/x/gl' },
		);
		withPrivateTmpdir(() => {
			const out = readGuardrails(root, `gitleaks = "${GL_PIN}"\n`, f.port, NO_PR);
			if ('unavailable' in out) throw new Error(out.unavailable);
			expect(out.tools.gitleaks).toMatchObject({ version: GL_PIN, violations: [] });
			expect(out.tools['markdownlint-cli2']).toStrictEqual({
				version: '9.8.7',
				files: 1,
				violations: [],
			});
			expect(mdCwd).not.toBeUndefined();
			expect(mdCwd).toBe(glCwd);
			expect(existsSync(mdCwd ?? root)).toBe(false);
		});
	});
});
