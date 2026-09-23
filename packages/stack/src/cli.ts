#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { checkRepo, planRepo } from './check.ts';
import { type Profile, PROFILES, readStackConfig, StackConfigError } from './config.ts';
import { initConfig } from './init.ts';

function fail(message: string): never {
	console.error(message);
	process.exit(2);
}

function parseCliArgs() {
	try {
		return parseArgs({
			args: Bun.argv.slice(2),
			allowPositionals: true,
			options: {
				repo: { type: 'string' },
				profile: { type: 'string' },
				with: { type: 'string', multiple: true },
			},
		});
	} catch (error) {
		// Usage error, same bucket as an unknown command — code 2, never an unhandled crash.
		fail(error instanceof Error ? error.message : String(error));
	}
}

const { values, positionals } = parseCliArgs();

const repoRoot = values.repo ?? process.cwd();
const command = positionals[0];

try {
	if (command === 'init') {
		if (!existsSync(repoRoot)) fail(`--repo does not exist: ${repoRoot}`);
		const profile = values.profile;
		if (!profile) fail('--profile is required: <node|contracts|infra>');
		if (!PROFILES.includes(profile as Profile)) {
			fail(`unknown --profile "${profile}", expected one of: ${PROFILES.join(', ')}`);
		}
		const path = initConfig(repoRoot, { profile: profile as Profile, with: values.with ?? [] });
		console.log(`created ${path}`);
	} else if (command === 'sync') {
		const cfg = readStackConfig(repoRoot);
		const plan = planRepo(repoRoot, cfg);
		for (const d of plan) {
			d.apply();
			console.log(d.fix);
		}
		console.log(`canon ${plan.length === 0 ? 'already up to date' : 'applied'}`);
	} else if (command === 'check') {
		const cfg = readStackConfig(repoRoot);
		const findings = checkRepo(repoRoot, cfg);
		const blocking = findings.filter((f) => !f.suppressedBy);
		for (const f of findings.filter((f) => f.suppressedBy)) {
			console.warn(`allowed (${f.suppressedBy?.reason}): ${f.target} — ${f.message}`);
		}
		for (const f of blocking) console.error(`${f.code}: ${f.target} — ${f.message}`);
		if (blocking.length) {
			console.error(`\n${blocking.length} finding(s). Fix with: stack sync`);
			process.exit(1);
		}
		console.log('canon: no drift');
	} else {
		fail(`unknown command "${command ?? ''}". Available: init, sync, check`);
	}
} catch (error) {
	if (error instanceof StackConfigError) fail(error.message);
	throw error;
}
