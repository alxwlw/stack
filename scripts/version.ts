import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { SEMVER_RE } from './semver.ts';

const PACKAGES = ['stack', 'oxlint-config', 'tsconfig', 'repo-rules'];

/**
 * Проставляет одну lockstep-версию четырём пакетам и её же — записям `@alxwlw/*`
 * в `canon/catalogs.json`. Фикстуры не трогает: в них только семя, каталоги приносит sync в тестах.
 */
export function setVersion(root: string, version: string): void {
	if (!SEMVER_RE.test(version)) {
		throw new Error(`version is not semver: "${version}"`);
	}
	for (const pkg of PACKAGES) {
		const path = join(root, 'packages', pkg, 'package.json');
		const data = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
		data.version = version;
		writeFileSync(path, `${JSON.stringify(data, null, '\t')}\n`);
	}
	const catalogsPath = join(root, 'packages', 'stack', 'canon', 'catalogs.json');
	const catalogs = JSON.parse(readFileSync(catalogsPath, 'utf8')) as Record<
		string,
		Record<string, string>
	>;
	for (const entries of Object.values(catalogs)) {
		for (const name of Object.keys(entries)) {
			if (name.startsWith('@alxwlw/')) entries[name] = version;
		}
	}
	writeFileSync(catalogsPath, `${JSON.stringify(catalogs, null, '\t')}\n`);
}

if (import.meta.main) {
	const version = Bun.argv[2] ?? '';
	setVersion(process.cwd(), version);
}
