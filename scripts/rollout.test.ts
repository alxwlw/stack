import { createVerify, generateKeyPairSync } from 'node:crypto';

import { expect, test } from 'bun:test';

import {
	type Installation,
	pickInstallation,
	rollout,
	signAppJwt,
	stripTagPrefix,
} from './rollout.ts';

test('stripTagPrefix: срезает префикс v тега перед сравнением с semver', () => {
	expect(stripTagPrefix('v1.2.3')).toBe('1.2.3');
	expect(stripTagPrefix('1.2.3')).toBe('1.2.3');
});

test('stripTagPrefix: плавающий major-тег и мусор — ошибка, а не молчаливая рассылка', () => {
	expect(() => stripTagPrefix('v1')).toThrow();
	expect(() => stripTagPrefix('main')).toThrow();
});

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

// Публичный репозиторий: имена репозиториев-потребителей не должны попасть в вывод, даже когда
// сам dispatch падает с ошибкой, чьё сообщение несёт имя репозитория.
test('rollout: имя репозитория не попадает в вывод, даже если dispatch бросает ошибку с этим именем', async () => {
	const installations: Installation[] = [{ id: 1, login: 'acme' }];
	const logs: string[] = [];
	const originalLog = console.log;
	console.log = (...args: unknown[]) => {
		logs.push(args.map(String).join(' '));
	};
	let result: { dispatched: number; failed: number };
	try {
		result = await rollout(['acme/secret-internal-name'], installations, '1.2.3', {
			getToken: async () => 'tok',
			dispatch: async (repo) => {
				throw new Error(`dispatch to ${repo} failed`);
			},
		});
		console.log(`dispatched: ${result.dispatched}, failed: ${result.failed}`);
	} finally {
		console.log = originalLog;
	}
	expect(result).toEqual({ dispatched: 0, failed: 1 });
	expect(logs.join('\n')).not.toContain('secret-internal-name');
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
