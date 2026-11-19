import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

import { loadCanon, readCanonSource } from './canon.ts';
import { ownPackages, ownVersion } from './own-packages.ts';

const manifest = {
	version: '1.2.3',
	dependencies: { '@alxwlw/repo-rules': '1.2.3', yaml: '^2.9.1' },
};

test('ownPackages: записи @alxwlw/* каталога dev, затем зависимости @alxwlw/* пакета в его версии', () => {
	const dev = { '@alxwlw/stack': '1.2.3', oxlint: '1.94.0', '@alxwlw/tsconfig': '1.2.3' };
	expect(ownPackages(dev, manifest)).toStrictEqual([
		{ name: '@alxwlw/stack', version: '1.2.3' },
		{ name: '@alxwlw/tsconfig', version: '1.2.3' },
		{ name: '@alxwlw/repo-rules', version: '1.2.3' },
	]);
});

test('ownPackages: версия зависимости — версия пакета, а не строка из dependencies', () => {
	const m = { version: '1.2.3', dependencies: { '@alxwlw/repo-rules': 'workspace:*' } };
	expect(ownPackages({}, m)).toStrictEqual([{ name: '@alxwlw/repo-rules', version: '1.2.3' }]);
});

test('ownPackages: имя и в каталоге, и в зависимостях — одна запись с версией каталога', () => {
	expect(ownPackages({ '@alxwlw/repo-rules': '1.0.0' }, manifest)).toStrictEqual([
		{ name: '@alxwlw/repo-rules', version: '1.0.0' },
	]);
});

test('ownPackages: нет каталога dev, нет dependencies', () => {
	expect(ownPackages(undefined, { version: '1.2.3' })).toStrictEqual([]);
	expect(ownPackages(undefined, manifest)).toStrictEqual([
		{ name: '@alxwlw/repo-rules', version: '1.2.3' },
	]);
});

test('настоящий канон: repo-rules среди своих пакетов, все они в версии stack', () => {
	const own = loadCanon({ profile: 'node', with: [], exceptions: [] }).ownPackages;
	expect(own.map((p) => p.name)).toContain('@alxwlw/repo-rules');
	expect([...new Set(own.map((p) => p.version))]).toStrictEqual([ownVersion()]);
	expect(readCanonSource().manifest.version).toBe(ownVersion());
});

test('ownVersion — version из packages/stack/package.json', () => {
	const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8')) as {
		version: string;
	};
	expect(ownVersion()).toBe(pkg.version);
	expect(ownVersion()).toMatch(/^\d+\.\d+\.\d+/);
});
