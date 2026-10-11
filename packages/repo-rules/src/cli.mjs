#!/usr/bin/env node
// @ts-check
/** Bin entry: `repo-rules check | diff --base <ref> | baseline [--init] [--allow-grow]`. */
import { RepoRulesError } from './git.mjs';
import { run } from './main.mjs';

try {
	process.exitCode = run(process.argv.slice(2), process.env, (s) => process.stdout.write(`${s}\n`));
} catch (e) {
	// 2, never 0 or 1: an error must not read as «clean» or as «violations found».
	if (e instanceof RepoRulesError) process.stderr.write(`repo-rules: ${e.message}\n`);
	else process.stderr.write(`repo-rules: internal error: ${/** @type {Error} */ (e).stack ?? e}\n`);
	process.exitCode = 2;
}
