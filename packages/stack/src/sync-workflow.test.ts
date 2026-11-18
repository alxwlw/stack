import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'bun:test';
import { parse as parseYaml } from 'yaml';

const ROOT = join(import.meta.dir, '..', '..', '..');

// sync.yml ждёт версию stack в реестре до bunx: rollout стартует сразу после publish, и в 1.6.0 все
// sync упали на «No version matching». Шаг гоняется в bash с curl-заглушкой, а не сверяется текстом.
type SyncStep = {
	name?: string;
	uses?: string;
	id?: string;
	if?: string;
	run?: string;
	env?: Record<string, string>;
};
const syncSteps = (
	parseYaml(readFileSync(join(ROOT, '.github', 'workflows', 'sync.yml'), 'utf8')) as {
		jobs?: Record<string, { steps?: SyncStep[] }>;
	}
).jobs?.sync?.steps;
const waitIdx = syncSteps?.findIndex((s) => s.name === 'дождаться версии в npm') ?? -1;
const waitStep = syncSteps?.[waitIdx];
const callIdx = syncSteps?.findIndex((s) => s.name === 'открыть sync-PR') ?? -1;
const callStep = syncSteps?.[callIdx];

/**
 * `body` — тело ответа реестра для stack; `undefined` — curl падает, как `curl -f` на 404/5xx.
 * `tarball` — ответ на пробу tarball (запрос, чей последний аргумент кончается на `.tgz`).
 */
function runWait(
	body: string | undefined,
	attempts: string,
	interval = '0',
	tarball: 200 | 404 = 200,
): { status: number | null; calls: string[]; out: string; sleeps: string[] } {
	const dir = mkdtempSync(join(tmpdir(), 'sync-wait-'));
	const calls = join(dir, 'calls');
	const reply = body === undefined ? 'exit 22' : `cat '${join(dir, 'body.json')}'`;
	if (body !== undefined) writeFileSync(join(dir, 'body.json'), body);
	// Проба tarball: в журнал `${метод} ${url}` (HEAD — только при ровно `-I` среди аргументов).
	const probe = tarball === 200 ? 'exit 0' : 'exit 22';
	writeFileSync(
		join(dir, 'curl'),
		[
			'#!/usr/bin/env bash',
			'last="${!#}"',
			'if [[ "$last" == *.tgz ]]; then',
			'  m=GET',
			'  for a in "$@"; do if [ "$a" = -I ]; then m=HEAD; fi; done',
			`  echo "$m $last" >> '${calls}'`,
			`  ${probe}`,
			'fi',
			'p="${last##*%2f}"',
			`echo "$p" >> '${calls}'`,
			reply,
			'',
		].join('\n'),
	);
	chmodSync(join(dir, 'curl'), 0o755);
	// Заглушка sleep пишет аргумент и не спит: паузы проверяются значением, а не временем.
	const sleeps = join(dir, 'sleeps');
	writeFileSync(join(dir, 'sleep'), `#!/usr/bin/env bash\necho "$1" >> '${sleeps}'\n`);
	chmodSync(join(dir, 'sleep'), 0o755);
	// Как раннер GitHub без `shell:`: `bash -e {0}`, без pipefail.
	const res = spawnSync('bash', ['-e', '-c', waitStep?.run ?? 'exit 99'], {
		env: {
			...process.env,
			PATH: `${dir}:${process.env.PATH}`,
			VERSION: '1.2.3',
			ATTEMPTS: attempts,
			INTERVAL: interval,
		},
		encoding: 'utf8',
	});
	const n = existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean) : [];
	const slept = existsSync(sleeps) ? readFileSync(sleeps, 'utf8').split('\n').filter(Boolean) : [];
	rmSync(dir, { recursive: true, force: true });
	return { status: res.status, calls: n, out: res.stdout, sleeps: slept };
}

/** Шаг вызова с заглушкой bunx: аргументы пишутся в файл по строке, код выхода — `exit`. */
function runCall(
	env: { INSTALL: string; BASE: string },
	exit = 0,
): { status: number | null; args: string[] } {
	const dir = mkdtempSync(join(tmpdir(), 'sync-call-'));
	const argsFile = join(dir, 'args');
	writeFileSync(
		join(dir, 'bunx'),
		`#!/usr/bin/env bash\nprintf '%s\\n' "$@" > '${argsFile}'\nexit ${exit}\n`,
	);
	chmodSync(join(dir, 'bunx'), 0o755);
	const res = spawnSync('bash', ['-e', '-c', callStep?.run ?? 'exit 99'], {
		env: {
			...process.env,
			PATH: `${dir}:${process.env.PATH}`,
			VERSION: '1.2.3',
			GH_TOKEN: 't',
			STACK_APP_SLUG: 'app',
			...env,
		},
		encoding: 'utf8',
	});
	const args = existsSync(argsFile) ? readFileSync(argsFile, 'utf8').split('\n').slice(0, -1) : [];
	rmSync(dir, { recursive: true, force: true });
	return { status: res.status, args };
}

const TARBALL = 'https://registry.npmjs.org/@alxwlw/stack/-/stack-1.2.3.tgz';
const has = `{"versions":{"1.2.2":{},"1.2.3":{"dist":{"tarball":"${TARBALL}"}}}}`;
// Версия есть, а dist.tarball нет: пробе нечего запрашивать.
const noTarball = '{"versions":{"1.2.3":{}}}';
// dist-tags с той же строкой не должны сойти за версию.
const lacks = '{"dist-tags":{"latest":"1.2.3"},"versions":{"1.2.2":{}}}';

test('sync.yml: токен приложения, checkout, setup, ожидание stack, вызов sync-pr — и ничего больше', () => {
	expect(syncSteps).toHaveLength(5);
	expect(syncSteps?.map((s) => s.uses?.replace(/@.*$/, '') ?? s.name)).toStrictEqual([
		'actions/create-github-app-token',
		'actions/checkout',
		'alxwlw/stack/.github/actions/setup',
		'дождаться версии в npm',
		'открыть sync-PR',
	]);
});

test('sync.yml: в run нет git, gh и чтения package.json', () => {
	for (const s of (syncSteps ?? []).filter((x) => x.run !== undefined)) {
		expect(s.run).not.toMatch(/\b(git|gh)\b/);
		expect(s.run).not.toContain('package.json');
	}
});

test('шаг вызова: окружение — версия, base, install, токен и slug приложения', () => {
	expect(callStep?.env).toEqual({
		VERSION: '${{ inputs.version }}',
		BASE: '${{ inputs.base }}',
		INSTALL: '${{ inputs.install }}',
		GH_TOKEN: '${{ steps.app-token.outputs.token }}',
		STACK_APP_SLUG: '${{ steps.app-token.outputs.app-slug }}',
	});
	expect(callStep?.if).toBeUndefined();
});

test('sync.yml ждёт версию stack до bunx и с тем же VERSION', () => {
	expect(waitIdx).toBeGreaterThanOrEqual(0);
	expect(callIdx).toBeGreaterThan(waitIdx);
	expect(waitStep?.env?.VERSION).toBe('${{ inputs.version }}');
	expect(callStep?.env?.VERSION).toBe('${{ inputs.version }}');
});

test('шаг ожидания — короткая страховка: ATTEMPTS 12', () => {
	expect(waitStep?.env?.ATTEMPTS).toBe('12');
});

test('шаг ожидания выходит на первой попытке, когда версия stack в реестре и tarball отдаётся', () => {
	const r = runWait(has, '3');
	expect(r.status).toBe(0);
	expect(r.calls).toStrictEqual(['stack', `HEAD ${TARBALL}`]);
	expect(r.sleeps).toStrictEqual([]);
});

test('версия в packument, tarball 404 — ждёт и падает после ATTEMPTS попыток', () => {
	const r = runWait(has, '3', '0', 404);
	expect(r.status).toBe(1);
	expect(r.calls).toStrictEqual([
		'stack',
		`HEAD ${TARBALL}`,
		'stack',
		`HEAD ${TARBALL}`,
		'stack',
		`HEAD ${TARBALL}`,
	]);
	expect(r.out).toContain('@alxwlw/stack@1.2.3');
});

test('версия без dist.tarball — HEAD не уходит', () => {
	const r = runWait(noTarball, '2');
	expect(r.status).toBe(1);
	expect(r.calls).toStrictEqual(['stack', 'stack']);
});

test('шаг ожидания спит INTERVAL только между попытками', () => {
	const r = runWait(lacks, '3', '7');
	expect(r.status).toBe(1);
	expect(r.sleeps).toEqual(['7', '7']);
});

test('шаг ожидания падает после ATTEMPTS попыток и называет версию', () => {
	const r = runWait(lacks, '3');
	expect(r.status).toBe(1);
	expect(r.calls).toEqual(['stack', 'stack', 'stack']);
	expect(r.out).toContain('@alxwlw/stack@1.2.3');
});

test('шаг ожидания не принимает упавший запрос к реестру за наличие версии', () => {
	const r = runWait(undefined, '2');
	expect(r.status).toBe(1);
	expect(r.calls).toHaveLength(2);
});

test('шаг вызова: base пустой, install true — bunx @alxwlw/stack@1.2.3 sync-pr --base=', () => {
	const r = runCall({ INSTALL: 'true', BASE: '' });
	expect(r.status).toBe(0);
	expect(r.args).toEqual(['@alxwlw/stack@1.2.3', 'sync-pr', '--base=']);
});

test('шаг вызова: install false от старой копии канон-файла — --no-install', () => {
	const r = runCall({ INSTALL: 'false', BASE: 'staging' });
	expect(r.args).toEqual(['@alxwlw/stack@1.2.3', 'sync-pr', '--base=staging', '--no-install']);
});

test('шаг вызова: bunx вышел с 2 — шаг вышел с 2', () => {
	expect(runCall({ INSTALL: 'true', BASE: '' }, 2).status).toBe(2);
});
