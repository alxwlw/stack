import { createSign } from 'node:crypto';
import { appendFileSync } from 'node:fs';

import { SEMVER_RE } from './semver.ts';

const DISPATCH_WORKFLOW = 'stack-sync.yml';
const DISPATCH_REF = 'main';

export interface Installation {
	id: number;
	login: string;
}

export interface RolloutResult {
	dispatched: number;
	failed: number;
}

export interface RolloutDeps {
	getToken: (installationId: number) => Promise<string>;
	dispatch: (repo: string, token: string, version: string) => Promise<void>;
}

/**
 * `github.event.workflow_run.head_branch` для пуша тега — это ИМЯ ТЕГА (`v1.2.3`), не голая
 * версия. `sync.yml` строит из неё `stack/v${VERSION}` — необрезанный префикс даёт `stack/vv1.2.3`
 * (см. docs/release.md, «VERSION приходит с префиксом»). Валидирует результат и падает громко на
 * мусоре, а не молча шлёт его по всем потребителям.
 */
export function stripTagPrefix(tag: string): string {
	const version = tag.startsWith('v') ? tag.slice(1) : tag;
	if (!SEMVER_RE.test(version)) {
		throw new Error(`not a version tag: "${tag}"`);
	}
	return version;
}

/** Установка App, чей `account.login` совпадает с владельцем `owner/repo`, — токеном одной
 * установки нельзя разослать в обе организации потребителей сразу. GitHub гарантирует
 * уникальность логина без учёта регистра, поэтому сравнение регистронезависимое: иначе опечатка
 * в регистре в `STACK_CONSUMERS` молча уходит в `failed`, неотличимо от отсутствующей установки
 * (правило K — без имён в логе диагностировать нечем). */
export function pickInstallation(
	installations: Installation[],
	repo: string,
): Installation | undefined {
	const owner = repo.split('/')[0]?.toLowerCase();
	return installations.find((i) => i.login.toLowerCase() === owner);
}

/**
 * Рассылает `workflow_dispatch` каждому потребителю из `consumers` (`owner/repo` построчно).
 * Печатает и возвращает только счётчики: **ни имя репозитория, ни текст ошибки dispatch не
 * должны попасть в лог публичного репозитория** (репозиторий публичный, см. docs/release.md).
 * Поэтому per-repo сбой гасится в `failed`, а не пробрасывается или логируется.
 */
export async function rollout(
	consumers: string[],
	installations: Installation[],
	version: string,
	deps: RolloutDeps,
): Promise<RolloutResult> {
	let dispatched = 0;
	let failed = 0;
	for (const repo of consumers) {
		try {
			const installation = pickInstallation(installations, repo);
			if (!installation) throw new Error('no installation for owner');
			const token = await deps.getToken(installation.id);
			await deps.dispatch(repo, token, version);
			dispatched += 1;
		} catch {
			// Ошибка (в т.ч. её message) может нести имя репозитория — не логируем её нигде.
			failed += 1;
		}
	}
	return { dispatched, failed };
}

function base64url(input: Buffer | string): string {
	return Buffer.from(input).toString('base64url');
}

/** JWT приложения (RS256, node:crypto) для `GET /app/installations` и обмена на токены установок. */
export function signAppJwt(
	appId: string,
	privateKeyPem: string,
	now: number = Math.floor(Date.now() / 1000),
): string {
	const header = { alg: 'RS256', typ: 'JWT' };
	// iat в прошлом на минуту — терпимость к рассинхрону часов раннера с GitHub, как в доке App.
	const payload = { iat: now - 60, exp: now + 600, iss: appId };
	const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
	const signature = createSign('RSA-SHA256').update(signingInput).sign(privateKeyPem);
	return `${signingInput}.${base64url(signature)}`;
}

async function githubApi(path: string, jwtOrToken: string, method: 'GET' | 'POST', body?: unknown) {
	const res = await fetch(`https://api.github.com${path}`, {
		method,
		headers: {
			authorization: `Bearer ${jwtOrToken}`,
			accept: 'application/vnd.github+json',
			'x-github-api-version': '2022-11-28',
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	if (!res.ok) throw new Error(`GitHub API ${method} ${path}: ${res.status}`);
	return res;
}

export async function getInstallations(jwt: string): Promise<Installation[]> {
	const res = await githubApi('/app/installations', jwt, 'GET');
	const body = (await res.json()) as { id: number; account: { login: string } }[];
	return body.map((i) => ({ id: i.id, login: i.account.login }));
}

export async function getInstallationToken(installationId: number, jwt: string): Promise<string> {
	const res = await githubApi(`/app/installations/${installationId}/access_tokens`, jwt, 'POST');
	const body = (await res.json()) as { token: string };
	return body.token;
}

export async function dispatchSync(repo: string, token: string, version: string): Promise<void> {
	await githubApi(
		`/repos/${repo}/actions/workflows/${DISPATCH_WORKFLOW}/dispatches`,
		token,
		'POST',
		{
			ref: DISPATCH_REF,
			inputs: { version },
		},
	);
}

if (import.meta.main) {
	const appId = process.env.STACK_BOT_APP_ID;
	const privateKey = process.env.STACK_BOT_PRIVATE_KEY;
	if (!appId || !privateKey) {
		throw new Error('STACK_BOT_APP_ID/STACK_BOT_PRIVATE_KEY are not set');
	}
	const version = stripTagPrefix(process.env.VERSION ?? '');
	const consumers = (process.env.CONSUMERS ?? '')
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean);

	const jwt = signAppJwt(appId, privateKey);
	const installations = await getInstallations(jwt);
	const result = await rollout(consumers, installations, version, {
		getToken: (id) => getInstallationToken(id, jwt),
		dispatch: (repo, token, v) => dispatchSync(repo, token, v),
	});

	const summary = `dispatched: ${result.dispatched}, failed: ${result.failed}`;
	console.log(summary);
	if (process.env.GITHUB_STEP_SUMMARY)
		appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
}
