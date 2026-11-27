import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Wanted } from './registry.ts';

export interface StackManifest {
	name: string;
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

// Образец, кончающийся на `/`, — префикс имени (scope); любой другой — точное имя.
export function isOwnPackage(patterns: readonly string[], name: string): boolean {
	return patterns.some((p) => (p.endsWith('/') ? name.startsWith(p) : name === p));
}

// Свои пакеты: записи каталога dev по образцам канона в его порядке и с его версиями, затем
// зависимости из manifest по тем же образцам, которых в списке ещё нет, в версии самого пакета
// (строка из dependencies может быть диапазоном или `workspace:` и в `имя@версия` не годится).
export function ownPackages(
	dev: Record<string, string> | undefined,
	manifest: StackManifest,
	patterns: readonly string[],
): Wanted[] {
	const own: Wanted[] = Object.entries(dev ?? {})
		.filter(([name]) => isOwnPackage(patterns, name))
		.map(([name, version]) => ({ name, version }));
	for (const name of Object.keys(manifest.dependencies ?? {})) {
		if (!isOwnPackage(patterns, name) || own.some((p) => p.name === name)) continue;
		own.push({ name, version: manifest.version });
	}
	return own;
}
