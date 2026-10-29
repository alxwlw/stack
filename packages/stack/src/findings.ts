import type { Exception } from './exceptions.ts';

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
					| 'moon-toolchain-version'
					| 'unreadable-file'
					| 'stale-exception';
		  }
	);
export type FindingCode = Finding['code'];
export type FindingOf<C extends FindingCode> = Finding & { code: C };

// Правка одного файла как данные: применитель собирает правки по файлу и пишет его один раз.
export type Change =
	| { file: string; kind: 'write'; content: string }
	| { file: string; kind: 'yaml-set'; path: string[]; value: string }
	| { file: string; kind: 'json-set'; path: string[]; value: string };

// Расхождение, которое sync умеет закрыть: находка плюс правка. check печатает message,
// sync — fix после applyChanges. Правила из deps.ts дают Finding без правки — только отчёт.
export type Drift = Finding & { fix: string; change: Change };

// Drift — находка, которую закрывает `stack sync` (у неё есть change); остальное правят руками.
export function isDrift(f: Finding): f is Drift {
	return 'change' in f;
}
