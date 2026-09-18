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
	suppressedBy?: Exception;
}
