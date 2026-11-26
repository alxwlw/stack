import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

import { parsePins } from './canon.ts';
import { checkRepo } from './check.ts';
import { STACK_RENOVATE_PRESET } from './deps.ts';
import type { GuardrailsOutcome } from './guardrails.ts';
import { gitleaksDirArgv } from './guardrails-gitleaks.ts';
import type { GuardrailViolation } from './guardrails-port.ts';
import { checkGuardrails, guardrailsGroup, guardrailsNotes } from './guardrails-rule.ts';
import { loadRepo } from './repo.ts';
import { fakeGuardrailRunner, groupContext, repoDir, ROOT, testCanon } from './testkit.ts';

const viol = (
	tool: GuardrailViolation['tool'],
	path: string,
	line: number,
	rule = 'r',
): GuardrailViolation => ({ tool, rule, path, line, message: `m ${path}:${line}` });

const NO_FILES = { skipped: 'no files' } as const;

test('checkGuardrails: порядок — инструмент, путь, строка; цель без :0, сообщение с инструментом и правилом', () => {
	const outcome: GuardrailsOutcome = {
		tools: {
			actionlint: {
				version: '1.7.12',
				files: 2,
				violations: [
					viol('actionlint', '.github/workflows/b.yml', 2, 'expression'),
					viol('actionlint', '.github/workflows/a.yml', 8, 'expression'),
					viol('actionlint', '.github/workflows/a.yml', 3, 'syntax-check'),
					viol('actionlint', '.github/workflows/a.yml', 0, 'shellcheck'),
				],
			},
			shellcheck: {
				version: '0.11.0',
				files: 2,
				violations: [
					viol('shellcheck', 'z.sh', 1, 'SC2086'),
					viol('shellcheck', 'a.sh', 5, 'SC2046'),
				],
			},
			gitleaks: {
				version: '8.30.1',
				files: 4,
				violations: [viol('gitleaks', 'src/b.ts', 2, 'eth-private-key-no-prefix')],
			},
			hadolint: NO_FILES,
			'markdownlint-cli2': NO_FILES,
			yamllint: NO_FILES,
		},
		commits: { skipped: 'no files' },
	};
	const got = checkGuardrails(outcome);
	expect(got).toStrictEqual([
		{
			code: 'guardrails-violation',
			target: '.github/workflows/a.yml',
			message: 'actionlint shellcheck: m .github/workflows/a.yml:0',
		},
		{
			code: 'guardrails-violation',
			target: '.github/workflows/a.yml:3',
			message: 'actionlint syntax-check: m .github/workflows/a.yml:3',
		},
		{
			code: 'guardrails-violation',
			target: '.github/workflows/a.yml:8',
			message: 'actionlint expression: m .github/workflows/a.yml:8',
		},
		{
			code: 'guardrails-violation',
			target: '.github/workflows/b.yml:2',
			message: 'actionlint expression: m .github/workflows/b.yml:2',
		},
		{ code: 'guardrails-violation', target: 'a.sh:5', message: 'shellcheck SC2046: m a.sh:5' },
		{ code: 'guardrails-violation', target: 'z.sh:1', message: 'shellcheck SC2086: m z.sh:1' },
		{
			code: 'guardrails-violation',
			target: 'src/b.ts:2',
			message: 'gitleaks eth-private-key-no-prefix: m src/b.ts:2',
		},
	]);
	expect(got).toHaveLength(7);
});

test('checkGuardrails: порядок инструментов не зависит от порядка ключей исхода', () => {
	// Порядок ключей в исходе не влияет: порядок задаёт GUARDRAIL_TOOLS.
	const outcome: GuardrailsOutcome = {
		tools: {
			gitleaks: { version: '8.30.1', files: 1, violations: [viol('gitleaks', 'a.env', 1)] },
			hadolint: NO_FILES,
			'markdownlint-cli2': NO_FILES,
			yamllint: NO_FILES,
			shellcheck: { version: '0.11.0', files: 1, violations: [viol('shellcheck', 'a.sh', 1)] },
			actionlint: {
				version: '1.7.12',
				files: 1,
				violations: [viol('actionlint', '.github/workflows/a.yml', 1)],
			},
		},
		commits: { skipped: 'no files' },
	};
	expect(checkGuardrails(outcome).map((f) => f.target)).toStrictEqual([
		'.github/workflows/a.yml:1',
		'a.sh:1',
		'a.env:1',
	]);
});

test('checkGuardrails: недоступность всей группы, части и skipped', () => {
	expect(checkGuardrails({ unavailable: 'fatal: not a git repository' })).toStrictEqual([
		{
			code: 'guardrails-unavailable',
			target: 'git ls-files',
			message: 'fatal: not a git repository',
		},
	]);
	expect(
		checkGuardrails({
			tools: {
				actionlint: NO_FILES,
				shellcheck: { unavailable: '.prototools has no shellcheck pin' },
				gitleaks: NO_FILES,
				hadolint: NO_FILES,
				'markdownlint-cli2': NO_FILES,
				yamllint: NO_FILES,
			},
			commits: { skipped: 'no files' },
		}),
	).toStrictEqual([
		{
			code: 'guardrails-unavailable',
			target: 'shellcheck',
			message: '.prototools has no shellcheck pin',
		},
	]);
	expect(
		checkGuardrails({
			tools: {
				actionlint: { unavailable: 'gone' },
				shellcheck: NO_FILES,
				gitleaks: { unavailable: 'no gl' },
				hadolint: NO_FILES,
				'markdownlint-cli2': NO_FILES,
				yamllint: NO_FILES,
			},
			commits: { skipped: 'no files' },
		}),
	).toStrictEqual([
		{ code: 'guardrails-unavailable', target: 'actionlint', message: 'gone' },
		{ code: 'guardrails-unavailable', target: 'gitleaks', message: 'no gl' },
	]);
	expect(
		checkGuardrails({
			tools: {
				actionlint: NO_FILES,
				shellcheck: NO_FILES,
				gitleaks: NO_FILES,
				hadolint: NO_FILES,
				'markdownlint-cli2': NO_FILES,
				yamllint: NO_FILES,
			},
			commits: { skipped: 'no files' },
		}),
	).toStrictEqual([]);
	expect(
		checkGuardrails({
			tools: {
				actionlint: { version: '1.7.12', files: 1, violations: [] },
				shellcheck: { version: '0.11.0', files: 1, violations: [] },
				gitleaks: { version: '8.30.1', files: 1, violations: [] },
				hadolint: NO_FILES,
				'markdownlint-cli2': NO_FILES,
				yamllint: NO_FILES,
			},
			commits: { skipped: 'no files' },
		}),
	).toStrictEqual([]);
});

test('guardrailsNotes: строка на инструмент в порядке GUARDRAIL_TOOLS', () => {
	expect(
		guardrailsNotes({
			tools: {
				actionlint: {
					version: '1.7.12',
					files: 1,
					violations: [viol('actionlint', 'a.yml', 1), viol('actionlint', 'a.yml', 2)],
				},
				shellcheck: NO_FILES,
				gitleaks: { version: '8.30.1', files: 5, violations: [viol('gitleaks', 'a.env', 1)] },
				hadolint: NO_FILES,
				'markdownlint-cli2': NO_FILES,
				yamllint: NO_FILES,
			},
			commits: { skipped: 'no files' },
		}),
	).toStrictEqual([
		'guardrails actionlint 1.7.12: 1 file(s), 2 finding(s)',
		'guardrails shellcheck: skipped (no files)',
		'guardrails gitleaks 8.30.1: 5 file(s), 1 finding(s)',
		'guardrails hadolint: skipped (no files)',
		'guardrails markdownlint-cli2: skipped (no files)',
		'guardrails yamllint: skipped (no files)',
		'guardrails gitleaks commits: skipped (no files)',
	]);
	expect(
		guardrailsNotes({
			tools: {
				actionlint: NO_FILES,
				shellcheck: { version: '0.11.0', files: 3, violations: [] },
				gitleaks: NO_FILES,
				hadolint: NO_FILES,
				'markdownlint-cli2': NO_FILES,
				yamllint: NO_FILES,
			},
			commits: { skipped: 'no files' },
		}),
	).toStrictEqual([
		'guardrails actionlint: skipped (no files)',
		'guardrails shellcheck 0.11.0: 3 file(s), 0 finding(s)',
		'guardrails gitleaks: skipped (no files)',
		'guardrails hadolint: skipped (no files)',
		'guardrails markdownlint-cli2: skipped (no files)',
		'guardrails yamllint: skipped (no files)',
		'guardrails gitleaks commits: skipped (no files)',
	]);
	expect(
		guardrailsNotes({
			tools: {
				actionlint: NO_FILES,
				shellcheck: { unavailable: 'x' },
				gitleaks: NO_FILES,
				hadolint: NO_FILES,
				'markdownlint-cli2': NO_FILES,
				yamllint: NO_FILES,
			},
			commits: { skipped: 'no files' },
		}),
	).toStrictEqual([
		'guardrails actionlint: skipped (no files)',
		'guardrails shellcheck: unavailable',
		'guardrails gitleaks: skipped (no files)',
		'guardrails hadolint: skipped (no files)',
		'guardrails markdownlint-cli2: skipped (no files)',
		'guardrails yamllint: skipped (no files)',
		'guardrails gitleaks commits: skipped (no files)',
	]);
	expect(guardrailsNotes({ unavailable: 'x' })).toStrictEqual([]);
});

const canon = testCanon({ rules: ['guardrails'] });

test('checkRepo: недоступность guardrails не гасится исключением, исключение протухает', () => {
	const port = fakeGuardrailRunner({
		'git ls-files -z': { code: 128, out: '', err: 'fatal: not a git repository\n' },
	});
	const root = repoDir({ 'renovate.json5': `{ extends: ['${STACK_RENOVATE_PRESET}'] }\n` });
	const { findings } = checkRepo(root, canon, [{ file: 'git ls-files', reason: 'held' }], {
		ports: { guardrails: port.run },
		env: {},
	});
	expect(findings.map((f) => [f.code, f.suppressedBy])).toStrictEqual([
		['guardrails-unavailable', undefined],
		['stale-exception', undefined],
	]);
});

test('guardrailsGroup: .prototools репозитория доходит до читателя, находки и пометки в отчёте', () => {
	// Канон ведёт .prototools, поэтому загрузчик его читает; пины берутся из файла репозитория.
	const gitleaksPin = parsePins(readFileSync(join(ROOT, '.prototools'), 'utf8')).gitleaks;
	const prototools = `shellcheck = "0.11.0"\ngitleaks = "${gitleaksPin}"\n`;
	const owned = testCanon({
		rules: ['guardrails'],
		files: [{ dest: '.prototools', content: prototools }],
	});
	const root = repoDir({
		'renovate.json5': `{ extends: ['${STACK_RENOVATE_PRESET}'] }\n`,
		'.prototools': prototools,
		'a.sh': 'echo $x\n',
	});
	const runner = fakeGuardrailRunner({
		'git ls-files -z': { code: 0, out: '.prototools\0a.sh\0', err: '' },
		'/x/sc --version': { code: 0, out: 'version: 0.11.0\n', err: '' },
		'/x/gl version': { code: 0, out: `${gitleaksPin}\n`, err: '' },
		[`/x/gl ${gitleaksDirArgv().join(' ')}`]: { code: 0, out: '[]', err: '' },
		'/x/sc -f json1 -- a.sh': {
			code: 1,
			err: '',
			out: JSON.stringify({
				comments: [
					{
						file: 'a.sh',
						line: 1,
						endLine: 1,
						column: 6,
						endColumn: 8,
						level: 'warning',
						code: 2086,
						message: 'quote',
						fix: null,
					},
				],
			}),
		},
	});
	const report = guardrailsGroup(
		groupContext(loadRepo(root, owned), {
			repoRoot: root,
			env: { SHELLCHECK_BIN: '/x/sc', GITLEAKS_BIN: '/x/gl' },
		}),
		runner.run,
	);
	expect(report.findings).toStrictEqual([
		{ code: 'guardrails-violation', target: 'a.sh:1', message: 'shellcheck SC2086: quote' },
	]);
	expect(report.notes).toStrictEqual([
		'guardrails actionlint: skipped (no files)',
		'guardrails shellcheck 0.11.0: 1 file(s), 1 finding(s)',
		`guardrails gitleaks ${gitleaksPin}: 2 file(s), 0 finding(s)`,
		'guardrails hadolint: skipped (no files)',
		'guardrails markdownlint-cli2: skipped (no files)',
		'guardrails yamllint: skipped (no files)',
		'guardrails gitleaks commits: skipped (no --base outside GitHub Actions)',
	]);
	expect(runner.calls).toHaveLength(5);
});
