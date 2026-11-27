#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { main as repoRulesMain } from '@alxwlw/repo-rules';

import { assertKnownGroups, loadCanon, readCanonSource } from './canon.ts';
import { checkRepo, syncRepo } from './check.ts';
import { type Profile, PROFILES, readStackConfig, StackConfigError } from './config.ts';
import { ghGitHub } from './gh.ts';
import { spawnRunner } from './guardrails-port.ts';
import { initConfig } from './init.ts';
import { checkOutput, type Print, printLines, syncOutput } from './output.ts';
import { ownVersion } from './own-packages.ts';
import { peersBaseline } from './peers-baseline.ts';
import { pnpmPeers } from './peers-port.ts';
import { npmRegistryReader } from './registry.ts';
import { inProcessRepoRules } from './repo-rules-port.ts';
import { SYNC_PR_WAIT, syncPr } from './sync-pr.ts';
import { runProcess } from './sync-pr-port.ts';

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
				init: { type: 'boolean' },
				'allow-grow': { type: 'boolean' },
			},
		});
	} catch (error) {
		// Usage error, same bucket as an unknown command — code 2, never an unhandled crash.
		fail(error instanceof Error ? error.message : String(error));
	}
}

// Порт печати входа: строка сразу в свой канал.
const print: Print = (stream, line) => (stream === 'out' ? console.log(line) : console.error(line));

// Проводник: аргументы после `repo-rules` уходят в repo-rules как есть, флаги stack здесь не разбираются.
// Версия правил — версия самого stack: пакет берётся из зависимостей stack, не из репозитория потребителя.
if (Bun.argv[2] === 'repo-rules') {
	// Вывод собирается и дописывается до выхода: process.exit сразу после write обрывает канал на 128 КиБ.
	let out = '';
	let err = '';
	const code = repoRulesMain(
		Bun.argv.slice(3),
		process.env,
		(s) => void (out += `${s}\n`),
		(s) => void (err += `${s}\n`),
	);
	// Ошибка записи (диск полон, канал закрыт) — одна строка и код 2, как в бинарнике repo-rules.
	let writeError: Error | undefined;
	const flush = (stream: NodeJS.WriteStream, text: string) =>
		new Promise<void>((resolve) => {
			if (text)
				stream.write(text, (e) => {
					writeError ??= e ?? undefined;
					resolve();
				});
			else resolve();
		});
	await Promise.all([flush(process.stdout, out), flush(process.stderr, err)]);
	if (writeError) {
		process.stderr.write(`repo-rules: ${writeError.message}\n`);
		process.exit(2);
	}
	process.exit(code);
}

const { values, positionals } = parseCliArgs();

const repoRoot = values.repo ?? process.cwd();
const command = positionals[0];
if (positionals.includes('repo-rules')) {
	fail(
		'repo-rules takes its own arguments and must come first: stack repo-rules [-C <dir>] <command>',
	);
}

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
		printLines(print, syncOutput(syncRepo(repoRoot, loadCanon(cfg), cfg.exceptions)));
	} else if (command === 'check') {
		const cfg = readStackConfig(repoRoot);
		const { lines, code } = checkOutput(
			checkRepo(repoRoot, loadCanon(cfg), cfg.exceptions, {
				ports: {
					peers: pnpmPeers(process.env),
					'repo-rules': inProcessRepoRules,
					guardrails: spawnRunner(repoRoot, process.env),
				},
				env: process.env,
				base: values.base,
			}),
		);
		printLines(print, lines);
		if (code === 1) process.exit(1);
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
					run: runProcess(process.env, print),
					github: ghGitHub(repoRoot),
					registry: npmRegistryReader(),
					print,
					peers: pnpmPeers(process.env),
					repoRules: inProcessRepoRules,
				},
			),
		);
	} else if (command === 'peers-baseline') {
		if (values.init && values['allow-grow']) fail('--init and --allow-grow do not go together');
		const cfg = readStackConfig(repoRoot);
		const mode = values.init ? 'init' : values['allow-grow'] ? 'grow' : 'lower';
		const r = peersBaseline(repoRoot, loadCanon(cfg), mode, pnpmPeers(process.env));
		for (const line of r.out) console.log(line);
		for (const line of r.err) console.error(line);
		process.exit(r.code);
	} else {
		fail(
			`unknown command "${command ?? ''}". Available: init, sync, check, sync-pr, peers-baseline, repo-rules`,
		);
	}
} catch (error) {
	if (error instanceof StackConfigError) fail(error.message);
	throw error;
}
