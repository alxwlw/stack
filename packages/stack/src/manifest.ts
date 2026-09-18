import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Profile, StackConfig } from './config.ts';

export type SyncStrategy = 'verbatim' | 'create-if-absent';

export interface CanonFile {
	src: string;
	dest: string;
	appliesTo: Profile[];
	strategy?: SyncStrategy;
	/** Группа, включаемая через `with` в .stack.jsonc. Без группы файл обязателен всем. */
	group?: string;
}

export function canonDir(): string {
	return join(dirname(fileURLToPath(import.meta.url)), '..', 'canon');
}

export function loadManifest(dir: string = canonDir()): CanonFile[] {
	const raw = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
		files: CanonFile[];
	};
	return raw.files;
}

export function filesFor(cfg: StackConfig, dir: string = canonDir()): CanonFile[] {
	return loadManifest(dir).filter(
		(f) => f.appliesTo.includes(cfg.profile) && (f.group == null || cfg.with.includes(f.group)),
	);
}
