import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

import { binVar, locateTool, protoBinPath, repoPins, toolVersion } from './guardrails-bin.ts';
import { type GuardrailRun, type GuardrailsPort, spawnRunner } from './guardrails-port.ts';
import { ROOT } from './testkit.ts';

type Call = [string, string[]];

// Порт-фальшивка: таблица «команда + аргументы → результат», вызов вне таблицы бросает.
function fakePort(table: Record<string, GuardrailRun>, env: NodeJS.ProcessEnv = {}) {
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
const PINS = { actionlint: '1.7.12', shellcheck: '0.11.0' };
const SC_OUT = 'ShellCheck - shell script analysis tool\nversion: 0.11.0\nlicense: GPL\n';
const AGENT_LINE =
	'{"type":"message","message":"Detected an AI agent environment, switching output."}';

test('repoPins: пины, нет файла, битый TOML', () => {
	const pins = repoPins(
		'actionlint = "1.7.12"\nshellcheck = "0.11.0"\n[plugins]\nx = "file://y"\n',
	);
	expect(pins).toEqual(PINS);
	expect(repoPins(undefined)).toEqual({ unavailable: '.prototools is missing' });
	const bad = repoPins('actionlint = ');
	expect('unavailable' in bad && bad.unavailable.startsWith('.prototools does not parse: ')).toBe(
		true,
	);
});

test('binVar: имя переменной', () => {
	expect(binVar('actionlint')).toBe('ACTIONLINT_BIN');
	expect(binVar('shellcheck')).toBe('SHELLCHECK_BIN');
});

test('toolVersion: actionlint, shellcheck, мусор', () => {
	expect(
		toolVersion(
			'actionlint',
			'1.7.12\ninstalled by downloading from release page\nbuilt with go1.26.1 compiler for linux/amd64\n',
		),
	).toBe('1.7.12');
	expect(toolVersion('shellcheck', SC_OUT)).toBe('0.11.0');
	expect(toolVersion('shellcheck', 'garbage')).toBeUndefined();
	expect(toolVersion('actionlint', 'garbage\n')).toBeUndefined();
});

test('protoBinPath: голый путь, NDJSON, ошибки', () => {
	expect(protoBinPath(ok('/p/actionlint\n'))).toBe('/p/actionlint');
	expect(protoBinPath(ok(`${AGENT_LINE}\n{"type":"message","message":"/p/actionlint"}\n`))).toBe(
		'/p/actionlint',
	);
	const untrusted =
		'Unable to proceed, the plugin for actionlint is configured in /r/.prototools, which has not been trusted, so it was not loaded.';
	const ndjsonError = `${AGENT_LINE}\n${JSON.stringify({
		type: 'error',
		code: 'proto::tool::untrusted_plugin',
		message: `${untrusted}\n\nReview the config, then trust it with proto trust /r/.prototools`,
	})}\n`;
	expect(protoBinPath({ code: 1, out: ndjsonError, err: '' })).toEqual({ unavailable: untrusted });
	expect(
		protoBinPath({
			code: 1,
			out: '',
			err: 'Error: proto::locate::missing_executable\n\n  × Unable to find …\n',
		}),
	).toEqual({ unavailable: 'Error: proto::locate::missing_executable' });
	expect('unavailable' in (protoBinPath(ok('')) as object)).toBe(true);
	expect('unavailable' in (protoBinPath(ok('{not json\n')) as object)).toBe(true);
});

test('locateTool: нет пина или пины недоступны — порт не вызван', () => {
	const a = fakePort({});
	expect(locateTool('shellcheck', { actionlint: '1.7.12' }, a.port)).toEqual({
		unavailable: '.prototools has no shellcheck pin',
	});
	expect(a.calls).toEqual([]);
	const b = fakePort({});
	expect(locateTool('shellcheck', { unavailable: '.prototools is missing' }, b.port)).toEqual({
		unavailable: '.prototools is missing',
	});
	expect(b.calls).toEqual([]);
});

test('locateTool: путь из переменной, proto не зовётся; пустая переменная — proto bin', () => {
	const a = fakePort({ '/x/sc --version': ok(SC_OUT) }, { SHELLCHECK_BIN: '/x/sc' });
	expect(locateTool('shellcheck', PINS, a.port)).toEqual({ bin: '/x/sc', version: '0.11.0' });
	expect(a.calls).toEqual([['/x/sc', ['--version']]]);
	const b = fakePort(
		{ 'proto bin shellcheck': ok('/p/sc\n'), '/p/sc --version': ok(SC_OUT) },
		{ SHELLCHECK_BIN: '' },
	);
	expect(locateTool('shellcheck', PINS, b.port)).toEqual({ bin: '/p/sc', version: '0.11.0' });
	expect(b.calls).toEqual([
		['proto', ['bin', 'shellcheck']],
		['/p/sc', ['--version']],
	]);
});

test('locateTool: proto отдаёт NDJSON-путь, версия совпала', () => {
	const { port, calls } = fakePort({
		'proto bin actionlint': ok(`${AGENT_LINE}\n{"type":"message","message":"/p/actionlint"}\n`),
		'/p/actionlint -version': ok('1.7.12\nbuilt with go\n'),
	});
	expect(locateTool('actionlint', PINS, port)).toEqual({ bin: '/p/actionlint', version: '1.7.12' });
	expect(calls).toEqual([
		['proto', ['bin', 'actionlint']],
		['/p/actionlint', ['-version']],
	]);
});

test('locateTool: proto отдал другую версию, чем пин (недоверенный .prototools)', () => {
	const { port } = fakePort({
		'proto bin actionlint': ok('/p/actionlint\n'),
		'/p/actionlint -version': ok('1.7.12\n'),
	});
	expect(locateTool('actionlint', { actionlint: '1.7.11' }, port)).toEqual({
		unavailable: 'actionlint 1.7.12 at /p/actionlint, .prototools pins 1.7.11',
	});
});

test('locateTool: устаревшая переменная — версия и путь, который не запускается', () => {
	const old = fakePort({ '/x/sc --version': ok('version: 0.10.0\n') }, { SHELLCHECK_BIN: '/x/sc' });
	expect(locateTool('shellcheck', PINS, old.port)).toEqual({
		unavailable: 'shellcheck 0.10.0 at /x/sc, .prototools pins 0.11.0 (from SHELLCHECK_BIN)',
	});
	const gone = fakePort(
		{ '/x/sc --version': { code: -1, out: '', err: '/x/sc: spawnSync /x/sc ENOENT' } },
		{ SHELLCHECK_BIN: '/x/sc' },
	);
	expect(locateTool('shellcheck', PINS, gone.port)).toEqual({
		unavailable: 'SHELLCHECK_BIN=/x/sc: /x/sc: spawnSync /x/sc ENOENT',
	});
});

test('locateTool: proto упал; проба печатает мусор; проба без переменной упала', () => {
	const a = fakePort({
		'proto bin actionlint': { code: 1, out: '', err: 'Error: proto::boom\n' },
	});
	expect(locateTool('actionlint', PINS, a.port)).toEqual({
		unavailable: 'proto bin actionlint: Error: proto::boom',
	});
	const b = fakePort({
		'proto bin actionlint': ok('/p/actionlint\n'),
		'/p/actionlint -version': ok('hello\n'),
	});
	expect(locateTool('actionlint', PINS, b.port)).toEqual({
		unavailable: '/p/actionlint printed no actionlint version',
	});
	const c = fakePort({
		'proto bin actionlint': ok('/p/actionlint\n'),
		'/p/actionlint -version': { code: 3, out: '', err: '' },
	});
	expect(locateTool('actionlint', PINS, c.port)).toEqual({
		unavailable: '/p/actionlint: exited with 3',
	});
});

test('настоящий proto: бинарники ровно версий пинов корня репозитория', () => {
	const pins = repoPins(readFileSync(join(ROOT, '.prototools'), 'utf8'));
	const port: GuardrailsPort = {
		run: spawnRunner(ROOT),
		env: { ...process.env, ACTIONLINT_BIN: '', SHELLCHECK_BIN: '' },
	};
	const a = locateTool('actionlint', pins, port);
	const s = locateTool('shellcheck', pins, port);
	if ('unavailable' in a || 'unavailable' in s) {
		throw new Error(JSON.stringify({ a, s }));
	}
	expect(a.version).toBe('1.7.12');
	expect(s.version).toBe('0.11.0');
	expect(existsSync(a.bin)).toBe(true);
	expect(existsSync(s.bin)).toBe(true);
}, 30_000);

test('spawnRunner: код 0, и -1 с причиной для несуществующей команды', () => {
	const tmp = mkdtempSync(join(tmpdir(), 'guardrails-bin-'));
	const run = spawnRunner(tmp);
	expect(run('git', ['--version']).code).toBe(0);
	const bad = run('no-such-cmd-guardrails', []);
	expect(bad.code).toBe(-1);
	expect(bad.err).toStartWith('no-such-cmd-guardrails: ');
});
