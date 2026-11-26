#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { main as repoRulesMain } from '@alxwlw/repo-rules';

import { assertKnownGroups, loadCanon, readCanonSource } from './canon.ts';
import { checkRepo, syncOutput, syncRepo } from './check.ts';
import { type Profile, PROFILES, readStackConfig, StackConfigError } from './config.ts';
import { allowedLine, isHeld } from './exceptions.ts';
import { type Finding, isDrift } from './findings.ts';
import { ghGitHub } from './gh.ts';
import { spawnRunner } from './guardrails-port.ts';
import { initConfig } from './init.ts';
import { ownVersion } from './own-packages.ts';
import type { PeersReader } from './peers.ts';
import { peersBaseline } from './peers-baseline.ts';
import { npmRegistryReader } from './registry.ts';
import type { RepoRulesReader } from './repo-rules.ts';
import { type RunProcess, SYNC_PR_WAIT, syncPr, withoutGhToken } from './sync-pr.ts';

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
	// GH_TOKEN нужен только gh: установка и хук его не получают (скрипты зависимостей читают окружение).
	const r = spawnSync(cmd, [...args], {
		cwd,
		stdio: 'inherit',
		env: { ...withoutGhToken(process.env), ...env },
	});
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

// Боевой adapter порта pnpm для группы peers: вывод захватывается, разбор — peersOutcome. Проверка
// идёт по локу, без установки; GH_TOKEN не нужен pnpm, как и установке в sync-pr.
const pnpmPeers: PeersReader = (cwd) => {
	const r = spawnSync('pnpm', ['peers', 'check', '--lockfile-only', '--json'], {
		cwd,
		encoding: 'utf8',
		maxBuffer: 1 << 30,
		env: withoutGhToken(process.env),
	});
	if (r.error) return { error: r.error.message };
	return { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr };
};

// Боевой adapter порта repo-rules: main не бросает, вывод собирается в строки без записи в поток.
const inProcessRepoRules: RepoRulesReader = (argv, env) => {
	const out: string[] = [];
	const err: string[] = [];
	const code = repoRulesMain(
		argv,
		env,
		(s) => void out.push(s),
		(s) => void err.push(s),
	);
	return { code, out: out.join('\n'), err: err.join('\n') };
};

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
		const { stdout, stderr } = syncOutput(syncRepo(repoRoot, loadCanon(cfg), cfg.exceptions));
		for (const line of stderr) console.warn(line);
		for (const line of stdout) console.log(line);
	} else if (command === 'check') {
		const cfg = readStackConfig(repoRoot);
		const { findings, notes } = checkRepo(repoRoot, loadCanon(cfg), cfg.exceptions, {
			ports: {
				peers: pnpmPeers,
				'repo-rules': inProcessRepoRules,
				guardrails: spawnRunner(repoRoot),
			},
			env: process.env,
			base: values.base,
		});
		for (const n of notes) console.warn(n);
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
					github: ghGitHub(repoRoot),
					registry: npmRegistryReader(),
					print: (stream, line) => (stream === 'out' ? console.log(line) : console.error(line)),
					peers: pnpmPeers,
					repoRules: inProcessRepoRules,
				},
			),
		);
	} else if (command === 'peers-baseline') {
		if (values.init && values['allow-grow']) fail('--init and --allow-grow do not go together');
		const cfg = readStackConfig(repoRoot);
		const mode = values.init ? 'init' : values['allow-grow'] ? 'grow' : 'lower';
		const r = peersBaseline(repoRoot, loadCanon(cfg), mode, pnpmPeers);
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
