import { createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'bun:test';

import {
	consoleOutput,
	dispatchSync,
	getInstallations,
	getInstallationToken,
	type GitHubApi,
	githubApi,
	type Installation,
	pickInstallation,
	rollout,
	type RolloutOutput,
	runRollout,
	signAppJwt,
} from './rollout.ts';

test('pickInstallation: находит установку по владельцу репозитория', () => {
	const installations: Installation[] = [
		{ id: 1, login: 'acme' },
		{ id: 2, login: 'other-org' },
	];
	expect(pickInstallation(installations, 'acme/app')?.id).toBe(1);
});

test('pickInstallation: сравнение регистронезависимое — GitHub гарантирует уникальность логина без учёта регистра', () => {
	const installations: Installation[] = [{ id: 1, login: 'Acme' }];
	expect(pickInstallation(installations, 'acme/app')?.id).toBe(1);
});

test('pickInstallation: владелец не установлен — undefined, а не первая попавшаяся установка', () => {
	const installations: Installation[] = [{ id: 1, login: 'acme' }];
	expect(pickInstallation(installations, 'unknown-owner/app')).toBeUndefined();
});

// Выдуманный список установок и потребителей — сеть не трогается.
test('rollout: dispatched/failed считаются по подобранному токену, без сети', async () => {
	const installations: Installation[] = [{ id: 1, login: 'acme' }];
	const dispatchedRepos: string[] = [];
	const result = await rollout(['acme/app', 'unknown-owner/app'], installations, '1.2.3', {
		getToken: async (id) => `token-for-${id}`,
		dispatch: async (repo) => {
			dispatchedRepos.push(repo);
		},
	});
	expect(result).toEqual({ dispatched: 1, failed: 1 });
	expect(dispatchedRepos).toEqual(['acme/app']);
});

interface Harness {
	calls: string[];
	logs: string[];
	summaries: string[];
	github: GitHubApi;
	out: RolloutOutput;
	dispatched: { repo: string; version: string }[];
	args: string[];
}

// Фейковый порт: каждый вызов пишется в журнал, сеть не трогается.
function harness(dispatchSync?: (repo: string) => Promise<void>): Harness {
	const h: Harness = {
		calls: [],
		logs: [],
		summaries: [],
		dispatched: [],
		args: [],
		github: {
			signAppJwt: (appId, key) => {
				h.calls.push('signAppJwt');
				h.args.push(`sign:${appId}:${key}`);
				return 'jwt';
			},
			getInstallations: async () => {
				h.calls.push('getInstallations');
				return [{ id: 1, login: 'acme' }];
			},
			getInstallationToken: async (id, jwt) => {
				h.calls.push('getInstallationToken');
				h.args.push(`token:${id}:${jwt}`);
				return 'tok';
			},
			dispatchSync: async (repo, _token, version) => {
				h.calls.push('dispatchSync');
				await dispatchSync?.(repo);
				h.dispatched.push({ repo, version });
			},
		},
		out: { log: (l) => h.logs.push(l), summary: (l) => h.summaries.push(l) },
	};
	return h;
}

const SECRETS = { STACK_BOT_APP_ID: '1', STACK_BOT_PRIVATE_KEY: 'pem' };

test('runRollout: пустой CONSUMERS — успех без секретов, GitHub не вызывается', async () => {
	const h = harness();
	const result = await runRollout({ VERSION: 'v1.2.3', CONSUMERS: '\n  \n' }, h.github, h.out);
	expect(result).toBeNull();
	expect(h.calls).toEqual([]);
	expect(h.logs).toEqual(['no consumers configured — nothing to roll out']);
	expect(h.summaries).toEqual([]);
});

test('runRollout: непустой CONSUMERS без секретов — ошибка до вызова GitHub', async () => {
	const h = harness();
	await expect(
		runRollout({ VERSION: '1.2.3', CONSUMERS: 'acme/app' }, h.github, h.out),
	).rejects.toThrow('STACK_BOT_APP_ID/STACK_BOT_PRIVATE_KEY are not set');
	expect(h.calls).toEqual([]);
});

// Публичный репозиторий: имена репозиториев-потребителей не должны попасть в вывод, даже когда
// сам dispatch падает с ошибкой, чьё сообщение несёт имя репозитория.
test('runRollout: вывод и summary не содержат имён потребителей', async () => {
	const h = harness(async (repo) => {
		throw new Error(`dispatch to ${repo} failed`);
	});
	const result = await runRollout(
		{ VERSION: '1.2.3', CONSUMERS: 'acme/secret-internal-name', ...SECRETS },
		h.github,
		h.out,
	);
	expect(result).toEqual({ dispatched: 0, failed: 1 });
	expect(h.logs).toEqual(['dispatched: 0, failed: 1']);
	expect(h.summaries).toEqual(['dispatched: 0, failed: 1']);
	expect([...h.logs, ...h.summaries].join('\n')).not.toContain('secret-internal-name');
});

test('runRollout: VERSION с префиксом v доходит до dispatch без него', async () => {
	const h = harness();
	const result = await runRollout(
		{ VERSION: 'v1.2.3', CONSUMERS: 'acme/app', ...SECRETS },
		h.github,
		h.out,
	);
	expect(result).toEqual({ dispatched: 1, failed: 0 });
	expect(h.dispatched).toEqual([{ repo: 'acme/app', version: '1.2.3' }]);
	expect(h.calls).toEqual([
		'signAppJwt',
		'getInstallations',
		'getInstallationToken',
		'dispatchSync',
	]);
});

test('consoleOutput: summary дописывает строку в файл GITHUB_STEP_SUMMARY', () => {
	const dir = mkdtempSync(join(tmpdir(), 'rollout-'));
	try {
		const path = join(dir, 'summary.md');
		consoleOutput(path).summary('x');
		expect(readFileSync(path, 'utf8')).toBe('x\n');
		consoleOutput(path).summary('y');
		expect(readFileSync(path, 'utf8')).toBe('x\ny\n');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('runRollout: JWT подписывается ключами из env и доходит до обмена токена', async () => {
	const h = harness();
	await runRollout(
		{
			VERSION: '1.2.3',
			CONSUMERS: 'acme/app',
			STACK_BOT_APP_ID: '77',
			STACK_BOT_PRIVATE_KEY: 'pem-x',
		},
		h.github,
		h.out,
	);
	expect(h.args).toEqual(['sign:77:pem-x', 'token:1:jwt']);
});

test('runRollout: не хватает одного из секретов — ошибка до вызова GitHub', async () => {
	for (const env of [{ STACK_BOT_APP_ID: '1' }, { STACK_BOT_PRIVATE_KEY: 'pem' }]) {
		const h = harness();
		await expect(
			runRollout({ VERSION: '1.2.3', CONSUMERS: 'acme/app', ...env }, h.github, h.out),
		).rejects.toThrow('are not set');
		expect(h.calls).toEqual([]);
	}
});

test('runRollout: CONSUMERS не задан — потребителей нет, а не TypeError', async () => {
	const h = harness();
	expect(await runRollout({ VERSION: '1.2.3' }, h.github, h.out)).toBeNull();
	expect(h.calls).toEqual([]);
});

test('runRollout: VERSION не задан — ошибка о теге, а не TypeError, до вызова GitHub', async () => {
	const h = harness();
	await expect(runRollout({ CONSUMERS: 'acme/app', ...SECRETS }, h.github, h.out)).rejects.toThrow(
		'not a version tag',
	);
	expect(h.calls).toEqual([]);
});

test('githubApi: прод-adapter — те самые четыре функции', () => {
	expect(githubApi.signAppJwt).toBe(signAppJwt);
	expect(githubApi.getInstallations).toBe(getInstallations);
	expect(githubApi.getInstallationToken).toBe(getInstallationToken);
	expect(githubApi.dispatchSync).toBe(dispatchSync);
});

test('consoleOutput: log печатает строку в console.log', () => {
	const lines: string[] = [];
	const original = console.log;
	console.log = (...args: unknown[]) => {
		lines.push(args.map(String).join(' '));
	};
	try {
		consoleOutput(undefined).log('hello');
	} finally {
		console.log = original;
	}
	expect(lines).toEqual(['hello']);
});

test('consoleOutput: без пути summary ничего не пишет и не падает', () => {
	expect(() => consoleOutput(undefined).summary('x')).not.toThrow();
});

test('signAppJwt: валидная RS256-подпись, iss/iat/exp выставлены', () => {
	const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
	const privatePem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
	const now = 1_700_000_000;
	const jwt = signAppJwt('12345', privatePem, now);
	const [headerB64, payloadB64, sigB64] = jwt.split('.');
	expect(headerB64).toBeDefined();
	expect(payloadB64).toBeDefined();
	expect(sigB64).toBeDefined();
	const header = JSON.parse(Buffer.from(headerB64 as string, 'base64url').toString()) as {
		alg: string;
	};
	const payload = JSON.parse(Buffer.from(payloadB64 as string, 'base64url').toString()) as {
		iss: string;
		iat: number;
		exp: number;
	};
	expect(header.alg).toBe('RS256');
	expect(payload.iss).toBe('12345');
	expect(payload.iat).toBe(now - 60);
	expect(payload.exp).toBe(now + 600);
	const verifier = createVerify('RSA-SHA256').update(`${headerB64}.${payloadB64}`);
	expect(verifier.verify(publicKey, Buffer.from(sigB64 as string, 'base64url'))).toBe(true);
});

// Строка `import.meta.main` исполняется только при запуске файла как скрипта — гоняем его
// подпроцессом. Env собран явно: секреты и GITHUB_STEP_SUMMARY раннера не протекают.
function runScript(env: Record<string, string>) {
	const script = fileURLToPath(new URL('./rollout.ts', import.meta.url));
	return Bun.spawnSync([process.execPath, script], {
		env: { PATH: process.env.PATH ?? '', ...env },
		stdout: 'pipe',
		stderr: 'pipe',
	});
}

test('rollout.ts как скрипт: пустой CONSUMERS — вход вызван, лог о пустом списке, код 0', () => {
	const res = runScript({ VERSION: 'v1.2.3', CONSUMERS: '' });
	expect(res.stdout.toString()).toContain('no consumers configured');
	expect(res.exitCode).toBe(0);
});

test('rollout.ts как скрипт: CONSUMERS без секретов — ненулевой код выхода', () => {
	const res = runScript({ VERSION: 'v1.2.3', CONSUMERS: 'acme/app' });
	expect(res.stderr.toString()).toContain('are not set');
	expect(res.exitCode).not.toBe(0);
});
