import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { syncCatalogs } from '../packages/stack/src/catalogs.ts';
import { readStackConfig } from '../packages/stack/src/config.ts';
import { SEMVER_RE } from './semver.ts';

const PACKAGES = ['stack', 'oxlint-config', 'tsconfig'];

/**
 * Проставляет одну lockstep-версию трём пакетам канона и её же — записям `@alxwlw/*`
 * в `canon/catalogs.json`. Не трогает фикстуры: см. `resyncFixtures`, вызываемую отдельно
 * из точки входа, чтобы unit-тест мог гонять `setVersion` на минимальной копии дерева.
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

/**
 * `setVersion` бампает `canon/catalogs.json`, а те же три записи `@alxwlw/*` лежат
 * закоммиченными в `fixtures/{node,contracts}/pnpm-workspace.yaml` (`infra` каталогов не несёт).
 * Без этого шага канарейка `bun test` (`закоммиченная фикстура уже синхронизирована`) красит
 * каждый релиз — см. docs/release.md.
 */
export function resyncFixtures(root: string): void {
	for (const profile of ['node', 'contracts', 'infra']) {
		const dir = join(root, 'fixtures', profile);
		if (!existsSync(join(dir, 'pnpm-workspace.yaml'))) continue;
		syncCatalogs(dir, readStackConfig(dir));
	}
}

if (import.meta.main) {
	const version = Bun.argv[2] ?? '';
	setVersion(process.cwd(), version);
	resyncFixtures(process.cwd());
}
