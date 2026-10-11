import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

// Lockstep release (README «Releases»): every package under packages/ is published by the same
// tag, so a package added to the workspace must also join publish.yml's loop and version check,
// and the PACKAGES list that setVersion bumps in scripts/version.ts.
const root = join(import.meta.dir, '../../..');
const packages = readdirSync(join(root, 'packages')).sort();
const publish = readFileSync(join(root, '.github/workflows/publish.yml'), 'utf8');
const versionScript = readFileSync(join(root, 'scripts/version.ts'), 'utf8');
const version = (p: string): string =>
	JSON.parse(readFileSync(join(root, 'packages', p, 'package.json'), 'utf8')).version;

describe('lockstep release', () => {
	test('publish.yml publishes every package', () => {
		const loop = /for p in ([\w -]+); do/.exec(publish)?.[1]?.trim().split(/\s+/).sort();
		expect(loop).toEqual(packages);
	});
	test('publish.yml checks the tag against every package version', () => {
		for (const p of packages) expect(publish).toContain(`./packages/${p}/package.json`);
	});
	test('scripts/version.ts bumps every package', () => {
		const match = /const PACKAGES = \[([^\]]*)\]/.exec(versionScript);
		expect(match).not.toBeNull();
		const bumped = [...(match?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '').sort();
		expect(bumped).toEqual(packages);
	});
	test('all packages share one version', () => {
		expect(new Set(packages.map(version)).size).toBe(1);
	});
});
