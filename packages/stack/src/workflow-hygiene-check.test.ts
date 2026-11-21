import { expect, test } from 'bun:test';

import { check, checkRepo } from './check.ts';
import type { Exception } from './exceptions.ts';
import type { GuardrailsOutcome } from './guardrails.ts';
import type { GuardrailsPort } from './guardrails-port.ts';
import { repoDir, testCanon, testRepo } from './testkit.ts';

const BUILD = '.github/workflows/build.yml';
const BARE_WORKFLOW = `on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: 'true'
`;
const CLEAN_WORKFLOW = `on: push
permissions:
  contents: read
concurrency: build
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - run: 'true'
`;
const MESSAGE =
	'missing timeout-minutes (build); permissions (top level, or in build); concurrency (top level, or in build)';
const NO_FILES = { skipped: 'no files' } as const;
const CLEAN: GuardrailsOutcome = {
	tools: {
		actionlint: NO_FILES,
		shellcheck: NO_FILES,
		gitleaks: NO_FILES,
		hadolint: NO_FILES,
		'markdownlint-cli2': NO_FILES,
		yamllint: NO_FILES,
	},
	commits: NO_FILES,
};
const VIOLATION: GuardrailsOutcome = {
	...CLEAN,
	tools: {
		...CLEAN.tools,
		shellcheck: {
			version: '0.11.0',
			files: 1,
			violations: [
				{ tool: 'shellcheck', rule: 'SC2086', path: 'scripts/a.sh', line: 4, message: 'm' },
			],
		},
	},
};
const on = testCanon({ rules: ['guardrails'] });
const throwingPort: GuardrailsPort = {
	env: {},
	run: () => {
		throw new Error('порт guardrails не должен вызываться');
	},
};

test('группа выключена — гигиены нет', () => {
	const off = testCanon();
	const got = check(testRepo(off, { [BUILD]: BARE_WORKFLOW }), off, []);
	expect(got.filter((f) => f.code === 'workflow-hygiene')).toStrictEqual([]);
	const repo = repoDir({ [BUILD]: BARE_WORKFLOW });
	expect(checkRepo(repo, off, [], { guardrails: throwingPort })).toStrictEqual(
		checkRepo(repo, off, []),
	);
});

test('группа включена — находка за находками инструментов и до stale-exception', () => {
	const held: Exception = { file: 'gone.yml', reason: 'r' };
	const got = check(
		testRepo(on, { [BUILD]: BARE_WORKFLOW }),
		on,
		[held],
		undefined,
		undefined,
		VIOLATION,
	);
	expect(got.map((f) => [f.code, f.target])).toStrictEqual([
		['guardrails-violation', 'scripts/a.sh:4'],
		['workflow-hygiene', BUILD],
		['stale-exception', 'gone.yml'],
	]);
	expect(got[1]?.message).toBe(MESSAGE);
});

test('исключение на файл не удерживает гигиену', () => {
	const exception: Exception = { file: BUILD, reason: 'r' };
	const got = check(
		testRepo(on, { [BUILD]: BARE_WORKFLOW }),
		on,
		[exception],
		undefined,
		undefined,
		CLEAN,
	);
	expect(got).toStrictEqual([
		{ code: 'workflow-hygiene', target: BUILD, message: MESSAGE },
		{
			code: 'stale-exception',
			target: BUILD,
			message: expect.stringContaining('exception no longer covers anything'),
		},
	]);
});

test('гигиенический workflow — находок нет', () => {
	const got = check(testRepo(on, { [BUILD]: CLEAN_WORKFLOW }), on, [], undefined, undefined, CLEAN);
	expect(got.filter((f) => f.code === 'workflow-hygiene')).toStrictEqual([]);
});
