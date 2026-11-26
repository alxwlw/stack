import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { type PrBase, prBase } from './pr-base.ts';

const PR_ENV = {
	GITHUB_ACTIONS: 'true',
	GITHUB_EVENT_NAME: 'pull_request',
	GITHUB_BASE_REF: 'main',
};

describe('prBase', () => {
	const rows: [string, string | undefined, NodeJS.ProcessEnv, PrBase][] = [
		['явный --base', 'origin/dev', {}, { base: 'origin/dev' }],
		[
			'явный --base при push в Actions',
			'main',
			{ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push' },
			{ base: 'main' },
		],
		[
			'push в Actions',
			undefined,
			{ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push' },
			{ skipped: 'not a pull request' },
		],
		[
			'Actions без события',
			undefined,
			{ GITHUB_ACTIONS: 'true' },
			{ skipped: 'not a pull request' },
		],
		['pull_request', undefined, PR_ENV, { base: 'origin/main' }],
		['пустой --base в PR-окружении', '', PR_ENV, { base: 'origin/main' }],
		[
			'pull_request_target',
			undefined,
			{ ...PR_ENV, GITHUB_EVENT_NAME: 'pull_request_target', GITHUB_BASE_REF: 'dev' },
			{ base: 'origin/dev' },
		],
		[
			'PR без GITHUB_BASE_REF',
			undefined,
			{ ...PR_ENV, GITHUB_BASE_REF: '' },
			{ unavailable: 'GITHUB_BASE_REF is empty in a pull_request job' },
		],
		[
			'PR без переменной базы',
			undefined,
			{ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request' },
			{ unavailable: 'GITHUB_BASE_REF is empty in a pull_request job' },
		],
		['вне Actions без --base', undefined, {}, { skipped: 'no --base outside GitHub Actions' }],
		[
			'GITHUB_ACTIONS не true',
			undefined,
			{ GITHUB_ACTIONS: '1', GITHUB_EVENT_NAME: 'pull_request' },
			{ skipped: 'no --base outside GitHub Actions' },
		],
	];
	test.each(rows)('%s', (_name, base, env, expected) => {
		expect(prBase(base, env)).toStrictEqual(expected);
	});
});

test('базу PR вычисляет одно место вне тестов — checkRepo', () => {
	const callers = [...new Bun.Glob('*.ts').scanSync(import.meta.dir)]
		.filter((f) => !f.endsWith('.test.ts') && f !== 'testkit.ts' && f !== 'pr-base.ts')
		.filter((f) => readFileSync(join(import.meta.dir, f), 'utf8').includes('prBase('));
	expect(callers).toStrictEqual(['check.ts']);
});
