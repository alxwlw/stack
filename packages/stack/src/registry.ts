// Чтение реестра npm и ожидание, пока в нём появятся версии. Импортирует только `node:*` (здесь —
// ничего): job rollout идёт без установки зависимостей (docs/release.md), а скрипт релиза
// и команда пакета ждут реестр одним и тем же кодом.

/**
 * Читающий порт реестра: боевой — npm, в тестах — фейк. Два метода — два вопроса.
 * `has` — «версия уже опубликована» (packument её перечисляет): по нему `publishAll` пропускает пакет
 * при повторном запуске тега. `served` — «версию можно ставить» (и packument её перечисляет, и tarball
 * отдаётся): по нему ждут публикацию. Они расходятся, пока CDN отстаёт: в rollout 1.12.0 packument уже
 * показывал версию, а tarball отвечал 404.
 */
export interface Registry {
	has(name: string, version: string): Promise<boolean>;
	served(name: string, version: string): Promise<boolean>;
}

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
	try {
		return (await res.json()) as Packument;
	} catch (e) {
		// Не-JSON 200 или тело, оборванное abort'ом: без имени пакета лог не скажет, что чинить.
		throw new Error(
			`${name}: нечитаемый ответ реестра: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
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
			if (typeof tarball !== 'string') return false;
			let res: Response;
			try {
				// Ровно dist.tarball из packument, без своих заголовков и query: проба должна видеть то же, что npm install.
				res = await fetch(tarball, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) });
			} catch (e) {
				throw new Error(
					`${name}@${version}: tarball недоступен: ${e instanceof Error ? e.message : String(e)}`,
				);
			}
			if (res.status === 404) return false;
			if (!res.ok) throw new Error(`${name}@${version}: tarball ответил ${res.status}`);
			return true;
		},
	};
}

/** Ждёт, пока все записи появятся в реестре со своей версией и отдадут tarball; готовые повторно не опрашивает. */
export async function waitVisible(
	wanted: readonly Wanted[],
	registry: Registry,
	opts: WaitOptions,
): Promise<void> {
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	let pending = wanted;
	for (let i = 1; i <= opts.attempts; i++) {
		const left: Wanted[] = [];
		for (const w of pending) {
			// Сбой реестра (5xx, сеть) — «ещё не видно» на этой попытке, как в старом шаге sync.yml.
			const visible = await registry.served(w.name, w.version).catch(() => false);
			if (visible) console.log(`${w.name}@${w.version} есть в реестре`);
			else left.push(w);
		}
		pending = left;
		if (pending.length === 0) return;
		if (i < opts.attempts) await sleep(opts.intervalMs);
	}
	throw new Error(
		`за ${opts.attempts} попыток в реестре не появились версии: ${pending.map((w) => `${w.name}@${w.version}`).join(' ')}`,
	);
}
