import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

import { loadCanon, readCanonSource } from './canon.ts';
import { isOwnPackage, ownPackages, ownVersion } from './own-packages.ts';
import { OWNER_SOURCE } from './testkit.ts';
import { ACME_MANIFEST, ACME_SETTINGS, TEST_SETTINGS } from './testkit-sources.ts';

const manifest = {
	name: '@alxwlw/stack',
	version: '1.2.3',
	dependencies: { '@alxwlw/repo-rules': '1.2.3', yaml: '^2.9.1' },
};

test('ownPackages: записи @alxwlw/* каталога dev, затем зависимости @alxwlw/* пакета в его версии', () => {
	const dev = { '@alxwlw/stack': '1.2.3', oxlint: '1.94.0', '@alxwlw/tsconfig': '1.2.3' };
	expect(ownPackages(dev, manifest, TEST_SETTINGS.ownPackages)).toStrictEqual([
		{ name: '@alxwlw/stack', version: '1.2.3' },
		{ name: '@alxwlw/tsconfig', version: '1.2.3' },
		{ name: '@alxwlw/repo-rules', version: '1.2.3' },
	]);
});

test('ownPackages: версия зависимости — версия пакета, а не строка из dependencies', () => {
	const m = {
		name: '@alxwlw/stack',
		version: '1.2.3',
		dependencies: { '@alxwlw/repo-rules': 'workspace:*' },
	};
	expect(ownPackages({}, m, TEST_SETTINGS.ownPackages)).toStrictEqual([{ name: '@alxwlw/repo-rules', version: '1.2.3' }]);
});

test('ownPackages: имя и в каталоге, и в зависимостях — одна запись с версией каталога', () => {
	expect(ownPackages({ '@alxwlw/repo-rules': '1.0.0' }, manifest, TEST_SETTINGS.ownPackages)).toStrictEqual([
		{ name: '@alxwlw/repo-rules', version: '1.0.0' },
	]);
});

test('ownPackages: нет каталога dev, нет dependencies', () => {
	expect(ownPackages(undefined, { name: '@alxwlw/stack', version: '1.2.3' }, TEST_SETTINGS.ownPackages)).toStrictEqual([]);
	expect(ownPackages(undefined, manifest, TEST_SETTINGS.ownPackages)).toStrictEqual([
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

test.each([...OWNER_SOURCE.settings.profiles])(
	'canonFor: ownPackages не зависят от профиля %s и групп',
	(profile) => {
		const base = loadCanon({ profile: 'node', with: [], exceptions: [] }).ownPackages;
		expect(base.length).toBeGreaterThan(0);
		const groups = readCanonSource().groups;
		const withAll = [...groups.catalogs, ...groups.rules];
		expect(withAll.length).toBeGreaterThan(0);
		expect(loadCanon({ profile, with: [], exceptions: [] }).ownPackages).toStrictEqual(base);
		expect(loadCanon({ profile, with: withAll, exceptions: [] }).ownPackages).toStrictEqual(base);
	},
);

test('свои пакеты — по образцам канона: префикс scope и точное имя', () => {
	const dev = {
		'@acme/lint': '1.0.0',
		'acme-engine': '2.0.0',
		'acme-engine-extra': '2.0.0',
		'@acmex/y': '1.0.0',
		'@alxwlw/tsconfig': '9.9.9',
	};
	const own = ownPackages(dev, ACME_MANIFEST, ACME_SETTINGS.ownPackages);
	expect(own).toStrictEqual([
		{ name: '@acme/lint', version: '1.0.0' },
		{ name: 'acme-engine', version: '2.0.0' },
		{ name: '@acme/utils', version: '3.0.0' },
	]);
	expect(own).toHaveLength(3);
});

test('пустой список образцов — своих пакетов нет', () => {
	expect(ownPackages({ '@acme/lint': '1.0.0' }, ACME_MANIFEST, [])).toStrictEqual([]);
});

test.each([
	['@acme/lint', true],
	['acme-engine', true],
	['@acmex/y', false],
	['acme-engine-extra', false],
	['acme', false],
])('isOwnPackage(%s) = %p', (name, expected) => {
	expect(isOwnPackage(ACME_SETTINGS.ownPackages, name)).toBe(expected);
});

test('настоящие настройки канона: свои пакеты — scope @alxwlw/', () => {
	expect(OWNER_SOURCE.settings.ownPackages).toStrictEqual(['@alxwlw/']);
	expect(isOwnPackage(OWNER_SOURCE.settings.ownPackages, '@alxwlw/stack')).toBe(true);
	expect(isOwnPackage(OWNER_SOURCE.settings.ownPackages, '@alxwlx/stack')).toBe(false);
});
