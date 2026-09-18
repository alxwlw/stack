import { cpSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

import { setVersion } from './version.ts';

const REPO_ROOT = join(import.meta.dir, '..');

// Копируем только то, что setVersion читает и пишет — не весь packages/ (там живут
// pnpm-симлинки на node_modules).
function fixtureRoot(): string {
	const root = mkdtempSync(join(tmpdir(), 'stack-ver-'));
	for (const pkg of ['stack', 'oxlint-config', 'tsconfig']) {
		mkdirSync(join(root, 'packages', pkg), { recursive: true });
		cpSync(
			join(REPO_ROOT, 'packages', pkg, 'package.json'),
			join(root, 'packages', pkg, 'package.json'),
		);
	}
	mkdirSync(join(root, 'packages', 'stack', 'canon'), { recursive: true });
	cpSync(
		join(REPO_ROOT, 'packages', 'stack', 'canon', 'catalogs.json'),
		join(root, 'packages', 'stack', 'canon', 'catalogs.json'),
	);
	return root;
}

test('проставляет одну версию пакетам и каталогу канона', () => {
	const root = fixtureRoot();
	setVersion(root, '1.2.3');
	for (const pkg of ['stack', 'oxlint-config', 'tsconfig']) {
		const data = JSON.parse(readFileSync(join(root, 'packages', pkg, 'package.json'), 'utf8')) as {
			version: string;
		};
		expect(data.version).toBe('1.2.3');
	}
	const catalogs = JSON.parse(
		readFileSync(join(root, 'packages/stack/canon/catalogs.json'), 'utf8'),
	) as Record<string, Record<string, string>>;
	expect(catalogs.dev?.['@alxwlw/stack']).toBe('1.2.3');
	expect(catalogs.dev?.['@alxwlw/oxlint-config']).toBe('1.2.3');
	expect(catalogs.dev?.['@alxwlw/tsconfig']).toBe('1.2.3');
});

test('не трогает записи каталога, чужие @alxwlw/*', () => {
	const root = fixtureRoot();
	setVersion(root, '1.2.3');
	const catalogs = JSON.parse(
		readFileSync(join(root, 'packages/stack/canon/catalogs.json'), 'utf8'),
	) as Record<string, Record<string, string>>;
	// libs-каталог не несёт @alxwlw/* записей вообще — контроль, что цикл по группам не путает их.
	expect(catalogs.libs?.['@alxwlw/stack']).toBeUndefined();
	expect(catalogs.dev?.oxlint).not.toBe('1.2.3');
});

test('отвергает версию не по semver, не трогая файлы', () => {
	const root = fixtureRoot();
	const before = readFileSync(join(root, 'packages/stack/package.json'), 'utf8');
	expect(() => setVersion(root, 'v1.2')).toThrow();
	expect(readFileSync(join(root, 'packages/stack/package.json'), 'utf8')).toBe(before);
});
