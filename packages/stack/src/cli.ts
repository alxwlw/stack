#!/usr/bin/env bun
import { main as repoRulesMain } from '@alxwlw/repo-rules';

import { runCommand } from './command.ts';
import { ghGitHub } from './gh.ts';
import { spawnRunner } from './guardrails-port.ts';
import type { Print } from './output.ts';
import { pnpmPeers } from './peers-port.ts';
import { npmRegistryReader } from './registry.ts';
import { inProcessRepoRules } from './repo-rules-port.ts';
import { runProcess } from './sync-pr-port.ts';

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

// Вход: порт печати пишет строку сразу и через console — так сохраняется порядок с выводом дочерних
// процессов sync-pr, и вывод не обрывается при выходе.
const print: Print = (stream, line) => (stream === 'out' ? console.log(line) : console.error(line));
const env = process.env;
process.exit(
	await runCommand(
		{ argv: Bun.argv.slice(2), env, cwd: process.cwd() },
		{
			print,
			peers: pnpmPeers(env),
			repoRules: inProcessRepoRules,
			guardrails: (repoRoot) => spawnRunner(repoRoot, env),
			run: runProcess(env, print),
			github: (repoRoot) => ghGitHub(repoRoot),
			registry: npmRegistryReader(),
		},
	),
);
