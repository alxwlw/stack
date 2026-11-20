import { expect, test } from 'bun:test';

import type { Canon } from './canon.ts';
import { check, checkRepo } from './check.ts';
import { STACK_RENOVATE_PRESET } from './deps.ts';
import type { Finding } from './findings.ts';
import type { GuardrailsOutcome } from './guardrails.ts';
import type { GuardrailRun, GuardrailsPort, GuardrailViolation } from './guardrails-port.ts';
import { checkGuardrails, guardrailsNotes } from './guardrails-rule.ts';
import type { RepoRulesOutcome, RepoRulesPort } from './repo-rules.ts';
import { repoDir, testCanon, testRepo } from './testkit.ts';

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
		},
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
	]);
	expect(got).toHaveLength(6);
});

test('checkGuardrails: shellcheck раньше actionlint не идёт, даже если объявлен первым', () => {
	// Порядок ключей в исходе не влияет: порядок задаёт GUARDRAIL_TOOLS.
	const outcome: GuardrailsOutcome = {
		tools: {
			shellcheck: { version: '0.11.0', files: 1, violations: [viol('shellcheck', 'a.sh', 1)] },
			actionlint: {
				version: '1.7.12',
				files: 1,
				violations: [viol('actionlint', '.github/workflows/a.yml', 1)],
			},
		},
	};
	expect(checkGuardrails(outcome).map((f) => f.target)).toStrictEqual([
		'.github/workflows/a.yml:1',
		'a.sh:1',
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
			},
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
			tools: { actionlint: { unavailable: 'gone' }, shellcheck: NO_FILES },
		}),
	).toStrictEqual([{ code: 'guardrails-unavailable', target: 'actionlint', message: 'gone' }]);
	expect(checkGuardrails({ tools: { actionlint: NO_FILES, shellcheck: NO_FILES } })).toStrictEqual(
		[],
	);
	expect(
		checkGuardrails({
			tools: {
				actionlint: { version: '1.7.12', files: 1, violations: [] },
				shellcheck: { version: '0.11.0', files: 1, violations: [] },
			},
		}),
	).toStrictEqual([]);
});

test('checkGuardrails: исхода нет — Error', () => {
	expect(() => checkGuardrails(undefined)).toThrow(
		new Error('checkGuardrails: no guardrails outcome'),
	);
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
			},
		}),
	).toStrictEqual([
		'guardrails actionlint 1.7.12: 1 file(s), 2 finding(s)',
		'guardrails shellcheck: skipped (no files)',
	]);
	expect(
		guardrailsNotes({
			tools: {
				actionlint: NO_FILES,
				shellcheck: { version: '0.11.0', files: 3, violations: [] },
			},
		}),
	).toStrictEqual([
		'guardrails actionlint: skipped (no files)',
		'guardrails shellcheck 0.11.0: 3 file(s), 0 finding(s)',
	]);
	expect(
		guardrailsNotes({ tools: { actionlint: NO_FILES, shellcheck: { unavailable: 'x' } } }),
	).toStrictEqual([
		'guardrails actionlint: skipped (no files)',
		'guardrails shellcheck: unavailable',
	]);
	expect(guardrailsNotes({ unavailable: 'x' })).toStrictEqual([]);
	expect(guardrailsNotes(undefined)).toStrictEqual([]);
});

const canon = testCanon({ rules: ['guardrails'] });
const SCRIPT_VIOLATION: GuardrailsOutcome = {
	tools: {
		actionlint: NO_FILES,
		shellcheck: {
			version: '0.11.0',
			files: 1,
			violations: [viol('shellcheck', 'scripts/a.sh', 4, 'SC2086')],
		},
	},
};

test('check: исключение на файл не гасит находку guardrails, а само протухает', () => {
	const got = check(
		testRepo(canon),
		canon,
		[{ file: 'scripts/a.sh', reason: 'held' }],
		undefined,
		undefined,
		SCRIPT_VIOLATION,
	);
	expect(got).toStrictEqual([
		{
			code: 'guardrails-violation',
			target: 'scripts/a.sh:4',
			message: 'shellcheck SC2086: m scripts/a.sh:4',
		},
		{
			code: 'stale-exception',
			target: 'scripts/a.sh',
			message: 'exception no longer covers anything: held',
		},
	] satisfies Finding[]);
});

test('check: недоступность тоже не гасится исключением', () => {
	const got = check(
		testRepo(canon),
		canon,
		[{ file: 'git ls-files', reason: 'held' }],
		undefined,
		undefined,
		{ unavailable: 'boom' },
	);
	expect(got.map((f) => [f.code, f.suppressedBy])).toStrictEqual([
		['guardrails-unavailable', undefined],
		['stale-exception', undefined],
	]);
});

test('check: группа включена, исхода нет — Error', () => {
	expect(() => check(testRepo(canon), canon, [])).toThrow(
		new Error('checkGuardrails: no guardrails outcome'),
	);
});

test('check: группа выключена — исход игнорируется', () => {
	const off = testCanon();
	expect(check(testRepo(off), off, [], undefined, undefined, SCRIPT_VIOLATION)).toStrictEqual([]);
});

test('check: находки guardrails — после repo-rules', () => {
	const both: Canon = testCanon({ rules: ['repo-rules', 'guardrails'] });
	const rr: RepoRulesOutcome = {
		check: {
			violations: [{ rule: 'long-file', path: 'big.ts', line: 0, message: 'too long' }],
			stale: [],
			notes: [],
		},
		diff: { skipped: 'x' },
	};
	expect(
		check(testRepo(both), both, [], undefined, rr, SCRIPT_VIOLATION).map((f) => f.code),
	).toStrictEqual(['repo-rules-violation', 'guardrails-violation']);
});

const throwingPort: GuardrailsPort = {
	env: {},
	run: () => {
		throw new Error('порт guardrails не должен вызываться');
	},
};

test('checkRepo: группа выключена — порт не зовётся, результат как без порта', () => {
	const off = testCanon();
	const repo = repoDir({});
	const without = checkRepo(repo, off, []);
	expect(checkRepo(repo, off, [], { guardrails: throwingPort })).toStrictEqual(without);
	expect(without.notes).toStrictEqual([]);
});

test('checkRepo: группа включена, порта нет — Error', () => {
	expect(() => checkRepo(repoDir({}), canon, [])).toThrow(
		new Error('checkRepo: guardrails group needs a GuardrailsPort'),
	);
});

test('checkRepo: .prototools репозитория доходит до читателя, находки и пометки в результате', () => {
	// Канон ведёт .prototools, поэтому загрузчик его читает; пины берутся из файла репозитория.
	const prototools = 'shellcheck = "0.11.0"\n';
	const owned = testCanon({
		rules: ['guardrails'],
		files: [{ dest: '.prototools', content: prototools }],
	});
	const root = repoDir({
		'renovate.json5': `{ extends: ['${STACK_RENOVATE_PRESET}'] }\n`,
		'.prototools': prototools,
		'a.sh': 'echo $x\n',
	});
	const calls: [string, string[]][] = [];
	const results: Record<string, GuardrailRun> = {
		'git ls-files -z': { code: 0, out: '.prototools\0a.sh\0', err: '' },
		'/x/sc --version': { code: 0, out: 'version: 0.11.0\n', err: '' },
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
	};
	const port: GuardrailsPort = {
		env: { SHELLCHECK_BIN: '/x/sc' },
		run: (cmd, argv) => {
			calls.push([cmd, argv]);
			const hit = results[[cmd, ...argv].join(' ')];
			if (hit === undefined) throw new Error(`unexpected call: ${cmd} ${argv.join(' ')}`);
			return hit;
		},
	};
	const report = checkRepo(root, owned, [], { guardrails: port });
	expect(report.findings).toStrictEqual([
		{ code: 'guardrails-violation', target: 'a.sh:1', message: 'shellcheck SC2086: quote' },
	]);
	expect(report.notes).toStrictEqual([
		'guardrails actionlint: skipped (no files)',
		'guardrails shellcheck 0.11.0: 1 file(s), 1 finding(s)',
	]);
	expect(calls).toHaveLength(3);
});

test('checkRepo: обе группы — находки и пометки repo-rules идут раньше guardrails', () => {
	const both = testCanon({ rules: ['repo-rules', 'guardrails'] });
	const root = repoDir({ 'renovate.json5': `{ extends: ['${STACK_RENOVATE_PRESET}'] }\n` });
	const repoRules: RepoRulesPort = {
		env: { GITHUB_ACTIONS: '' },
		base: undefined,
		read: () => ({
			code: 1,
			err: '',
			out: JSON.stringify({
				violations: [{ rule: 'max-lines', path: 'big.ts', line: 801, message: '812 lines' }],
				stale: [],
				notes: [],
			}),
		}),
	};
	const guardrails: GuardrailsPort = {
		env: {},
		run: () => ({ code: 128, out: '', err: 'fatal: not a git repository\n' }),
	};
	expect(checkRepo(root, both, [], { repoRules, guardrails })).toStrictEqual({
		findings: [
			{ code: 'repo-rules-violation', target: 'big.ts:801', message: 'max-lines: 812 lines' },
			{
				code: 'guardrails-unavailable',
				target: 'git ls-files',
				message: 'fatal: not a git repository',
			},
		],
		notes: ['repo-rules diff: skipped (no --base outside GitHub Actions)'],
	});
});

test('checkRepo: notes guardrails после repo-rules', () => {
	const both = testCanon({ rules: ['repo-rules', 'guardrails'] });
	const root = repoDir({ 'renovate.json5': `{ extends: ['${STACK_RENOVATE_PRESET}'] }\n` });
	const repoRules: RepoRulesPort = {
		env: { GITHUB_ACTIONS: '' },
		base: undefined,
		read: () => ({
			code: 0,
			err: '',
			out: JSON.stringify({ violations: [], stale: [], notes: [] }),
		}),
	};
	const guardrails: GuardrailsPort = {
		env: {},
		run: () => ({ code: 0, out: 'README.md\0', err: '' }),
	};
	expect(checkRepo(root, both, [], { repoRules, guardrails }).notes).toStrictEqual([
		'repo-rules diff: skipped (no --base outside GitHub Actions)',
		'guardrails actionlint: skipped (no files)',
		'guardrails shellcheck: skipped (no files)',
	]);
});
