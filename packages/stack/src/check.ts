import { checkCatalogs } from './catalogs.ts';
import type { StackConfig } from './config.ts';
import { checkDependabotIgnore, checkEnginesNode, checkInlineVersions } from './deps.ts';
import { checkFiles } from './files.ts';
import { applyExceptions, type Finding } from './findings.ts';
import { canonDir } from './manifest.ts';

export function checkRepo(repoRoot: string, cfg: StackConfig, dir: string = canonDir()): Finding[] {
	return applyExceptions(
		[
			...checkFiles(repoRoot, cfg, dir),
			...checkCatalogs(repoRoot, cfg, dir),
			...checkInlineVersions(repoRoot, cfg, dir),
			...checkEnginesNode(repoRoot, cfg, dir),
			...checkDependabotIgnore(repoRoot, cfg),
		],
		cfg.exceptions,
	);
}
