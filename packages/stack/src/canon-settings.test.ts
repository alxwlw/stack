import { expect, test } from 'bun:test';

import { canonFor, readCanonSource } from './canon.ts';
import { checkSettings, syncPrText } from './canon-settings.ts';
import { StackConfigError } from './config.ts';
import { repoDir } from './testkit.ts';
import { ACME_SETTINGS, TEST_SETTINGS, testSource } from './testkit-sources.ts';

const valid = (): Record<string, unknown> => ({ ...structuredClone(ACME_SETTINGS) });
// Манифест пишет .oxlintrc.json — засев чужого канона называет его, и без записи настройки не читаются.
const dirWith = (settings: string | null): string =>
	repoDir({
		'manifest.json':
			'{ "files": [{ "src": "files/o", "dest": ".oxlintrc.json", "appliesTo": ["web"] }] }',
		'files/o': '{}',
		'catalogs.json': '{ "dev": {} }',
		...(settings === null ? {} : { 'settings.json': settings }),
	});

test('checkSettings отдаёт верные настройки как есть', () => {
	expect(checkSettings(valid())).toStrictEqual(ACME_SETTINGS);
});

test.each([
	['profiles', []],
	['profiles', ['web', 'web']],
	['profiles', ['web', '']],
	['profiles', 'web'],
	['profiles', [7]],
	['configFile', ''],
	['configFile', '../x.jsonc'],
	['configFile', 'a/b.jsonc'],
	['configFile', 'a\\b.jsonc'],
	['configFile', '..'],
	['configFile', '.'],
	['configFile', 7],
	['command', ''],
	['command', 'my stack'],
	['command', null],
	['ownPackages', '@acme/'],
	['ownPackages', ['@acme']],
	['ownPackages', ['']],
	['ownPackages', ['@acme/x/']],
	['syncPr', 'text'],
	['syncPr', null],
])('%s = %j — ошибка пакета канона с именем ключа', (key, value) => {
	expect(() => checkSettings({ ...valid(), [key]: value })).toThrow(`canon settings: "${key}"`);
});

test.each([
	'profiles',
	'configFile',
	'command',
	'ownPackages',
	'syncPr',
	'groups',
	'deprecatedGroups',
	'rules',
])('нет ключа %s — та же ошибка', (key) => {
	const raw = Object.fromEntries(Object.entries(valid()).filter(([k]) => k !== key));
	expect(() => checkSettings(raw)).toThrow(`canon settings: "${key}"`);
});

test.each(['title', 'body', 'closeComment', 'upToDateComment'])(
	'syncPr.%s: не строка, пусто, нет ключа',
	(key) => {
		for (const bad of [7, '', undefined]) {
			const syncPr = { ...ACME_SETTINGS.syncPr, [key]: bad };
			expect(() => checkSettings({ ...valid(), syncPr })).toThrow(
				`canon settings: "syncPr.${key}"`,
			);
		}
	},
);

test('лишний ключ называется по имени', () => {
	expect(() => checkSettings({ ...valid(), profile: ['web'] })).toThrow(
		'canon settings: unknown key "profile"',
	);
	const syncPr = { ...ACME_SETTINGS.syncPr, tittle: 'x' };
	expect(() => checkSettings({ ...valid(), syncPr })).toThrow(
		'canon settings: "syncPr" has unknown key "tittle"',
	);
});

test.each([[[]], [null], ['x']])('настройки %j — не объект', (raw) => {
	expect(() => checkSettings(raw)).toThrow('canon settings: must be an object');
});

test('опечатка в подстановке — ошибка с ключом и именем, чужая подстановка шаблона — тоже', () => {
	const body = { ...ACME_SETTINGS.syncPr, body: 'Canon {verison}\n{files}' };
	expect(() => checkSettings({ ...valid(), syncPr: body })).toThrow(
		'canon settings: "syncPr.body" has unknown placeholder {verison}, expected one of: {version}, {files}',
	);
	const title = { ...ACME_SETTINGS.syncPr, title: 'canon {url}' };
	expect(() => checkSettings({ ...valid(), syncPr: title })).toThrow(
		'"syncPr.title" has unknown placeholder {url}',
	);
	const upToDate = { ...ACME_SETTINGS.syncPr, upToDateComment: 'Canon {version} is in {url}' };
	expect(() => checkSettings({ ...valid(), syncPr: upToDate })).toThrow(
		'"syncPr.upToDateComment" has unknown placeholder {url}',
	);
});

test('пустой список образцов и фигурные скобки без имени подстановки законны', () => {
	const syncPr = { ...ACME_SETTINGS.syncPr, title: 'canon {} {1} { version }' };
	expect(checkSettings({ ...valid(), ownPackages: [], syncPr }).ownPackages).toStrictEqual([]);
});

test('syncPrText подставляет значения своего шаблона, повтор подстановки — каждый раз', () => {
	const t = ACME_SETTINGS.syncPr;
	expect(syncPrText(t, 'title', { version: '1.2.3' })).toBe('chore: acme canon 1.2.3');
	expect(syncPrText(t, 'closeComment', { version: '1.2.3', url: 'https://x/pull/9' })).toBe(
		'Superseded by https://x/pull/9 (1.2.3).',
	);
	expect(syncPrText({ ...t, title: 'v{version}, {version}' }, 'title', { version: '2' })).toBe(
		'v2, 2',
	);
});

test('подстановка идёт в один проход: вставленное не разбирается заново', () => {
	const t = { ...ACME_SETTINGS.syncPr, body: '{files}|{version}' };
	expect(syncPrText(t, 'body', { version: '9', files: '- {version}/$&.txt\n' })).toBe(
		'- {version}/$&.txt\n|9',
	);
	expect(syncPrText(t, 'body', { files: '- {version}\n', version: '9' })).toBe('- {version}\n|9');
});

test('readCanonSource отдаёт настройки каталога, canonFor переносит их в Canon', () => {
	expect(readCanonSource(dirWith(JSON.stringify(ACME_SETTINGS))).settings).toStrictEqual(
		ACME_SETTINGS,
	);
	expect(canonFor(testSource(), { profile: 'node', with: [], exceptions: [] }).settings).toBe(
		TEST_SETTINGS,
	);
});

test('нет settings.json или он не JSON — ошибка называет файл', () => {
	expect(() => readCanonSource(dirWith(null))).toThrow(/settings\.json/);
	expect(() => readCanonSource(dirWith('{ nope'))).toThrow(
		'canon settings: settings.json does not parse as JSON',
	);
});

test('нарушение настроек — ошибка пакета, не StackConfigError', () => {
	let caught: unknown;
	try {
		readCanonSource(dirWith('{}'));
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(Error);
	expect(caught).not.toBeInstanceOf(StackConfigError);
});
