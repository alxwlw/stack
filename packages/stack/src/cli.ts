#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { assertKnownGroups, loadCanon, readCanonSource } from './canon.ts';
import { checkRepo, syncOutput, syncRepo } from './check.ts';
import { type Profile, PROFILES, readStackConfig, StackConfigError } from './config.ts';
import { allowedLine, isHeld } from './exceptions.ts';
import { type Finding, isDrift } from './findings.ts';
import { ghGitHub } from './gh.ts';
import { initConfig } from './init.ts';
import { npmRegistryReader } from './registry.ts';
import { ownVersion, type RunProcess, SYNC_PR_WAIT, syncPr } from './sync-pr.ts';

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
				base: { type: 'string' },
				'no-install': { type: 'boolean' },
			},
		});
	} catch (error) {
		// Usage error, same bucket as an unknown command — code 2, never an unhandled crash.
		fail(error instanceof Error ? error.message : String(error));
	}
}

// Подсказка под находками: stack sync закрывает только Drift; правила deps.ts — отчёт без действия.
function fixHint(blocking: Finding[]): string {
	const total = blocking.length;
	const bySync = blocking.filter(isDrift).length;
	if (bySync === total) return `${total} finding(s). Fix with: stack sync`;
	if (bySync === 0) {
		return `${total} finding(s). stack sync does not fix these — fix them by hand (see above)`;
	}
	return `${total} finding(s): ${bySync} fixable with: stack sync, ${total - bySync} to fix by hand (see above)`;
}

// Боевой adapter порта процессов: stdio наследуется, вывод идёт в лог job.
const runProcess: RunProcess = (cmd, args, { cwd, env }) => {
	const r = spawnSync(cmd, [...args], { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
	if (r.error) {
		console.error(`sync-pr: ${cmd}: ${r.error.message}`);
		return 127;
	}
	if (r.signal) {
		console.error(`sync-pr: ${cmd} killed by ${r.signal}`);
		return 1;
	}
	return r.status ?? 1;
};

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
		assertKnownGroups(values.with ?? [], readCanonSource());
		const path = initConfig(repoRoot, { profile: profile as Profile, with: values.with ?? [] });
		console.log(`created ${path}`);
	} else if (command === 'sync') {
		const cfg = readStackConfig(repoRoot);
		const { stdout, stderr } = syncOutput(syncRepo(repoRoot, loadCanon(cfg), cfg.exceptions));
		for (const line of stderr) console.warn(line);
		for (const line of stdout) console.log(line);
	} else if (command === 'check') {
		const cfg = readStackConfig(repoRoot);
		const findings = checkRepo(repoRoot, loadCanon(cfg), cfg.exceptions);
		const blocking = findings.filter((f) => !isHeld(f));
		for (const f of findings.filter(isHeld)) console.warn(allowedLine(f));
		for (const f of blocking) console.error(`${f.code}: ${f.target} — ${f.message}`);
		if (blocking.length) {
			console.error(`\n${fixHint(blocking)}`);
			process.exit(1);
		}
		console.log('canon: no drift');
	} else if (command === 'sync-pr') {
		const appSlug = process.env.STACK_APP_SLUG;
		if (!process.env.GH_TOKEN || !appSlug) {
			fail('sync-pr needs GH_TOKEN and STACK_APP_SLUG in the environment');
		}
		process.exit(
			await syncPr(
				{
					repoRoot,
					version: ownVersion(),
					base: values.base,
					appSlug,
					install: !values['no-install'],
					wait: SYNC_PR_WAIT,
				},
				{
					run: runProcess,
					github: ghGitHub(),
					registry: npmRegistryReader(),
					print: (stream, line) => (stream === 'out' ? console.log(line) : console.error(line)),
				},
			),
		);
	} else {
		fail(`unknown command "${command ?? ''}". Available: init, sync, check, sync-pr`);
	}
} catch (error) {
	if (error instanceof StackConfigError) fail(error.message);
	throw error;
}
