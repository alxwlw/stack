import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Glob } from 'bun';
import { parse as parseYaml } from 'yaml';

import type { Canon } from './canon.ts';
import type { Finding } from './findings.ts';

const SKIP = /node_modules|\.worktrees|\.moon\/cache|(^|\/)(dist|build)\//;

export function checkInlineVersions(repoRoot: string, canon: Canon): Finding[] {
	if (!existsSync(join(repoRoot, 'pnpm-workspace.yaml'))) return [];
	const canonNames = new Set(Object.values(canon.catalogs).flatMap((e) => Object.keys(e)));
	const findings: Finding[] = [];
	for (const file of new Glob('**/package.json').scanSync({ cwd: repoRoot })) {
		if (SKIP.test(file)) continue;
		let pkg: Record<string, unknown>;
		try {
			pkg = JSON.parse(readFileSync(join(repoRoot, file), 'utf8')) as Record<string, unknown>;
		} catch (err) {
			findings.push({
				code: 'unreadable-file',
				target: file,
				message: `${file} does not parse: ${err instanceof Error ? err.message : String(err)}`,
			});
			continue;
		}
		for (const section of ['dependencies', 'devDependencies'] as const) {
			for (const [name, spec] of Object.entries((pkg[section] ?? {}) as Record<string, string>)) {
				if (!canonNames.has(name) || spec.startsWith('catalog:') || spec.startsWith('workspace:')) {
					continue;
				}
				findings.push({
					code: 'inline-version',
					target: `${file}:${name}`,
					message: `${name} is declared as "${spec}" instead of catalog:`,
					address: { name },
				});
			}
		}
	}
	return findings;
}

export function checkEnginesNode(repoRoot: string, canon: Canon): Finding[] {
	const path = join(repoRoot, 'package.json');
	if (!existsSync(path)) return [];
	let pkg: { engines?: { node?: string } };
	try {
		pkg = JSON.parse(readFileSync(path, 'utf8')) as { engines?: { node?: string } };
	} catch (err) {
		return [
			{
				code: 'unreadable-file',
				target: 'package.json',
				message: `package.json does not parse: ${err instanceof Error ? err.message : String(err)}`,
			},
		];
	}
	const range = pkg.engines?.node;
	if (!range) return [];
	if (Bun.semver.satisfies(canon.nodePin, range)) return [];
	return [
		{
			code: 'engines-node',
			target: 'package.json:engines.node',
			message: `"${range}" doesn't cover the canon pin ${canon.nodePin} — proto will rewrite .prototools from engines`,
		},
	];
}

// Формы дальше — только то, что нужно прочитать; настоящий dependabot.yml несёт больше полей.
interface DependabotYaml {
	updates?: unknown;
}

function ignoresAlxwlw(doc: unknown): boolean {
	const updates = (doc as DependabotYaml | null)?.updates;
	if (!Array.isArray(updates)) return false;
	return updates.some((u) => {
		const ignore = (u as { ignore?: unknown } | null)?.ignore;
		return (
			Array.isArray(ignore) &&
			ignore.some(
				(i) => (i as { 'dependency-name'?: unknown } | null)?.['dependency-name'] === '@alxwlw/*',
			)
		);
	});
}

export function checkDependabotIgnore(repoRoot: string): Finding[] {
	if (!existsSync(join(repoRoot, 'pnpm-workspace.yaml'))) return [];
	const path = join(repoRoot, '.github/dependabot.yml');
	if (!existsSync(path)) return [];
	const finding: Finding = {
		code: 'dependabot-ignore',
		target: '.github/dependabot.yml',
		message: 'missing an ignore for "@alxwlw/*" — the bot will fight the canon rollout',
	};
	let doc: unknown;
	try {
		doc = parseYaml(readFileSync(path, 'utf8'));
	} catch {
		return [
			{
				code: 'unreadable-file',
				target: '.github/dependabot.yml',
				message: '.github/dependabot.yml does not parse as YAML',
			},
		];
	}
	return ignoresAlxwlw(doc) ? [] : [finding];
}
