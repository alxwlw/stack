import { afterEach, describe, expect, test } from 'bun:test';

import { npmRegistryReader, type Registry, waitVisible } from './registry.ts';

/**
 * Фейковый реестр: `served` читает множество пар имя и версия, `visibleAfter` — сколько опросов запись «не видна».
 * `has` waitVisible звать не должен: он пишет в журнал, и точный список журнала это ловит.
 */
function fakeRegistry(opts: { present?: string[]; visibleAfter?: Record<string, number> } = {}) {
	const present = new Set(opts.present ?? []);
	const calls: string[] = [];
	const polls = new Map<string, number>();
	const registry: Registry = {
		has(name, version) {
			calls.push(`has ${name}@${version}`);
			return Promise.resolve(true);
		},
		served(name, version) {
			calls.push(`served ${name}@${version}`);
			const n = (polls.get(name) ?? 0) + 1;
			polls.set(name, n);
			const after = opts.visibleAfter?.[name];
			return Promise.resolve(
				present.has(`${name}@${version}`) || (after !== undefined && n >= after)
					? 'served'
					: 'unlisted',
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
		const registry: Registry = {
			has: () => Promise.resolve(false),
			served: async (n, v) => (calls.push(`${n}@${v}`), 'served'),
		};
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
		const registry: Registry = {
			has: () => Promise.resolve(false),
			served: async (n, v) => (calls.push(`${n}@${v}`), 'served'),
		};
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
		const registry: Registry = {
			has: () => Promise.resolve(false),
			served: async (n) => (n === '@acme/a' ? 'served' : 'unlisted'),
		};
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
		).rejects.toThrow(
			'за 3 попыток в реестре не появились версии: @acme/b@2.0.0 (нет в packument), @acme/c@2.0.0 (нет в packument)',
		);
		expect(slept).toBe(2);
	});

	test('всё видно с первой попытки — один опрос на запись', async () => {
		const { registry, calls } = fakeRegistry({ present: ['@x/a@1.0.0', '@x/b@1.0.0'] });
		await waitVisible(wanted('@x/a', '@x/b'), registry, {
			attempts: 5,
			intervalMs: 1,
			sleep: noSleep,
		});
		expect(calls).toEqual(['served @x/a@1.0.0', 'served @x/b@1.0.0']);
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
		expect(calls).toEqual([
			'served @x/a@1.0.0',
			'served @x/b@1.0.0',
			'served @x/b@1.0.0',
			'served @x/b@1.0.0',
		]);
		expect(sleeps).toEqual([7, 7]);
	});

	test('без подставного sleep: версия видна на 2-м опросе — разрешается', async () => {
		const { registry, calls } = fakeRegistry({ visibleAfter: { '@x/a': 2 } });
		await waitVisible(wanted('@x/a'), registry, { attempts: 3, intervalMs: 1 });
		expect(calls).toEqual(['served @x/a@1.0.0', 'served @x/a@1.0.0']);
	});
});

describe('waitVisible: сбои реестра', () => {
	const noSleep = (): Promise<void> => Promise.resolve();

	test("served бросает на первой попытке и отдаёт 'served' на второй — ожидание завершается", async () => {
		let n = 0;
		const registry: Registry = {
			has: () => Promise.resolve(false),
			served: () => (++n === 1 ? Promise.reject(new Error('500')) : Promise.resolve('served')),
		};
		await waitVisible(wanted('@x/a'), registry, { attempts: 3, intervalMs: 1, sleep: noSleep });
		expect(n).toBe(2);
	});

	test('served бросает всегда — после попыток ошибка перечисляет запись', async () => {
		let n = 0;
		const registry: Registry = {
			has: () => Promise.resolve(false),
			served: () => {
				n++;
				return Promise.reject(new Error('500'));
			},
		};
		await expect(
			waitVisible(wanted('@x/a'), registry, { attempts: 3, intervalMs: 1, sleep: noSleep }),
		).rejects.toThrow('за 3 попыток в реестре не появились версии: @x/a@1.0.0 (500)');
		expect(n).toBe(3);
	});
});

describe('waitVisible: причина провала', () => {
	test('причина — последней попытки', async () => {
		let n = 0;
		const registry: Registry = {
			has: () => Promise.resolve(false),
			served: async () => (++n === 1 ? 'unlisted' : 'no-tarball'),
		};
		await expect(
			waitVisible(wanted('@x/a'), registry, {
				attempts: 2,
				intervalMs: 1,
				sleep: () => Promise.resolve(),
			}),
		).rejects.toThrow(
			'за 2 попыток в реестре не появились версии: @x/a@1.0.0 (в packument есть, tarball не отдаётся)',
		);
	});

	test('tarball 404 до конца попыток — не «готово»', async () => {
		let n = 0;
		const registry: Registry = {
			has: () => Promise.resolve(false),
			served: async () => (n++, 'no-tarball'),
		};
		await expect(
			waitVisible(wanted('@x/a'), registry, {
				attempts: 2,
				intervalMs: 1,
				sleep: () => Promise.resolve(),
			}),
		).rejects.toThrow('не появились версии');
		expect(n).toBe(2);
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

	test('200 с телом null или [] — has и served бросают с именем пакета, HEAD не уходит', async () => {
		for (const body of ['null', '[]']) {
			const msg = '@alxwlw/stack: нечитаемый ответ реестра: не объект';
			stub(new Response(body, { status: 200 }));
			await expect(reg.has('@alxwlw/stack', '1.2.3')).rejects.toThrow(msg);
			const log: string[] = [];
			globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
				log.push(`${init?.method ?? 'GET'} ${String(input)}`);
				return Promise.resolve(new Response(body, { status: 200 }));
			}) as typeof fetch;
			await expect(reg.served('@alxwlw/stack', '1.2.3')).rejects.toThrow(msg);
			expect(log).toStrictEqual(['GET https://registry.npmjs.org/@alxwlw%2fstack']);
		}
	});

	test('сбой сети — throw с именем пакета', async () => {
		stub(new Error('ECONNRESET'));
		await expect(reg.has('@alxwlw/stack', '1.2.3')).rejects.toThrow('@alxwlw/stack');
	});
});

describe('npmRegistryReader.served', () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});
	const PACKUMENT_URL = 'https://registry.npmjs.org/@alxwlw%2fstack';
	const TARBALL = 'https://registry.npmjs.org/@alxwlw/stack/-/stack-1.2.3.tgz';
	const withTarball = JSON.stringify({ versions: { '1.2.3': { dist: { tarball: TARBALL } } } });
	/** `fetch` различает запрос по URL: packument — JSON, tarball — заданный ответ; журнал `МЕТОД url`. */
	const stub = (opts: { packument?: Response; tarball?: Response | Error }): string[] => {
		const log: string[] = [];
		globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			// Метка «+headers» на HEAD: проба не должна нести своих заголовков (кэш-заголовки ломают смысл замера).
			log.push(
				`${init?.method ?? 'GET'} ${url}${init?.method === 'HEAD' && init.headers ? ' +headers' : ''}`,
			);
			if (url === PACKUMENT_URL) {
				return Promise.resolve(opts.packument ?? new Response(withTarball, { status: 200 }));
			}
			if (url === TARBALL) {
				const t = opts.tarball ?? new Response(null, { status: 200 });
				return t instanceof Error ? Promise.reject(t) : Promise.resolve(t);
			}
			return Promise.reject(new Error(`неожиданный запрос ${url}`));
		}) as typeof fetch;
		return log;
	};
	const reg = npmRegistryReader();

	test("версия в packument, tarball 200 — 'served'; HEAD уходит ровно на dist.tarball", async () => {
		const log = stub({ tarball: new Response(null, { status: 200 }) });
		expect(await reg.served('@alxwlw/stack', '1.2.3')).toBe('served');
		expect(log).toStrictEqual([`GET ${PACKUMENT_URL}`, `HEAD ${TARBALL}`]);
	});

	test("tarball 404 — 'no-tarball'", async () => {
		stub({ tarball: new Response(null, { status: 404 }) });
		expect(await reg.served('@alxwlw/stack', '1.2.3')).toBe('no-tarball');
	});

	test("версии нет в packument — 'unlisted', HEAD не уходит", async () => {
		const log = stub({});
		expect(await reg.served('@alxwlw/stack', '9.9.9')).toBe('unlisted');
		expect(log).toStrictEqual([`GET ${PACKUMENT_URL}`]);
	});

	test("packument 404 — 'unlisted', HEAD не уходит", async () => {
		const log = stub({ packument: new Response('{}', { status: 404 }) });
		expect(await reg.served('@alxwlw/stack', '1.2.3')).toBe('unlisted');
		expect(log).toStrictEqual([`GET ${PACKUMENT_URL}`]);
	});

	test("у версии нет dist.tarball или он не строка — 'unlisted', HEAD не уходит", async () => {
		for (const body of [
			'{"versions":{"1.2.3":{}}}',
			'{"versions":{"1.2.3":{"dist":{"tarball":7}}}}',
		]) {
			const log = stub({ packument: new Response(body, { status: 200 }) });
			expect(await reg.served('@alxwlw/stack', '1.2.3')).toBe('unlisted');
			expect(log).toStrictEqual([`GET ${PACKUMENT_URL}`]);
		}
	});

	test('tarball 500 — throw с @alxwlw/stack@1.2.3', async () => {
		stub({ tarball: new Response(null, { status: 500 }) });
		await expect(reg.served('@alxwlw/stack', '1.2.3')).rejects.toThrow(
			'@alxwlw/stack@1.2.3: tarball ответил 500',
		);
	});

	test('сбой сети на HEAD — throw с @alxwlw/stack@1.2.3', async () => {
		stub({ tarball: new Error('ECONNRESET') });
		await expect(reg.served('@alxwlw/stack', '1.2.3')).rejects.toThrow(
			'@alxwlw/stack@1.2.3: tarball недоступен: ECONNRESET',
		);
	});

	test('зависший HEAD обрывается по таймауту — throw', async () => {
		// Packument отвечает сразу, HEAD не отвечает никогда, но уважает signal — как настоящий fetch.
		// Страховка: без signal он сам отклоняется через 2 с, и тест краснеет по содержимому, а не виснет.
		globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
			if (String(input) === PACKUMENT_URL) {
				return Promise.resolve(new Response(withTarball, { status: 200 }));
			}
			return new Promise((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
				setTimeout(() => reject(new Error('сигнал не сработал')), 2000);
			});
		}) as typeof fetch;
		const e = await npmRegistryReader(50)
			.served('@alxwlw/stack', '1.2.3')
			.then(
				() => undefined,
				(x: unknown) => x,
			);
		expect(String(e)).toContain('@alxwlw/stack@1.2.3: tarball недоступен: aborted');
	});
});
