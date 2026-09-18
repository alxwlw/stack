import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { StackConfig } from './config.ts';
import type { Finding } from './findings.ts';
import { canonDir, filesFor } from './manifest.ts';

export interface FileChange {
	dest: string;
	action: 'written' | 'seeded' | 'unchanged';
}

export function syncFiles(
	repoRoot: string,
	cfg: StackConfig,
	dir: string = canonDir(),
): FileChange[] {
	const changes: FileChange[] = [];
	for (const f of filesFor(cfg, dir)) {
		const target = join(repoRoot, f.dest);
		const want = readFileSync(join(dir, f.src), 'utf8');
		const exists = existsSync(target);
		if (f.strategy === 'create-if-absent') {
			// Файл принадлежит репозиторию после первого засева — содержимое не трогаем.
			if (exists) {
				changes.push({ dest: f.dest, action: 'unchanged' });
				continue;
			}
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, want);
			changes.push({ dest: f.dest, action: 'seeded' });
			continue;
		}
		if (exists && readFileSync(target, 'utf8') === want) {
			changes.push({ dest: f.dest, action: 'unchanged' });
			continue;
		}
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, want);
		changes.push({ dest: f.dest, action: 'written' });
	}
	return changes;
}

export function checkFiles(
	repoRoot: string,
	cfg: StackConfig,
	dir: string = canonDir(),
): Finding[] {
	const findings: Finding[] = [];
	for (const f of filesFor(cfg, dir)) {
		const target = join(repoRoot, f.dest);
		const exception = cfg.exceptions.find((e) => e.file === f.dest);
		if (!existsSync(target)) {
			findings.push({
				code: 'file-missing',
				target: f.dest,
				message: `canon file missing: ${f.dest}`,
				...(exception ? { suppressedBy: exception } : {}),
			});
			continue;
		}
		// create-if-absent принадлежит репозиторию: расхождением считается только отсутствие.
		if (f.strategy === 'create-if-absent') continue;
		if (readFileSync(target, 'utf8') !== readFileSync(join(dir, f.src), 'utf8')) {
			findings.push({
				code: 'file-drift',
				target: f.dest,
				message: `${f.dest} differs from canon`,
				...(exception ? { suppressedBy: exception } : {}),
			});
		}
	}
	return findings;
}
