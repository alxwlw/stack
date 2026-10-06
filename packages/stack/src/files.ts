import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Canon } from './canon.ts';
import type { Drift } from './findings.ts';

// Один проход и один предикат дрейфа для check и sync: check печатает план, sync его применяет,
// поэтому «после sync — check зелёный» для файлов выполняется по построению.
export function planFiles(repoRoot: string, canon: Canon): Drift[] {
	const plan: Drift[] = [];
	for (const f of canon.files) {
		const target = join(repoRoot, f.dest);
		const exists = existsSync(target);
		// create-if-absent принадлежит репозиторию после первого засева: расхождением считается
		// только отсутствие, содержимое не трогаем.
		if (
			exists &&
			(f.strategy === 'create-if-absent' || readFileSync(target, 'utf8') === f.content)
		) {
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
				writeFileSync(target, f.content);
			},
		});
	}
	return plan;
}
