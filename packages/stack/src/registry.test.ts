import { afterEach, describe, expect, test } from 'bun:test';

import { npmRegistryReader, type Registry, waitVisible } from './registry.ts';

/** Фейковый реестр: `has` читает множество пар имя и версия, `visibleAfter` — сколько опросов запись «не видна». */
function fakeRegistry(opts: { present?: string[]; visibleAfter?: Record<string, number> } = {}) {
	const present = new Set(opts.present ?? []);
	const calls: string[] = [];
	const polls = new Map<string, number>();
	const registry: Registry = {
		has(name, version) {
			calls.push(`has ${name}@${version}`);
			const n = (polls.get(name) ?? 0) + 1;
			polls.set(name, n);
			const after = opts.visibleAfter?.[name];
			return Promise.resolve(
				present.has(`${name}@${version}`) || (after !== undefined && n >= after),
			);
		},
	};
	return { registry, calls };
}

const wanted = (...names: string[]) => names.map((name) => ({ name, version: '1.0.0' }));

describe('waitVisible', () => {
	const noSleep = (): Promise<void> => Promise.resolve();

	test('пустой список — разрешается без опроса и без sleep', async () => {
		const calls: string[] = [];
		const registry: Registry = { has: async (n, v) => (calls.push(`${n}@${v}`), true) };
		let slept = 0;
		await waitVisible([], registry, {
			attempts: 3,
			intervalMs: 1,
			sleep: async () => void slept++,
		});
		expect(calls).toEqual([]);
		expect(slept).toBe(0);
	});

	test('каждая запись опрашивается своей версией', async () => {
		const calls: string[] = [];
		const registry: Registry = { has: async (n, v) => (calls.push(`${n}@${v}`), true) };
		await waitVisible(
			[
				{ name: '@acme/a', version: '1.0.0' },
				{ name: '@acme/b', version: '2.0.0' },
			],
			registry,
			{ attempts: 1, intervalMs: 0 },
		);
		expect(calls).toEqual(['@acme/a@1.0.0', '@acme/b@2.0.0']);
	});

	test('попытки кончились — ошибка называет имя@версию каждой невидимой записи, sleep между попытками', async () => {
		let slept = 0;
		const registry: Registry = { has: async (n) => n === '@acme/a' };
		await expect(
			waitVisible(
				[
					{ name: '@acme/a', version: '1.0.0' },
					{ name: '@acme/b', version: '2.0.0' },
					{ name: '@acme/c', version: '2.0.0' },
				],
				registry,
				{ attempts: 3, intervalMs: 5, sleep: async () => void slept++ },
			),
		).rejects.toThrow('за 3 попыток в реестре не появились версии: @acme/b@2.0.0 @acme/c@2.0.0');
		expect(slept).toBe(2);
	});

	test('всё видно с первой попытки — один опрос на запись', async () => {
		const { registry, calls } = fakeRegistry({ present: ['@x/a@1.0.0', '@x/b@1.0.0'] });
		await waitVisible(wanted('@x/a', '@x/b'), registry, {
			attempts: 5,
			intervalMs: 1,
			sleep: noSleep,
		});
		expect(calls).toEqual(['has @x/a@1.0.0', 'has @x/b@1.0.0']);
	});

	test('пакет появился на третьей попытке — видимые не опрашиваются повторно', async () => {
		const { registry, calls } = fakeRegistry({
			present: ['@x/a@1.0.0'],
			visibleAfter: { '@x/b': 3 },
		});
		const sleeps: number[] = [];
		await waitVisible(wanted('@x/a', '@x/b'), registry, {
			attempts: 5,
			intervalMs: 7,
			sleep: (ms) => {
				sleeps.push(ms);
				return Promise.resolve();
			},
		});
		expect(calls).toEqual(['has @x/a@1.0.0', 'has @x/b@1.0.0', 'has @x/b@1.0.0', 'has @x/b@1.0.0']);
		expect(sleeps).toEqual([7, 7]);
	});

	test('без подставного sleep: версия видна на 2-м опросе — разрешается', async () => {
		const { registry, calls } = fakeRegistry({ visibleAfter: { '@x/a': 2 } });
		await waitVisible(wanted('@x/a'), registry, { attempts: 3, intervalMs: 1 });
		expect(calls).toEqual(['has @x/a@1.0.0', 'has @x/a@1.0.0']);
	});
});

describe('waitVisible: сбои реестра', () => {
	const noSleep = (): Promise<void> => Promise.resolve();

	test('has бросает на первой попытке и отдаёт true на второй — ожидание завершается', async () => {
		let n = 0;
		const registry: Registry = {
			has: () => (++n === 1 ? Promise.reject(new Error('500')) : Promise.resolve(true)),
		};
		await waitVisible(wanted('@x/a'), registry, { attempts: 3, intervalMs: 1, sleep: noSleep });
		expect(n).toBe(2);
	});

	test('has бросает всегда — после попыток ошибка перечисляет запись', async () => {
		let n = 0;
		const registry: Registry = {
			has: () => {
				n++;
				return Promise.reject(new Error('500'));
			},
		};
		await expect(
			waitVisible(wanted('@x/a'), registry, { attempts: 3, intervalMs: 1, sleep: noSleep }),
		).rejects.toThrow('за 3 попыток в реестре не появились версии: @x/a@1.0.0');
		expect(n).toBe(3);
	});
});

describe('npmRegistryReader.has', () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});
	const stub = (res: Response | Error): { urls: string[]; accepts: string[] } => {
		const seen = { urls: [] as string[], accepts: [] as string[] };
		globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
			seen.urls.push(String(input));
			seen.accepts.push(new Headers(init?.headers).get('Accept') ?? '');
			return res instanceof Error ? Promise.reject(res) : Promise.resolve(res);
		}) as typeof fetch;
		return seen;
	};
	const reg = npmRegistryReader();

	test('200 с версией — true, 200 без версии — false, 404 — false, 500 — throw', async () => {
		const doc = JSON.stringify({ versions: { '1.2.3': {} } });
		const seen = stub(new Response(doc, { status: 200 }));
		expect(await reg.has('@alxwlw/stack', '1.2.3')).toBe(true);
		expect(seen.urls).toEqual(['https://registry.npmjs.org/@alxwlw%2fstack']);
		expect(seen.accepts).toEqual([
			'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*',
		]);
		stub(new Response(doc, { status: 200 }));
		expect(await reg.has('@alxwlw/stack', '9.9.9')).toBe(false);
		stub(new Response('{}', { status: 404 }));
		expect(await reg.has('@alxwlw/stack', '1.2.3')).toBe(false);
		stub(new Response('boom', { status: 500 }));
		await expect(reg.has('@alxwlw/stack', '1.2.3')).rejects.toThrow('@alxwlw/stack');
	});

	test('зависший запрос обрывается по таймауту — throw с именем пакета', async () => {
		// Фейковый fetch не отвечает никогда, но уважает signal — как настоящий. Страховка: без
		// signal он сам отклоняется через 2 с, и тест краснеет по содержимому, а не виснет.
		globalThis.fetch = ((_: unknown, init?: RequestInit) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
				setTimeout(() => reject(new Error('сигнал не сработал')), 2000);
			})) as typeof fetch;
		const e = await npmRegistryReader(20)
			.has('@alxwlw/stack', '1.2.3')
			.then(
				() => undefined,
				(x: unknown) => x,
			);
		expect(String(e)).toContain('aborted');
		expect(String(e)).toContain('@alxwlw/stack');
	});

	test('200 не-JSON — throw с именем пакета, а не голый JSON Parse error', async () => {
		stub(new Response('<html>', { status: 200 }));
		await expect(reg.has('@alxwlw/stack', '1.2.3')).rejects.toThrow(
			/^@alxwlw\/stack: нечитаемый ответ реестра: JSON/,
		);
	});

	test('сбой сети — throw с именем пакета', async () => {
		stub(new Error('ECONNRESET'));
		await expect(reg.has('@alxwlw/stack', '1.2.3')).rejects.toThrow('@alxwlw/stack');
	});
});
