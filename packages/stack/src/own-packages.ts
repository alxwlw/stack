import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Wanted } from './registry.ts';

export const SCOPE = '@alxwlw/';

export interface StackManifest {
	version: string;
	dependencies?: Record<string, string>;
}

// package.json пакета: он лежит рядом с src/, как canon/ (canonDir()).
export function ownManifest(): StackManifest {
	const path = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
	return JSON.parse(readFileSync(path, 'utf8')) as StackManifest;
}

export function ownVersion(): string {
	return ownManifest().version;
}

// Свои пакеты: записи SCOPE каталога dev в его порядке и с его версиями, затем зависимости SCOPE из
// manifest, которых в списке ещё нет, в версии самого пакета (строка из dependencies может быть
// диапазоном или `workspace:` и в `имя@версия` не годится).
export function ownPackages(
	dev: Record<string, string> | undefined,
	manifest: StackManifest,
): Wanted[] {
	const own: Wanted[] = Object.entries(dev ?? {})
		.filter(([name]) => name.startsWith(SCOPE))
		.map(([name, version]) => ({ name, version }));
	for (const name of Object.keys(manifest.dependencies ?? {})) {
		if (!name.startsWith(SCOPE) || own.some((p) => p.name === name)) continue;
		own.push({ name, version: manifest.version });
	}
	return own;
}
