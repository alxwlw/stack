import { expect, test } from 'bun:test';

import { RULE_GROUPS, type RuleGroup } from './rule-settings.ts';
import { type CheckPorts, checkRepo, RULE_GROUP_MODULES } from './check.ts';
import type { FindingCode } from './findings.ts';
import type { RuleGroupModule } from './rule-group.ts';
import {
	fakeGuardrailRunner,
	fakePeersReader,
	fakeRepoRulesReader,
	repoDir,
	testCanon,
} from './testkit.ts';

interface Sample {
	/** Файлы репозитория, без которых группа не дойдёт до порта. */
	files: Record<string, string>;
	/** Порты с одним портом группы и счётчик его вызовов. */
	ports: () => { ports: CheckPorts; calls: () => number };
	/** Код находки, которую группа даёт на этом образце. */
	code: FindingCode;
}

// Record<RuleGroup, …>: имя группы без образца не компилируется.
const SAMPLES: Record<RuleGroup, Sample> = {
	peers: {
		files: { 'pnpm-lock.yaml': 'lockfileVersion: x\n' },
		ports: () => {
			const port = fakePeersReader({ error: 'boom' });
			return { ports: { peers: port.read }, calls: () => port.calls.length };
		},
		code: 'peers-unavailable',
	},
	'repo-rules': {
		files: {},
		ports: () => {
			const port = fakeRepoRulesReader({ code: 2, out: '', err: 'repo-rules: boom' });
			return { ports: { 'repo-rules': port.read }, calls: () => port.calls.length };
		},
		code: 'repo-rules-unavailable',
	},
	guardrails: {
		files: {},
		ports: () => {
			const runner = fakeGuardrailRunner({
				'git ls-files -z': { code: 128, out: '', err: 'fatal: not a git repository\n' },
			});
			return { ports: { guardrails: runner.run }, calls: () => runner.calls.length };
		},
		code: 'guardrails-unavailable',
	},
};

test.each(RULE_GROUPS)(
	'%s: включена — находка группы пришла через checkRepo, порт вызван',
	(group) => {
		const sample = SAMPLES[group];
		const { ports, calls } = sample.ports();
		const report = checkRepo(repoDir(sample.files), testCanon({ rules: [group] }), [], {
			ports,
			env: {},
		});
		expect(report.findings.map((f) => f.code)).toContain(sample.code);
		expect(calls()).toBeGreaterThan(0);
	},
);

test.each(RULE_GROUPS)('%s: выключена — порт не вызван, находок группы нет', (group) => {
	const sample = SAMPLES[group];
	const { ports, calls } = sample.ports();
	const report = checkRepo(repoDir(sample.files), testCanon(), [], { ports, env: {} });
	expect(report.findings.map((f) => f.code)).not.toContain(sample.code);
	expect(calls()).toBe(0);
});

// Тест пустой: его «утверждение» — то, что файл проходит `tsc --build`.
test('имя группы без образца и без записи в таблице не компилируется', () => {
	const { guardrails: _sample, ...twoSamples } = SAMPLES;
	// @ts-expect-error — в образцах нет guardrails
	const samples: Record<RuleGroup, Sample> = twoSamples;
	const { guardrails: _module, ...twoModules } = RULE_GROUP_MODULES;
	// @ts-expect-error — в таблице нет guardrails
	const modules: Record<RuleGroup, RuleGroupModule<never>> = twoModules;
	expect([Object.keys(samples), Object.keys(modules)]).toStrictEqual([
		['peers', 'repo-rules'],
		['peers', 'repo-rules'],
	]);
});
