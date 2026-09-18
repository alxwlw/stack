import { checkCatalogs } from './catalogs.ts';
import type { StackConfig } from './config.ts';
import { checkDependabotIgnore, checkEnginesNode, checkInlineVersions } from './deps.ts';
import { checkFiles } from './files.ts';
import type { Finding } from './findings.ts';
import { canonDir } from './manifest.ts';

export function checkRepo(repoRoot: string, cfg: StackConfig, dir: string = canonDir()): Finding[] {
	const findings = [
		...checkFiles(repoRoot, cfg, dir),
		...checkCatalogs(repoRoot, cfg, dir),
		...checkInlineVersions(repoRoot, cfg, dir),
		...checkEnginesNode(repoRoot, cfg, dir),
		...checkDependabotIgnore(repoRoot, cfg),
	];
	// Исключение без находки — мёртвая запись: канон уже изменился, а оправдание осталось.
	const used = new Set(findings.map((f) => f.suppressedBy).filter(Boolean));
	for (const e of cfg.exceptions) {
		if (used.has(e)) continue;
		findings.push({
			code: 'stale-exception',
			target: e.file ?? `catalogs.${e.catalog}.${e.name}`,
			message: `exception no longer covers anything: ${e.reason}`,
		});
	}
	return findings;
}
