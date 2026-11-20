import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, expect, test } from 'bun:test';

import {
	isShellShebang,
	regularFiles,
	shellScripts,
	TRACKED_FILES_ARGV,
	trackedFiles,
	workflowFiles,
} from './guardrails-files.ts';
import { git, gitRepo, isolateGitConfig, repoDir } from './testkit.ts';

let restoreGit: () => void;
beforeAll(() => {
	restoreGit = isolateGitConfig();
});
afterAll(() => {
	restoreGit();
});

function lsFiles(cwd: string, env?: NodeJS.ProcessEnv) {
	const r = spawnSync('git', [...TRACKED_FILES_ARGV], { cwd, encoding: 'utf8', env });
	return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

test('trackedFiles: разбор вывода -z, пустой вывод, ошибка git', () => {
	expect(trackedFiles({ code: 0, out: 'a.sh\0dir/b c.sh\0файл.sh\0', err: '' })).toStrictEqual([
		'a.sh',
		'dir/b c.sh',
		'файл.sh',
	]);
	expect(trackedFiles({ code: 0, out: '', err: '' })).toStrictEqual([]);
	expect(
		trackedFiles({
			code: 128,
			out: '',
			err: 'fatal: not a git repository (or any of the parent directories): .git\n',
		}),
	).toStrictEqual({
		unavailable: 'fatal: not a git repository (or any of the parent directories): .git',
	});
	expect(trackedFiles({ code: 128, out: '', err: '' })).toStrictEqual({
		unavailable: 'exited with 128',
	});
});

test('настоящий git: только отслеживаемые обычные файлы', () => {
	const { dir, remote } = gitRepo({
		'a.sh': 'echo a\n',
		'dir/b c.sh': 'echo b\n',
		'файл.sh': 'echo f\n',
		'gone.sh': 'echo g\n',
		'.gitignore': '*.log\n.worktrees/\n',
	});
	try {
		symlinkSync('a.sh', join(dir, 'link.sh'));
		git(dir, 'add', 'link.sh');
		git(dir, 'commit', '-m', 'link');
		unlinkSync(join(dir, 'gone.sh'));
		writeFileSync(join(dir, 'new.sh'), 'echo n\n');
		writeFileSync(join(dir, 'x.log'), 'log\n');
		git(dir, 'worktree', 'add', '--detach', '.worktrees/wt');
		mkdirSync(join(dir, 'nested'));
		git(join(dir, 'nested'), 'init', '-b', 'main');
		writeFileSync(join(dir, 'nested', 'n.sh'), 'echo nested\n');
		git(join(dir, 'nested'), 'add', '-A');
		git(join(dir, 'nested'), 'commit', '-m', 'n');
		writeFileSync(join(dir, 'staged.sh'), 'echo s\n');
		git(dir, 'add', 'staged.sh');

		const tracked = trackedFiles(lsFiles(dir));
		if (!Array.isArray(tracked)) throw new Error(`trackedFiles: ${JSON.stringify(tracked)}`);
		expect(regularFiles(dir, tracked).toSorted()).toStrictEqual([
			'.gitignore',
			'a.sh',
			'dir/b c.sh',
			'staged.sh',
			'файл.sh',
		]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(remote, { recursive: true, force: true });
	}
});

test('вне git: unavailable с причиной git', () => {
	const dir = repoDir({ 'a.sh': 'echo\n' });
	try {
		const r = trackedFiles(lsFiles(dir, { ...process.env, GIT_CEILING_DIRECTORIES: dirname(dir) }));
		if (Array.isArray(r)) throw new Error('ожидалась недоступность');
		expect(r.unavailable.startsWith('fatal: not a git repository')).toBe(true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('workflowFiles: только файлы прямо в .github/workflows', () => {
	expect(
		workflowFiles([
			'.github/workflows/ci.yml',
			'.github/workflows/b c.yaml',
			'.github/workflows/sub/x.yml',
			'.github/actions/setup/action.yml',
			'docs/ci.yml',
			'.github/workflows/readme.md',
		]),
	).toStrictEqual(['.github/workflows/ci.yml', '.github/workflows/b c.yaml']);
});

test('isShellShebang: диалекты shellcheck — да, остальное — нет', () => {
	for (const line of [
		'#!/bin/sh',
		'#!/bin/sh -e',
		'#!/usr/bin/env bash',
		'#!/usr/bin/env -S bash -e',
		'#! /bin/bash',
		'#!/bin/dash',
		'#!/bin/ksh',
		'#!/usr/bin/env sh',
	]) {
		expect(isShellShebang(line), line).toBe(true);
	}
	for (const line of [
		'#!/usr/bin/env zsh',
		'#!/usr/bin/env python3',
		'#!/bin/bashful',
		'#!/usr/bin/fish',
		'#!/usr/bin/env',
		'# comment',
		'',
	]) {
		expect(isShellShebang(line), line).toBe(false);
	}
});

test('shellScripts: расширения и шебанги, порядок входа', () => {
	const dir = repoDir({
		'a.sh': 'echo a\n',
		'b.bash': 'echo b\n',
		'bin/tool': '#!/usr/bin/env bash\n',
		'bin/run': '#!/bin/sh -e\n',
		'with space': '#!/bin/sh\n',
		'bin/z': '#!/usr/bin/env zsh\n',
		'bin/py': '#!/usr/bin/env python3\n',
		'bin/blob': '\x7fELF\x02\x01\x01\0\0\0',
		'notes.txt': '#!/bin/sh\n',
		'.envrc': 'export A=1\n',
		'bin/crlf': '#!/bin/sh\r\n',
		'bin/long': `#!/usr/bin/env${' '.repeat(300)}bash\n`,
		'bin/mid': `#!/usr/bin/env${' '.repeat(200)}bash\n`,
	});
	try {
		const paths = [
			'a.sh',
			'b.bash',
			'bin/tool',
			'bin/run',
			'with space',
			'bin/z',
			'bin/py',
			'bin/blob',
			'notes.txt',
			'.envrc',
			'bin/crlf',
			'bin/long',
			'bin/mid',
		];
		expect(shellScripts(dir, paths)).toStrictEqual([
			'a.sh',
			'b.bash',
			'bin/tool',
			'bin/run',
			'with space',
			'bin/crlf',
			'bin/mid',
		]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
