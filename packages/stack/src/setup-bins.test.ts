import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, test } from 'bun:test';
import { parse as parseYaml } from 'yaml';

import { GUARDRAIL_TOOLS } from './guardrails-port.ts';
import { ROOT } from './testkit.ts';

type Step = { name?: string; run?: string };

// Шаг setup, чей run пишет *_BIN в GITHUB_ENV.
function binsStep(): string {
	const action = parseYaml(
		readFileSync(join(ROOT, '.github/actions/setup/action.yml'), 'utf8'),
	) as { runs: { steps: Step[] } };
	const step = action.runs.steps.find((s) => s.run?.includes('_BIN='));
	if (!step?.run) throw new Error('setup action has no step writing _BIN=');
	return step.run;
}

describe('setup: пути к бинарникам guardrails', () => {
	const tmp: string[] = [];
	afterAll(() => {
		for (const d of tmp) rmSync(d, { recursive: true, force: true });
	});

	test('список цикла равен инструментам группы guardrails', () => {
		const m = /for tool in ([a-z ]+); do/.exec(binsStep());
		expect(m?.[1]?.trim().split(/\s+/)).toEqual([...GUARDRAIL_TOOLS]);
	});

	test('run экспортирует *_BIN только для инструментов из .prototools', () => {
		const dir = mkdtempSync(join(tmpdir(), 'stack-bins-'));
		tmp.push(dir);
		const stub = join(dir, 'stub');
		spawnSync('mkdir', [stub]);
		writeFileSync(join(stub, 'proto'), '#!/bin/sh\necho /x/$2\n');
		chmodSync(join(stub, 'proto'), 0o755);
		writeFileSync(join(dir, '.prototools'), 'actionlint = "1.0.0"\ngitleaks = "2.0.0"\n');
		const env = join(dir, 'github-env');
		writeFileSync(env, '');
		const r = spawnSync('bash', ['-e', '-c', binsStep()], {
			cwd: dir,
			encoding: 'utf8',
			env: { ...process.env, PATH: `${stub}:${process.env.PATH}`, GITHUB_ENV: env },
		});
		expect(r.status).toBe(0);
		expect(readFileSync(env, 'utf8').split('\n').filter(Boolean)).toEqual([
			'ACTIONLINT_BIN=/x/actionlint',
			'GITLEAKS_BIN=/x/gitleaks',
		]);
	});
});
