import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { StackConfig } from './config.ts';
import type { Drift } from './findings.ts';
import { canonDir, filesFor } from './manifest.ts';

// Один проход и один предикат дрейфа для check и sync: check печатает план, sync его применяет,
// поэтому «после sync — check зелёный» для файлов выполняется по построению.
export function planFiles(repoRoot: string, cfg: StackConfig, dir: string = canonDir()): Drift[] {
	const plan: Drift[] = [];
	for (const f of filesFor(cfg, dir)) {
		const target = join(repoRoot, f.dest);
		const want = readFileSync(join(dir, f.src), 'utf8');
		const exists = existsSync(target);
		// create-if-absent принадлежит репозиторию после первого засева: расхождением считается
		// только отсутствие, содержимое не трогаем.
		if (exists && (f.strategy === 'create-if-absent' || readFileSync(target, 'utf8') === want)) {
			continue;
		}
		plan.push({
			code: exists ? 'file-drift' : 'file-missing',
			target: f.dest,
			message: exists ? `${f.dest} differs from canon` : `canon file missing: ${f.dest}`,
			address: { file: f.dest },
			fix: `${f.strategy === 'create-if-absent' ? 'seeded' : 'updated'} ${f.dest}`,
			apply() {
				mkdirSync(dirname(target), { recursive: true });
				writeFileSync(target, want);
			},
		});
	}
	return plan;
}
