/**
 * npm normalises the manifest it sends to the registry, and it does so SILENTLY apart from one
 * warning line. A `bin` value written as `./src/cli.ts` is dropped entirely — the published
 * package then has no `stack` executable at all, breaking both the README quick start and the
 * `stack check` step of the reusable CI workflow. Caught for real on the first publish attempt
 * of 1.0.0; the warning text names the already-stripped value, not the leading `./` that causes
 * it, so it is easy to misread.
 *
 * This asserts on the general class, not on today's rule: any manifest npm feels the need to
 * auto-correct fails the suite before it can reach the registry.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

const ROOT = join(import.meta.dir, '..', '..', '..');

for (const pkg of ['stack', 'oxlint-config', 'tsconfig']) {
	test(`npm не правит манифест @alxwlw/${pkg} при публикации`, () => {
		const res = spawnSync('npm', ['publish', '--dry-run', '--provenance=false'], {
			cwd: join(ROOT, 'packages', pkg),
			encoding: 'utf8',
		});
		expect(res.status).toBe(0);
		const corrections = `${res.stdout}${res.stderr}`
			.split('\n')
			.filter((l) => l.includes('auto-corrected') || l.includes('was invalid and removed'));
		expect(corrections).toEqual([]);
	});
}
