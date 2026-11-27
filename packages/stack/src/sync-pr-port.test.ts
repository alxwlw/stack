import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'bun:test';

import type { Line, Print } from './output.ts';
import { runProcess } from './sync-pr-port.ts';
import { fakeBin, repoDir } from './testkit.ts';

const collect = () => {
	const lines: Line[] = [];
	const print: Print = (stream, text) => void lines.push({ stream, text });
	return { lines, print };
};
// Переменная окружения процесса тестов, которой нет в параметре adapter.
const LEAK = 'STACK_TEST_LEAK';
beforeEach(() => void (process.env[LEAK] = 'from-process'));
afterEach(() => void Reflect.deleteProperty(process.env, LEAK));

test('runProcess: процесс убит сигналом — код 1 и строка с именем сигнала в err', () => {
	const bin = fakeBin({ proto: 'kill -TERM $$' });
	const { lines, print } = collect();
	expect(
		runProcess({ PATH: bin.env.PATH }, print)('proto', ['install'], { cwd: repoDir({}) }),
	).toBe(1);
	expect(lines).toStrictEqual([{ stream: 'err', text: 'sync-pr: proto killed by SIGTERM' }]);
});

test('runProcess: команды нет на PATH — код 127 и строка с причиной запуска в err', () => {
	const { lines, print } = collect();
	expect(
		runProcess({ PATH: '/nonexistent' }, print)('proto', ['install'], { cwd: repoDir({}) }),
	).toBe(127);
	expect(lines).toStrictEqual([
		{ stream: 'err', text: 'sync-pr: proto: Executable not found in $PATH: "proto"' },
	]);
});

test('runProcess: окружение — из параметра без GH_TOKEN, env вызова сверху; cwd — из вызова', () => {
	const log = join(mkdtempSync(join(tmpdir(), 'stack-log-')), 'env.log');
	const bin = fakeBin({
		tool: `echo "cwd=$PWD token=\${GH_TOKEN-unset} version=\${VERSION-unset} keep=\${KEEP-unset} leak=\${${LEAK}-unset}" > ${log}`,
	});
	const cwd = repoDir({});
	const { lines, print } = collect();
	const env = { PATH: bin.env.PATH, GH_TOKEN: 'secret-token', KEEP: '1' };
	expect(runProcess(env, print)('tool', [], { cwd, env: { VERSION: '1.2.3' } })).toBe(0);
	expect(readFileSync(log, 'utf8').trim()).toBe(
		`cwd=${realpathSync(cwd)} token=unset version=1.2.3 keep=1 leak=unset`,
	);
	expect(lines).toStrictEqual([]);
});

test('runProcess: ненулевой код процесса возвращается как есть, строк в порт нет', () => {
	const bin = fakeBin({ tool: 'exit 7' });
	const { lines, print } = collect();
	expect(runProcess({ PATH: bin.env.PATH }, print)('tool', [], { cwd: repoDir({}) })).toBe(7);
	expect(lines).toStrictEqual([]);
});
