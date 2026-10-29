import type { Finding, FindingCode, FindingOf } from './findings.ts';

// Исключение из .stack.jsonc: держит одну находку, задаётся адресом и обязательной причиной.
export interface Exception {
	file?: string;
	catalog?: string;
	name?: string;
	reason: string;
}

// Допустимые адреса исключения. schema.json (oneOf исключения) сверяется с этим тестом.
export const EXCEPTION_SHAPES = [['file'], ['catalog', 'name']] as const;

const ADDRESS_KEYS: string[] = EXCEPTION_SHAPES.flat();

// Текст проблемы одной записи .stack.jsonc или undefined, если запись верна. Форма допустима, если
// все ключи одной формы — непустые строки, а остальные адресные ключи отсутствуют.
export function exceptionProblem(raw: unknown): string | undefined {
	// exceptions пришёл из JSON и типизирован через "as" — реальный элемент массива может быть
	// null/undefined, даже когда тип обещает Exception; проверяем честно, не полагаясь на "as".
	const e = raw as Record<string, unknown> | null | undefined;
	if (e == null || !e.reason) return `exception is missing "reason": ${JSON.stringify(e)}`;
	const present = (v: unknown): boolean => v !== undefined;
	const nonEmpty = (v: unknown): boolean => typeof v === 'string' && v !== '';
	const fits = (keys: readonly string[]): boolean =>
		keys.every((k) => nonEmpty(e[k])) &&
		ADDRESS_KEYS.every((k) => keys.includes(k) || !present(e[k]));
	if (!EXCEPTION_SHAPES.some((shape) => fits(shape))) {
		return `an exception must address either "file" or a "catalog"+"name" pair: ${JSON.stringify(e)}`;
	}
	return undefined;
}

// Что в находке может адресовать исключение: файл, запись каталога или имя пакета.
export type Address = { file: string } | { catalog: string; name: string } | { name: string };

// Находка, удержанная исключением.
export type Held<F extends Finding = Finding> = F & { suppressedBy: Exception };

// Единственное место, где код находки встречается с адресом. Запись для нового кода обязательна:
// без неё tsc красный. 'unsuppressible' — находку не гасит никакое исключение.
const ADDRESS: { [C in FindingCode]: ((f: FindingOf<C>) => Address) | 'unsuppressible' } = {
	'file-drift': (f) => ({ file: f.file }),
	'file-missing': (f) => ({ file: f.file }),
	'catalog-drift': (f) => ({ catalog: f.catalog, name: f.name }),
	'catalog-missing': (f) => ({ catalog: f.catalog, name: f.name }),
	'inline-version': (f) => ({ name: f.name }),
	// packageManager в package.json — следствие решения про .prototools: одно исключение на
	// .prototools держит оба симптома.
	'package-manager': () => ({ file: '.prototools' }),
	'engines-node': 'unsuppressible',
	'renovate-preset': 'unsuppressible',
	'dependabot-config': 'unsuppressible',
	// Версия в moon toolchains — второй пин поверх .prototools; исключение держит её по файлу.
	'moon-toolchain-version': () => ({ file: '.moon/toolchains.yml' }),
	'unreadable-file': 'unsuppressible',
	'stale-exception': 'unsuppressible',
};

export function addressOf(f: Finding): Address | undefined {
	const entry = ADDRESS[f.code];
	if (entry === 'unsuppressible') return undefined;
	// TS не связывает код находки с записью таблицы (коррелированный union): тип таблицы уже
	// гарантирует, что запись каждого кода принимает находку этого кода.
	return (entry as (f: Finding) => Address)(f);
}

export function covers(e: Exception, f: Finding): boolean {
	const a = addressOf(f);
	if (!a) return false;
	if (e.file != null) return 'file' in a && a.file === e.file;
	// Исключение catalog+name гасит не только свою запись каталога, но и inline-version того же
	// пакета в любом package.json: пакет, который держат на своей версии, объявляют напрямую, а не
	// через catalog:, и одно оправдание покрывает оба симптома одной причины (fixtures/node: knip).
	return 'name' in a && a.name === e.name && (!('catalog' in a) || a.catalog === e.catalog);
}

export function isHeld<F extends Finding>(f: F): f is Held<F> {
	return f.suppressedBy !== undefined;
}

// Единственное место, где исключение сопоставляется с находкой, — для check и для sync. Здесь же
// исключение без находки становится stale-exception: канон уже изменился, а оправдание осталось.
// sync берёт только findings: удержанное не применяется, иначе исключению после sync нечего
// покрывать, и следующий check краснеет на stale-exception.
export function resolve<F extends Finding>(
	findings: F[],
	exceptions: Exception[],
): { findings: (F | Held<F>)[]; stale: Finding[] } {
	// Единственный вызов covers: матрица «находка × исключение».
	const hits = findings.map((f) => exceptions.map((e) => covers(e, f)));
	const resolved = findings.map((f, i): F | Held<F> => {
		const at = hits[i]?.indexOf(true) ?? -1;
		const e = exceptions[at];
		return e ? { ...f, suppressedBy: e } : f;
	});
	const stale = exceptions
		.filter((_, j) => !hits.some((row) => row[j]))
		.map<Finding>((e) => ({
			code: 'stale-exception',
			target: e.file ?? `catalogs.${e.catalog}.${e.name}`,
			message: `exception no longer covers anything: ${e.reason}`,
		}));
	return { findings: resolved, stale };
}

export function allowedLine(f: Held): string {
	return `allowed (${f.suppressedBy.reason}): ${f.target} — ${f.message}`;
}
