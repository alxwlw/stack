// Чтение реестра npm и ожидание, пока в нём появятся версии. Импортирует только `node:*` (здесь —
// ничего): job rollout и publish идут без установки зависимостей (docs/release.md), а скрипт релиза
// и команда пакета ждут реестр одним и тем же кодом.

/** Читающий порт реестра: боевой — npm, в тестах — фейк. */
export interface Registry {
	has(name: string, version: string): Promise<boolean>;
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

export function npmRegistryReader(timeoutMs = 30_000): Registry {
	return {
		async has(name, version) {
			let res: Response;
			try {
				res = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2f')}`, {
					headers: { Accept: ACCEPT },
					// Зависшее соединение иначе держит job релиза вечно.
					signal: AbortSignal.timeout(timeoutMs),
				});
			} catch (e) {
				throw new Error(
					`${name}: реестр недоступен: ${e instanceof Error ? e.message : String(e)}`,
				);
			}
			if (res.status === 404) return false;
			if (!res.ok) throw new Error(`${name}: реестр ответил ${res.status}`);
			let doc: { versions?: Record<string, unknown> };
			try {
				doc = (await res.json()) as { versions?: Record<string, unknown> };
			} catch (e) {
				// Не-JSON 200 или тело, оборванное abort'ом: без имени пакета лог не скажет, что чинить.
				throw new Error(
					`${name}: нечитаемый ответ реестра: ${e instanceof Error ? e.message : String(e)}`,
				);
			}
			return doc.versions?.[version] !== undefined;
		},
	};
}

/** Ждёт, пока все записи появятся в реестре со своей версией; видимые повторно не опрашивает. */
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
			const visible = await registry.has(w.name, w.version).catch(() => false);
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
