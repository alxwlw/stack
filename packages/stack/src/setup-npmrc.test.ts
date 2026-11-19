import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test } from 'bun:test';
import { parse as parseYaml } from 'yaml';

import { protoBin } from './testkit.ts';

const ROOT = join(import.meta.dir, '..', '..', '..');

// DX-211 (DP-662): на self-hosted раннере ~/.npmrc живёт между джобами всех репозиториев. Шаг токена
// дописывал туда свою строку, только если её там ещё не было, — и строка того же реестра от другого
// джоба (sync.yml с ${STACK_REGISTRY_TOKEN}) оставалась последней: pnpm брал её, ci потребителя с
// GT_READ получал 401. Шаг гоняется в bash как есть, последняя проверка — настоящим pnpm.
type Step = { name?: string; run?: string; env?: Record<string, string> };
const steps =
	(
		parseYaml(readFileSync(join(ROOT, '.github', 'actions', 'setup', 'action.yml'), 'utf8')) as {
			runs?: { steps?: Step[] };
		}
	).runs?.steps ?? [];
const tokenStep = steps.find((s) => s.env?.DEFAULT_TOKEN_VAR !== undefined);
const DEFAULT = tokenStep?.env?.DEFAULT_TOKEN_VAR ?? '';

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Job = { home: string; temp: string; githubEnv: string };

/** Свежий джоб: HOME (с ~/.npmrc, если он задан), RUNNER_TEMP и пустой файл GITHUB_ENV. */
function job(homeNpmrc?: string): Job {
	const dir = mkdtempSync(join(tmpdir(), 'setup-npmrc-'));
	dirs.push(dir);
	const home = join(dir, 'home');
	const temp = join(dir, 'temp');
	mkdirSync(home);
	mkdirSync(temp);
	if (homeNpmrc !== undefined) writeFileSync(join(home, '.npmrc'), homeNpmrc);
	const githubEnv = join(dir, 'github_env');
	writeFileSync(githubEnv, '');
	return { home, temp, githubEnv };
}

/** Шаг токена, как раннер зовёт composite-шаг с `shell: bash`; `env` — входы шага и окружение джоба. */
function runStep(
	j: Job,
	env: Record<string, string>,
): { status: number | null; stderr: string; exported: Record<string, string> } {
	const res = spawnSync(
		'bash',
		['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', tokenStep?.run ?? 'exit 99'],
		{
			env: {
				PATH: process.env.PATH ?? '',
				HOME: j.home,
				RUNNER_TEMP: j.temp,
				GITHUB_ENV: j.githubEnv,
				DEFAULT_TOKEN_VAR: DEFAULT,
				REGISTRY: '',
				TOKEN_VAR: '',
				...env,
			},
			encoding: 'utf8',
		},
	);
	const exported = Object.fromEntries(
		readFileSync(j.githubEnv, 'utf8')
			.split('\n')
			.filter(Boolean)
			.map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
	);
	return { status: res.status, stderr: res.stderr, exported };
}

const lines = (path: string): string[] => readFileSync(path, 'utf8').split('\n').filter(Boolean);

test('шаг токена найден в action.yml, умолчание — STACK_REGISTRY_TOKEN', () => {
	expect(tokenStep?.run).toBeString();
	expect(DEFAULT).toBe('STACK_REGISTRY_TOKEN');
});

test('без ~/.npmrc: файл джоба с одной строкой токена, путь в GITHUB_ENV, ~/.npmrc не создан', () => {
	const j = job();
	const r = runStep(j, { REGISTRY: 'npm.pkg.github.com' });
	expect(r.status).toBe(0);
	const own = join(j.temp, 'stack-setup.npmrc');
	expect(r.exported).toStrictEqual({ NPM_CONFIG_USERCONFIG: own });
	expect(lines(own)).toStrictEqual(['//npm.pkg.github.com/:_authToken=${STACK_REGISTRY_TOKEN}']);
	expect(existsSync(join(j.home, '.npmrc'))).toBe(false);
});

test('строки того же реестра в ~/.npmrc от других джобов уходят из файла джоба, прочее остаётся, ~/.npmrc не тронут', () => {
	const shared = [
		'@acme:registry=https://npm.pkg.github.com',
		'//npm.pkg.github.com/:_authToken=${GT_READ}',
		'//registry.example/:_authToken=${OTHER}',
		// Последней — строка другого джоба, с пробелами вокруг `=`: ключ тот же.
		'//npm.pkg.github.com/:_authToken = ${STACK_REGISTRY_TOKEN}',
		'',
	].join('\n');
	const j = job(shared);
	// Значения переменных в окружении шага: в файл джоба уходит только ссылка ${GT_READ}.
	const r = runStep(j, {
		REGISTRY: 'npm.pkg.github.com',
		TOKEN_VAR: 'GT_READ',
		GT_READ: 'secret-value-gt',
		STACK_REGISTRY_TOKEN: 'secret-value-default',
	});
	expect(r.status).toBe(0);
	expect(readFileSync(r.exported.NPM_CONFIG_USERCONFIG ?? '', 'utf8')).not.toContain(
		'secret-value',
	);
	expect(lines(r.exported.NPM_CONFIG_USERCONFIG ?? '')).toStrictEqual([
		'@acme:registry=https://npm.pkg.github.com',
		'//registry.example/:_authToken=${OTHER}',
		'//npm.pkg.github.com/:_authToken=${GT_READ}',
	]);
	expect(readFileSync(join(j.home, '.npmrc'), 'utf8')).toBe(shared);
});

test('второй вызов в том же джобе берёт за основу файл джоба: строки обоих реестров на месте', () => {
	const j = job('//a.example/:_authToken=${STALE}\n');
	const first = runStep(j, { REGISTRY: 'a.example', TOKEN_VAR: 'A' });
	expect(first.status).toBe(0);
	const own = first.exported.NPM_CONFIG_USERCONFIG ?? '';
	const second = runStep(j, {
		REGISTRY: 'b.example:4873',
		TOKEN_VAR: 'B',
		NPM_CONFIG_USERCONFIG: own,
	});
	expect(second.status).toBe(0);
	expect(second.exported.NPM_CONFIG_USERCONFIG).toBe(own);
	expect(lines(own)).toStrictEqual([
		'//a.example/:_authToken=${A}',
		'//b.example:4873/:_authToken=${B}',
	]);
});

test('registry-token-var без registry и неверное имя переменной — ошибка, ничего не экспортировано', () => {
	const cases: Record<string, string>[] = [
		{ TOKEN_VAR: 'GT_READ' },
		{ REGISTRY: 'npm.pkg.github.com', TOKEN_VAR: 'GT-READ' },
	];
	for (const env of cases) {
		const j = job();
		const r = runStep(j, env);
		expect({ env, status: r.status, exported: r.exported }).toStrictEqual({
			env,
			status: 1,
			exported: {},
		});
	}
});

// Сквозной тест держит главное — pnpm читает файл джоба, а не ~/.npmrc. Фильтр чужих строк он не
// держит (своя строка в файле джоба и так последняя): это делает тест точного списка строк выше.
test('pnpm шлёт токен этого джоба, хотя последняя строка ключа в ~/.npmrc — чужая', async () => {
	const seen: (string | null)[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		fetch(req: Request): Response {
			seen.push(req.headers.get('authorization'));
			const tarball = new URL('/@probe/pkg/-/pkg-1.0.0.tgz', req.url).href;
			return Response.json({
				name: '@probe/pkg',
				'dist-tags': { latest: '1.0.0' },
				versions: {
					'1.0.0': {
						name: '@probe/pkg',
						version: '1.0.0',
						dist: { tarball, shasum: '0'.repeat(40) },
					},
				},
				time: { '1.0.0': '2020-01-01T00:00:00.000Z' },
			});
		},
	});
	try {
		const host = `127.0.0.1:${server.port}`;
		// Как на раннере после sync: своя строка уже есть, чужая дописана после неё.
		const j = job(`//${host}/:_authToken=\${GOOD}\n//${host}/:_authToken=\${STALE}\n`);
		const r = runStep(j, { REGISTRY: host, TOKEN_VAR: 'GOOD' });
		expect(r.status).toBe(0);
		const project = join(j.temp, 'project');
		mkdirSync(project);
		writeFileSync(join(project, 'package.json'), '{"name":"probe","version":"0.0.0"}\n');
		writeFileSync(join(project, '.npmrc'), `@probe:registry=http://${host}/\n`);
		// На раннере `pnpm` в PATH — шим proto: во временном каталоге с чужим HOME он не находит версию.
		// Настоящий бинарник по пину репозитория (protoBin разбирает и NDJSON proto в окружении агента).
		const pnpm = Bun.spawn([protoBin('pnpm'), 'view', '@probe/pkg', 'version'], {
			cwd: project,
			env: {
				PATH: process.env.PATH ?? '',
				HOME: j.home,
				NPM_CONFIG_USERCONFIG: r.exported.NPM_CONFIG_USERCONFIG ?? '',
				GOOD: 'good-token',
				STALE: 'stale-token',
			},
			stdout: 'pipe',
			stderr: 'pipe',
		});
		const [code, out, err] = await Promise.all([
			pnpm.exited,
			new Response(pnpm.stdout).text(),
			new Response(pnpm.stderr).text(),
		]);
		expect({ code, out: out.trim(), err: code === 0 ? '' : err }).toStrictEqual({
			code: 0,
			out: '1.0.0',
			err: '',
		});
		expect(seen.length).toBeGreaterThan(0);
		expect(new Set(seen)).toStrictEqual(new Set(['Bearer good-token']));
	} finally {
		await server.stop(true);
	}
}, 30_000);
