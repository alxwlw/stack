import { expect, test } from 'bun:test';

import { readGuardrails } from './guardrails.ts';
import { actionlintArgv } from './guardrails-actionlint.ts';
import { type GuardrailRun, type GuardrailsPort } from './guardrails-port.ts';
import { shellcheckArgv } from './guardrails-shellcheck.ts';
import { repoDir } from './testkit.ts';

type Call = [string, string[]];

// Порт-фальшивка: таблица «команда + аргументы → результат», вызов вне таблицы бросает; вызовы записаны.
function fakePort(table: Record<string, GuardrailRun>, env: NodeJS.ProcessEnv) {
	const calls: Call[] = [];
	const port: GuardrailsPort = {
		env,
		run: (cmd, argv) => {
			calls.push([cmd, argv]);
			const hit = table[[cmd, ...argv].join(' ')];
			if (hit === undefined) throw new Error(`unexpected call: ${cmd} ${argv.join(' ')}`);
			return hit;
		},
	};
	return { port, calls };
}

const ok = (out: string): GuardrailRun => ({ code: 0, out, err: '' });
const tracked = (...paths: string[]): GuardrailRun => ok(paths.map((p) => `${p}\0`).join(''));
const GIT = 'git ls-files -z';
const ENV = { ACTIONLINT_BIN: '/x/al', SHELLCHECK_BIN: '/x/sc' };
const PROTOTOOLS = 'actionlint = "1.7.12"\nshellcheck = "0.11.0"\n';
const AL_VERSION = '/x/al -version';
const SC_VERSION = '/x/sc --version';
const AL_OUT = ok('1.7.12\ninstalled by downloading from release page\n');
const SC_OUT = ok('ShellCheck - shell script analysis tool\nversion: 0.11.0\nlicense: GPL\n');
const NO_FILES = { skipped: 'no files' } as const;

const shellcheckJson = (...lines: number[]): GuardrailRun => ({
	code: lines.length > 0 ? 1 : 0,
	err: '',
	out: JSON.stringify({
		comments: lines.map((line) => ({
			file: 'a.sh',
			line,
			endLine: line,
			column: 1,
			endColumn: 2,
			level: 'warning',
			code: 2086,
			message: `quote at ${line}`,
			fix: null,
		})),
	}),
});

test('только README.md без пина gitleaks — actionlint и shellcheck skipped, gitleaks недоступен, зовётся один git', () => {
	const root = repoDir({ 'README.md': '# acme\n' });
	const f = fakePort({ [GIT]: tracked('README.md') }, ENV);
	const out = readGuardrails(root, PROTOTOOLS, f.port);
	expect(out).toStrictEqual({
		tools: {
			actionlint: NO_FILES,
			shellcheck: NO_FILES,
			gitleaks: { unavailable: '.prototools has no gitleaks pin' },
			hadolint: NO_FILES,
		},
		commits: { skipped: 'gitleaks unavailable' },
	});
	expect(f.calls).toStrictEqual([['git', ['ls-files', '-z']]]);
});

test('git вне репозитория — вся группа недоступна, один вызов', () => {
	const root = repoDir({});
	const fatal = 'fatal: not a git repository (or any of the parent directories): .git';
	const f = fakePort({ [GIT]: { code: 128, out: '', err: `${fatal}\n` } }, ENV);
	expect(readGuardrails(root, PROTOTOOLS, f.port)).toStrictEqual({ unavailable: fatal });
	expect(f.calls).toStrictEqual([['git', ['ls-files', '-z']]]);
});

test('только скрипт — shellcheck запущен, actionlint skipped и не зовётся', () => {
	const root = repoDir({ 'a.sh': 'echo $x\n' });
	const f = fakePort(
		{
			[GIT]: tracked('a.sh'),
			[SC_VERSION]: SC_OUT,
			[`/x/sc ${shellcheckArgv(['a.sh']).join(' ')}`]: shellcheckJson(3),
		},
		ENV,
	);
	const out = readGuardrails(root, PROTOTOOLS, f.port);
	expect(out).toStrictEqual({
		tools: {
			actionlint: NO_FILES,
			shellcheck: {
				version: '0.11.0',
				files: 1,
				violations: [
					{ tool: 'shellcheck', rule: 'SC2086', path: 'a.sh', line: 3, message: 'quote at 3' },
				],
			},
			gitleaks: { unavailable: '.prototools has no gitleaks pin' },
			hadolint: NO_FILES,
		},
		commits: { skipped: 'gitleaks unavailable' },
	});
	expect(f.calls).toStrictEqual([
		['git', ['ls-files', '-z']],
		['/x/sc', ['--version']],
		['/x/sc', ['-f', 'json1', '--', 'a.sh']],
	]);
});

test('файл из git, которого нет на диске, инструменту не уходит; shellcheck без скриптов skipped', () => {
	const root = repoDir({ '.github/workflows/ci.yml': 'on: push\n' });
	const argv = actionlintArgv('/x/sc', ['.github/workflows/ci.yml']);
	const f = fakePort(
		{
			[GIT]: tracked('.github/workflows/ci.yml', '.github/workflows/gone.yml'),
			[SC_VERSION]: SC_OUT,
			[AL_VERSION]: AL_OUT,
			[`/x/al ${argv.join(' ')}`]: ok(''),
		},
		ENV,
	);
	const out = readGuardrails(root, PROTOTOOLS, f.port);
	expect(out).toStrictEqual({
		tools: {
			actionlint: { version: '1.7.12', files: 1, violations: [] },
			shellcheck: NO_FILES,
			gitleaks: { unavailable: '.prototools has no gitleaks pin' },
			hadolint: NO_FILES,
		},
		commits: { skipped: 'gitleaks unavailable' },
	});
	expect(f.calls).toStrictEqual([
		['git', ['ls-files', '-z']],
		['/x/sc', ['--version']],
		['/x/al', ['-version']],
		[
			'/x/al',
			['-format', '{{json .}}', '-shellcheck=/x/sc', '-pyflakes=', '.github/workflows/ci.yml'],
		],
	]);
});

test('только workflow без пина shellcheck — shellcheck недоступен, actionlint с -shellcheck=, /x/sc не зовётся', () => {
	const root = repoDir({ '.github/workflows/ci.yml': 'on: push\n' });
	const argv = actionlintArgv(undefined, ['.github/workflows/ci.yml']);
	const f = fakePort(
		{
			[GIT]: tracked('.github/workflows/ci.yml'),
			[AL_VERSION]: AL_OUT,
			[`/x/al ${argv.join(' ')}`]: ok(''),
		},
		ENV,
	);
	const out = readGuardrails(root, 'actionlint = "1.7.12"\n', f.port);
	expect(out).toStrictEqual({
		tools: {
			actionlint: { version: '1.7.12', files: 1, violations: [] },
			shellcheck: { unavailable: '.prototools has no shellcheck pin' },
			gitleaks: { unavailable: '.prototools has no gitleaks pin' },
			hadolint: NO_FILES,
		},
		commits: { skipped: 'gitleaks unavailable' },
	});
	expect(f.calls).toStrictEqual([
		['git', ['ls-files', '-z']],
		['/x/al', ['-version']],
		['/x/al', ['-format', '{{json .}}', '-shellcheck=', '-pyflakes=', '.github/workflows/ci.yml']],
	]);
});

test('скрипты и workflow, нет пина actionlint — actionlint недоступен, shellcheck отработал на двух скриптах', () => {
	const root = repoDir({
		'a.sh': 'echo\n',
		'scripts/b.bash': 'echo\n',
		'.github/workflows/ci.yml': 'on: push\n',
	});
	const f = fakePort(
		{
			[GIT]: tracked('a.sh', 'scripts/b.bash', '.github/workflows/ci.yml'),
			[SC_VERSION]: SC_OUT,
			[`/x/sc ${shellcheckArgv(['a.sh', 'scripts/b.bash']).join(' ')}`]: shellcheckJson(),
		},
		ENV,
	);
	const out = readGuardrails(root, 'shellcheck = "0.11.0"\n', f.port);
	expect(out).toStrictEqual({
		tools: {
			actionlint: { unavailable: '.prototools has no actionlint pin' },
			shellcheck: { version: '0.11.0', files: 2, violations: [] },
			gitleaks: { unavailable: '.prototools has no gitleaks pin' },
			hadolint: NO_FILES,
		},
		commits: { skipped: 'gitleaks unavailable' },
	});
	expect(f.calls).toStrictEqual([
		['git', ['ls-files', '-z']],
		['/x/sc', ['--version']],
		['/x/sc', ['-f', 'json1', '--', 'a.sh', 'scripts/b.bash']],
	]);
});

test('actionlint: два workflow — files 2, находки разобраны', () => {
	const root = repoDir({
		'.github/workflows/a.yml': 'on: push\n',
		'.github/workflows/b.yaml': 'on: push\n',
	});
	const WF_B = '.github/workflows/b.yaml';
	const files = ['.github/workflows/a.yml', WF_B];
	const finding = [{ message: 'bad', filepath: WF_B, line: 4, column: 1, kind: 'syntax-check' }];
	const f = fakePort(
		{
			[GIT]: tracked(...files),
			[SC_VERSION]: SC_OUT,
			[AL_VERSION]: AL_OUT,
			[`/x/al ${actionlintArgv('/x/sc', files).join(' ')}`]: {
				code: 1,
				out: JSON.stringify(finding),
				err: '',
			},
		},
		ENV,
	);
	const out = readGuardrails(root, PROTOTOOLS, f.port);
	expect(out).toStrictEqual({
		tools: {
			actionlint: {
				version: '1.7.12',
				files: 2,
				violations: [
					{ tool: 'actionlint', rule: 'syntax-check', path: WF_B, line: 4, message: 'bad' },
				],
			},
			shellcheck: NO_FILES,
			gitleaks: { unavailable: '.prototools has no gitleaks pin' },
			hadolint: NO_FILES,
		},
		commits: { skipped: 'gitleaks unavailable' },
	});
});

test('нет .prototools — нужные инструменты недоступны, ненужный skipped, вызов только git', () => {
	const root = repoDir({ 'a.sh': 'echo\n' });
	const f = fakePort({ [GIT]: tracked('a.sh') }, ENV);
	const out = readGuardrails(root, undefined, f.port);
	expect(out).toStrictEqual({
		tools: {
			actionlint: NO_FILES,
			shellcheck: { unavailable: '.prototools is missing' },
			gitleaks: { unavailable: '.prototools is missing' },
			hadolint: NO_FILES,
		},
		commits: { skipped: 'gitleaks unavailable' },
	});
	expect(f.calls).toStrictEqual([['git', ['ls-files', '-z']]]);
});

test('нет .prototools при workflow — недоступны оба', () => {
	const root = repoDir({ '.github/workflows/ci.yml': 'on: push\n' });
	const f = fakePort({ [GIT]: tracked('.github/workflows/ci.yml') }, ENV);
	expect(readGuardrails(root, undefined, f.port)).toStrictEqual({
		tools: {
			actionlint: { unavailable: '.prototools is missing' },
			shellcheck: { unavailable: '.prototools is missing' },
			gitleaks: { unavailable: '.prototools is missing' },
			hadolint: NO_FILES,
		},
		commits: { skipped: 'gitleaks unavailable' },
	});
	expect(f.calls).toStrictEqual([['git', ['ls-files', '-z']]]);
});

test('shellcheck вернул код 2 — часть недоступна с первой строкой stderr', () => {
	const root = repoDir({ 'a.sh': 'echo\n' });
	const f = fakePort(
		{
			[GIT]: tracked('a.sh'),
			[SC_VERSION]: SC_OUT,
			[`/x/sc ${shellcheckArgv(['a.sh']).join(' ')}`]: {
				code: 2,
				out: '',
				err: 'a.sh: openBinaryFile: does not exist\nmore\n',
			},
		},
		ENV,
	);
	expect(readGuardrails(root, PROTOTOOLS, f.port)).toStrictEqual({
		tools: {
			actionlint: NO_FILES,
			shellcheck: { unavailable: 'a.sh: openBinaryFile: does not exist' },
			gitleaks: { unavailable: '.prototools has no gitleaks pin' },
			hadolint: NO_FILES,
		},
		commits: { skipped: 'gitleaks unavailable' },
	});
});

test('скрипт без расширения с шебангом считается, без шебанга — нет', () => {
	const root = repoDir({
		'bin/run': '#!/usr/bin/env bash\necho\n',
		'bin/data': 'plain\n',
	});
	const f = fakePort(
		{
			[GIT]: tracked('bin/run', 'bin/data'),
			[SC_VERSION]: SC_OUT,
			[`/x/sc ${shellcheckArgv(['bin/run']).join(' ')}`]: shellcheckJson(),
		},
		ENV,
	);
	const out = readGuardrails(root, PROTOTOOLS, f.port);
	expect(out).toStrictEqual({
		tools: {
			actionlint: NO_FILES,
			shellcheck: { version: '0.11.0', files: 1, violations: [] },
			gitleaks: { unavailable: '.prototools has no gitleaks pin' },
			hadolint: NO_FILES,
		},
		commits: { skipped: 'gitleaks unavailable' },
	});
});

test('отслеживаемый скрипт, которого нет на диске, shellcheck не уходит', () => {
	const root = repoDir({ 'a.sh': 'echo\n' });
	const f = fakePort(
		{
			[GIT]: tracked('a.sh', 'gone.sh'),
			[SC_VERSION]: SC_OUT,
			[`/x/sc ${shellcheckArgv(['a.sh']).join(' ')}`]: shellcheckJson(),
		},
		ENV,
	);
	const out = readGuardrails(root, PROTOTOOLS, f.port);
	expect(out).toStrictEqual({
		tools: {
			actionlint: NO_FILES,
			shellcheck: { version: '0.11.0', files: 1, violations: [] },
			gitleaks: { unavailable: '.prototools has no gitleaks pin' },
			hadolint: NO_FILES,
		},
		commits: { skipped: 'gitleaks unavailable' },
	});
	expect(f.calls).toHaveLength(3);
	expect(f.calls.at(-1)).toStrictEqual(['/x/sc', ['-f', 'json1', '--', 'a.sh']]);
});
