import { expect, test } from 'bun:test';

import { check, checkRepo } from './check.ts';
import type { GuardrailRunner } from './guardrails-port.ts';
import { guardrailsGroup } from './guardrails-rule.ts';
import { groupContext, repoDir, testCanon, testRepo } from './testkit.ts';

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
const on = testCanon({ rules: ['guardrails'] });
const FAILED: GuardrailRunner = () => ({
	code: 128,
	out: '',
	err: 'fatal: not a git repository\n',
});
const NO_FILES: GuardrailRunner = () => ({ code: 0, out: '', err: '' });

test('группа выключена — гигиены нет', () => {
	const off = testCanon();
	const got = check(testRepo(off, { [BUILD]: BARE_WORKFLOW }), off, []);
	expect(got.filter((f) => f.code === 'workflow-hygiene')).toStrictEqual([]);
});

test('гигиена идёт после находок читателя и не зависит от его исхода', () => {
	const repo = testRepo(on, { [BUILD]: BARE_WORKFLOW });
	expect(guardrailsGroup(groupContext(repo), FAILED).findings).toStrictEqual([
		{
			code: 'guardrails-unavailable',
			target: 'git ls-files',
			message: 'fatal: not a git repository',
		},
		{ code: 'workflow-hygiene', target: BUILD, message: MESSAGE },
	]);
});

test('исключение на файл не удерживает гигиену и протухает', () => {
	const root = repoDir({ [BUILD]: BARE_WORKFLOW });
	const { findings } = checkRepo(root, on, [{ file: BUILD, reason: 'r' }], {
		ports: { guardrails: NO_FILES },
		env: {},
	});
	expect(findings.filter((f) => f.code !== 'renovate-preset')).toStrictEqual([
		{ code: 'workflow-hygiene', target: BUILD, message: MESSAGE },
		{
			code: 'stale-exception',
			target: BUILD,
			message: expect.stringContaining('exception no longer covers anything'),
		},
	]);
});

test('гигиенический workflow — находок нет', () => {
	const repo = testRepo(on, { [BUILD]: CLEAN_WORKFLOW });
	expect(guardrailsGroup(groupContext(repo), NO_FILES).findings).toStrictEqual([]);
});
