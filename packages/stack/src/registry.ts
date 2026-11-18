// Чтение реестра npm и ожидание, пока в нём появятся версии. Импортирует только `node:*` (здесь —
// ничего): job rollout идёт без установки зависимостей (docs/release.md), а скрипт релиза
// и команда пакета ждут реестр одним и тем же кодом.

/**
 * Читающий порт реестра: боевой — npm, в тестах — фейк. Два метода — два вопроса.
 * `has` — «версия уже опубликована» (packument её перечисляет): по нему `publishAll` пропускает пакет
 * при повторном запуске тега. `served` — «что видно по версии», одно из трёх состояний `Served`; ставить
 * можно только `'served'` (и packument её перечисляет, и tarball отдаётся): по нему ждут публикацию.
 * `has` и `served` расходятся, пока CDN отстаёт: в rollout 1.12.0 packument уже показывал версию,
 * а tarball отвечал 404.
 */
export interface Registry {
	has(name: string, version: string): Promise<boolean>;
	served(name: string, version: string): Promise<Served>;
}

/**
 * Что видно по версии. `'served'` — HEAD на `dist.tarball` версии ответил 2xx. `'unlisted'` — в packument нет
 * `dist.tarball` строкой для версии: пакета нет (404), версии нет или она без `dist.tarball`.
 * `'no-tarball'` — URL tarball известен, HEAD ответил 404.
 */
export type Served = 'served' | 'unlisted' | 'no-tarball';

export interface Wanted {
	readonly name: string;
	readonly version: string;
}

export interface WaitOptions {
	attempts: number;
	intervalMs: number;
	sleep?: (ms: number) => Promise<void>;
}

// Abbreviated-документ: те же заголовки, что у шага ожидания в sync.yml.
const ACCEPT = 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*';

interface Packument {
	versions?: Record<string, { dist?: { tarball?: unknown } } | undefined>;
}

/** Читает abbreviated packument; 404 — `undefined` (пакета в реестре нет). */
async function readPackument(name: string, timeoutMs: number): Promise<Packument | undefined> {
	let res: Response;
	try {
		res = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2f')}`, {
			headers: { Accept: ACCEPT },
			// Зависшее соединение иначе держит job релиза вечно.
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (e) {
		throw new Error(`${name}: реестр недоступен: ${e instanceof Error ? e.message : String(e)}`);
	}
	if (res.status === 404) return undefined;
	if (!res.ok) throw new Error(`${name}: реестр ответил ${res.status}`);
	let body: unknown;
	try {
		body = await res.json();
	} catch (e) {
		// Не-JSON 200 или тело, оборванное abort'ом: без имени пакета лог не скажет, что чинить.
		throw new Error(
			`${name}: нечитаемый ответ реестра: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
	// 200 с `null` или массивом — не packument: молча читать его как «версий нет» значило бы принять
	// сломанный ответ за «ещё не опубликовано». Проверка вне `try` выше, чтобы префикс не удвоился.
	if (typeof body !== 'object' || body === null || Array.isArray(body)) {
		throw new Error(`${name}: нечитаемый ответ реестра: не объект`);
	}
	return body as Packument;
}

export function npmRegistryReader(timeoutMs = 30_000): Registry {
	return {
		async has(name, version) {
			const doc = await readPackument(name, timeoutMs);
			return doc?.versions?.[version] !== undefined;
		},
		async served(name, version) {
			const doc = await readPackument(name, timeoutMs);
			const tarball = doc?.versions?.[version]?.dist?.tarball;
			if (typeof tarball !== 'string') return 'unlisted';
			let res: Response;
			try {
				// HEAD на tarball уходит, только когда packument уже перечисляет версию. Проба до публикации
				// могла бы закэшировать в CDN 404 на URL tarball, и `npm install` после публикации получил бы
				// этот 404 (ответ на открытый вопрос DX-205).
				// Ровно dist.tarball из packument, без своих заголовков и query: проба должна видеть то же, что npm install.
				res = await fetch(tarball, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) });
			} catch (e) {
				throw new Error(
					`${name}@${version}: tarball недоступен: ${e instanceof Error ? e.message : String(e)}`,
				);
			}
			if (res.status === 404) return 'no-tarball';
			if (!res.ok) throw new Error(`${name}@${version}: tarball ответил ${res.status}`);
			return 'served';
		},
	};
}

/** Запись ожидания с причиной последней попытки. */
interface Pending extends Wanted {
	readonly why: string;
}

/** Ждёт, пока все записи появятся в реестре со своей версией и отдадут tarball; готовые повторно не опрашивает. */
export async function waitVisible(
	wanted: readonly Wanted[],
	registry: Registry,
	opts: WaitOptions,
): Promise<void> {
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	let pending: readonly Pending[] = wanted.map((w) => ({ ...w, why: '' }));
	for (let i = 1; i <= opts.attempts; i++) {
		const left: Pending[] = [];
		for (const w of pending) {
			// Сбой реестра (5xx, сеть) — «ещё не видно» на этой попытке, как в старом шаге sync.yml; его message — причина.
			let why: string;
			try {
				const state = await registry.served(w.name, w.version);
				if (state === 'served') {
					console.log(`${w.name}@${w.version} есть в реестре`);
					continue;
				}
				why = state === 'unlisted' ? 'нет в packument' : 'в packument есть, tarball не отдаётся';
			} catch (e) {
				why = (e as Error).message;
			}
			left.push({ ...w, why });
		}
		pending = left;
		if (pending.length === 0) return;
		if (i < opts.attempts) await sleep(opts.intervalMs);
	}
	throw new Error(
		`за ${opts.attempts} попыток в реестре не появились версии: ${pending.map((p) => `${p.name}@${p.version} (${p.why})`).join(', ')}`,
	);
}
