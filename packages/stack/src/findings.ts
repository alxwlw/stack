import type { Exception } from './config.ts';

export type FindingCode =
	| 'file-drift'
	| 'file-missing'
	| 'catalog-drift'
	| 'catalog-missing'
	| 'inline-version'
	| 'engines-node'
	| 'dependabot-ignore'
	| 'unreadable-file'
	| 'stale-exception';

export interface Finding {
	code: FindingCode;
	target: string;
	message: string;
	// Что в этой находке может адресовать исключение из .stack.jsonc: файл — его dest, запись
	// каталога — catalog+name, inline-version — name. Находка без адреса не подавляется никогда.
	address?: Omit<Exception, 'reason'>;
	suppressedBy?: Exception;
}

function covers(e: Exception, f: Finding): boolean {
	const a = f.address;
	if (!a) return false;
	if (e.file != null) return a.file === e.file;
	// Исключение catalog+name гасит не только свою запись каталога, но и inline-version того же
	// пакета в любом package.json: пакет, который держат на своей версии, объявляют напрямую, а не
	// через catalog:, и одно оправдание покрывает оба симптома одной причины (fixtures/node: knip).
	return a.name === e.name && (a.catalog == null || a.catalog === e.catalog);
}

// Правила отдают сырые находки; здесь — единственное место, где исключение сопоставляется с
// находкой, и здесь же исключение без находки становится stale-exception.
export function applyExceptions(findings: Finding[], exceptions: Exception[]): Finding[] {
	const suppressed = findings.map((f) => {
		const e = exceptions.find((e) => covers(e, f));
		return e ? { ...f, suppressedBy: e } : f;
	});
	// Исключение без находки — мёртвая запись: канон уже изменился, а оправдание осталось.
	const stale = exceptions
		.filter((e) => !findings.some((f) => covers(e, f)))
		.map<Finding>((e) => ({
			code: 'stale-exception',
			target: e.file ?? `catalogs.${e.catalog}.${e.name}`,
			message: `exception no longer covers anything: ${e.reason}`,
		}));
	return [...suppressed, ...stale];
}
