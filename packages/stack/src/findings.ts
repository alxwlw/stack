import type { Exception } from './config.ts';

interface FindingBase {
	target: string;
	message: string;
	suppressedBy?: Exception;
}

// Предмет находки — данные для сопоставления с исключением из .stack.jsonc: файл — его dest,
// запись каталога — catalog+name, inline-version — name. Адрес из них строит exceptions.ts;
// находки без предмета не подавляются никогда.
export type Finding = FindingBase &
	(
		| { code: 'file-drift' | 'file-missing'; file: string }
		| { code: 'catalog-drift' | 'catalog-missing'; catalog: string; name: string }
		| { code: 'inline-version'; name: string }
		| {
				code:
					| 'package-manager'
					| 'engines-node'
					| 'renovate-preset'
					| 'dependabot-config'
					| 'unreadable-file'
					| 'stale-exception';
		  }
	);
export type FindingCode = Finding['code'];
export type FindingOf<C extends FindingCode> = Finding & { code: C };

// Расхождение, которое sync умеет закрыть: находка плюс действие. check печатает message,
// sync — fix после apply(). Правила из deps.ts дают Finding без действия — только отчёт.
export type Drift = Finding & { fix: string; apply(): void };

// Drift — находка, которую закрывает `stack sync` (у неё есть apply); остальное правят руками.
export function isDrift(f: Finding): f is Drift {
	return typeof (f as Partial<Drift>).apply === 'function';
}
