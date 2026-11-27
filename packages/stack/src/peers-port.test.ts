import { realpathSync } from 'node:fs';

import { afterEach, beforeEach, expect, test } from 'bun:test';

import { pnpmPeers } from './peers-port.ts';
import { fakeBin, repoDir } from './testkit.ts';

// Переменная окружения процесса тестов, которой нет в параметре adapter.
const LEAK = 'STACK_TEST_LEAK';
beforeEach(() => void (process.env[LEAK] = 'from-process'));
afterEach(() => void Reflect.deleteProperty(process.env, LEAK));

test('pnpmPeers: pnpm зовётся в корне репозитория с аргументами гейта, без GH_TOKEN', () => {
	const bin = fakeBin({
		pnpm: `echo "cwd=$PWD args=$* token=\${GH_TOKEN-unset} leak=\${${LEAK}-unset}" >&2; exit 2`,
	});
	const dir = repoDir({});
	expect(pnpmPeers({ PATH: bin.env.PATH, GH_TOKEN: 'secret-token' })(dir)).toStrictEqual({
		status: 2,
		signal: null,
		stdout: '',
		stderr: `cwd=${realpathSync(dir)} args=peers check --lockfile-only --json token=unset leak=unset\n`,
	});
});

test('pnpmPeers: pnpm нет на PATH — error с причиной запуска', () => {
	expect(pnpmPeers({ PATH: '/nonexistent' })(repoDir({}))).toStrictEqual({
		error: 'Executable not found in $PATH: "pnpm"',
	});
});
