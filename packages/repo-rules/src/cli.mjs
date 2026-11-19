#!/usr/bin/env node
// @ts-check
/** Bin entry: `repo-rules check | diff --base <ref> | baseline [--init] [--allow-grow] | baseline --drop-fixed`. */
import { main } from './main.mjs';

// Attached before the first write: a closed pipe (EPIPE) or a full disk (ENOSPC) on stdout is one
// error line and exit 2, never an unhandled 'error' stack that exits 1.
let stdoutFailed = false;
process.stdout.on('error', (e) => {
	if (!stdoutFailed) process.stderr.write(`repo-rules: ${e.message}\n`);
	stdoutFailed = true;
	process.exitCode = 2;
});

process.exitCode = main(
	process.argv.slice(2),
	process.env,
	(s) => process.stdout.write(`${s}\n`),
	(s) => process.stderr.write(`${s}\n`),
);
