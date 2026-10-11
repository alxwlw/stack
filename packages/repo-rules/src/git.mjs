// @ts-check
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export class RepoRulesError extends Error {}

/**
 * @param {string} root
 * @param {string[]} args
 * @returns {string}
 */
export function git(root, args) {
	try {
		return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
			cwd: root,
			encoding: 'utf8',
			maxBuffer: 256 * 1024 * 1024,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
	} catch (e) {
		const err = /** @type {{ stderr?: string, message: string }} */ (e);
		throw new RepoRulesError(`git ${args[0]} failed: ${(err.stderr || err.message).trim()}`);
	}
}

/**
 * The repository root containing `dir`.
 * @param {string} dir
 * @returns {string}
 */
export function repoRoot(dir) {
	return git(dir, ['rev-parse', '--show-toplevel']).trim();
}

/**
 * Tracked paths; gitlinks (submodules) and symlinks (mode 120000) left out.
 * @param {string} root
 * @returns {string[]}
 */
export function trackedFiles(root) {
	const out = git(root, ['ls-files', '-s', '-z']);
	/** @type {string[]} */
	const files = [];
	for (const rec of out.split('\0')) {
		if (!rec) continue;
		const tab = rec.indexOf('\t');
		if (rec.startsWith('160000 ')) continue;
		if (rec.startsWith('120000 ')) continue;
		files.push(rec.slice(tab + 1));
	}
	return [...new Set(files)];
}

/**
 * File text, or null when it is missing on disk or binary (NUL in the first 8 KiB).
 * @param {string} root
 * @param {string} path
 * @returns {string | null}
 */
export function readText(root, path) {
	let buf;
	try {
		buf = readFileSync(join(root, path));
	} catch {
		return null;
	}
	if (buf.subarray(0, 8192).includes(0)) return null;
	return buf.toString('utf8');
}

/**
 * @param {string} text
 * @returns {number}
 */
export function countLines(text) {
	if (text === '') return 0;
	let n = 0;
	for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
	return text.endsWith('\n') ? n : n + 1;
}
