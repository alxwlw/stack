import { readFileSync } from 'node:fs';

import { expect, test } from 'bun:test';

import { knownGroups } from './canon.ts';
import { readStackConfig, StackConfigError, stackConfigSchema } from './config.ts';
import { OWNER_SOURCE, repoDir, SCHEMA_PATH } from './testkit.ts';
import { ACME_SETTINGS, TEST_SETTINGS } from './testkit-sources.ts';

test('читает профиль, группы и исключения, не спотыкаясь о комментарии', () => {
	const dir = repoDir({
		'.stack.jsonc': `{
		// профиль репозитория
		"profile": "node",
		"with": ["libs"],
		"exceptions": [{ "catalog": "libs", "name": "react", "reason": "миграция" }]
	}`,
	});
	const cfg = readStackConfig(dir, OWNER_SOURCE.settings);
	expect(cfg.profile).toBe('node');
	expect(cfg.with).toEqual(['libs']);
	expect(cfg.exceptions[0]?.name).toBe('react');
});

test('по умолчанию groups и exceptions пустые', () => {
	const cfg = readStackConfig(
		repoDir({ '.stack.jsonc': '{ "profile": "infra" }' }),
		OWNER_SOURCE.settings,
	);
	expect(cfg.with).toEqual([]);
	expect(cfg.exceptions).toEqual([]);
});

test('неизвестный профиль — ошибка', () => {
	expect(() =>
		readStackConfig(repoDir({ '.stack.jsonc': '{ "profile": "python" }' }), OWNER_SOURCE.settings),
	).toThrow(StackConfigError);
});

test('исключение без reason — ошибка', () => {
	const dir = repoDir({
		'.stack.jsonc': '{ "profile": "node", "exceptions": [{ "file": ".editorconfig" }] }',
	});
	expect(() => readStackConfig(dir, OWNER_SOURCE.settings)).toThrow(/reason/);
});

test('исключение — null в массиве — StackConfigError, а не сырой TypeError', () => {
	const dir = repoDir({ '.stack.jsonc': '{ "profile": "node", "exceptions": [null] }' });
	expect(() => readStackConfig(dir, OWNER_SOURCE.settings)).toThrow(StackConfigError);
});

test('исключение и на файл, и на запись каталога — ошибка', () => {
	const dir = repoDir({
		'.stack.jsonc':
			'{ "profile": "node", "exceptions": [{ "file": ".editorconfig", "catalog": "dev", "name": "oxlint", "reason": "x" }] }',
	});
	expect(() => readStackConfig(dir, OWNER_SOURCE.settings)).toThrow(StackConfigError);
});

test('отсутствие файла — ошибка с подсказкой про init', () => {
	const dir = repoDir({});
	expect(() => readStackConfig(dir, OWNER_SOURCE.settings)).toThrow(/stack init/);
});

test('исключение: file и catalog без name — ошибка', () => {
	const dir = repoDir({
		'.stack.jsonc':
			'{ "profile": "node", "exceptions": [{ "file": ".editorconfig", "catalog": "dev", "reason": "x" }] }',
	});
	expect(() => readStackConfig(dir, OWNER_SOURCE.settings)).toThrow(StackConfigError);
});

test('исключение: file и name без catalog — ошибка', () => {
	const dir = repoDir({
		'.stack.jsonc':
			'{ "profile": "node", "exceptions": [{ "file": ".editorconfig", "name": "oxlint", "reason": "x" }] }',
	});
	expect(() => readStackConfig(dir, OWNER_SOURCE.settings)).toThrow(StackConfigError);
});

test('исключение: только catalog, без file и name — ошибка', () => {
	const dir = repoDir({
		'.stack.jsonc': '{ "profile": "node", "exceptions": [{ "catalog": "dev", "reason": "x" }] }',
	});
	expect(() => readStackConfig(dir, OWNER_SOURCE.settings)).toThrow(StackConfigError);
});

test('нечитаемый JSONC — ошибка', () => {
	const dir = repoDir({ '.stack.jsonc': '{ "profile": "node", ' });
	expect(() => readStackConfig(dir, OWNER_SOURCE.settings)).toThrow(StackConfigError);
});

test('"with" не массив строк — ошибка', () => {
	const dir = repoDir({ '.stack.jsonc': '{ "profile": "node", "with": "libs" }' });
	expect(() => readStackConfig(dir, OWNER_SOURCE.settings)).toThrow(StackConfigError);
});

test('"exceptions" не массив — ошибка', () => {
	const dir = repoDir({ '.stack.jsonc': '{ "profile": "node", "exceptions": {} }' });
	expect(() => readStackConfig(dir, OWNER_SOURCE.settings)).toThrow(StackConfigError);
});

test('исключение: file и пустой catalog — ошибка', () => {
	const dir = repoDir({
		'.stack.jsonc':
			'{ "profile": "node", "exceptions": [{ "file": "x", "catalog": "", "reason": "r" }] }',
	});
	expect(() => readStackConfig(dir, OWNER_SOURCE.settings)).toThrow(StackConfigError);
});

test('исключение: file и пустой name — ошибка', () => {
	const dir = repoDir({
		'.stack.jsonc':
			'{ "profile": "node", "exceptions": [{ "file": "x", "name": "", "reason": "r" }] }',
	});
	expect(() => readStackConfig(dir, OWNER_SOURCE.settings)).toThrow(StackConfigError);
});

test('исключение: пустой file — ошибка', () => {
	const dir = repoDir({
		'.stack.jsonc': '{ "profile": "node", "exceptions": [{ "file": "", "reason": "r" }] }',
	});
	expect(() => readStackConfig(dir, OWNER_SOURCE.settings)).toThrow(StackConfigError);
});

test('исключение: catalog и пустой name — ошибка', () => {
	const dir = repoDir({
		'.stack.jsonc':
			'{ "profile": "node", "exceptions": [{ "catalog": "dev", "name": "", "reason": "r" }] }',
	});
	expect(() => readStackConfig(dir, OWNER_SOURCE.settings)).toThrow(StackConfigError);
});

test('исключение: только name, без file и catalog — ошибка', () => {
	const dir = repoDir({
		'.stack.jsonc': '{ "profile": "node", "exceptions": [{ "name": "oxlint", "reason": "r" }] }',
	});
	expect(() => readStackConfig(dir, OWNER_SOURCE.settings)).toThrow(StackConfigError);
});

function configError(text: string): Error {
	try {
		readStackConfig(repoDir({ '.stack.jsonc': text }), OWNER_SOURCE.settings);
	} catch (error) {
		return error as Error;
	}
	throw new Error('readStackConfig не бросил');
}

const KEYS = '$schema, profile, with, exceptions';
// Каждая строка — вход, который schema.json запрещает: читатель обязан отклонить его тем же правилом.
const rejected: [string, string, string][] = [
	[
		'опечатка в ключе верхнего уровня',
		'{ "profile": "node", "wiht": ["libs"], "extra": 1 }',
		`.stack.jsonc: unknown key "wiht", expected one of: ${KEYS}`,
	],
	[
		'ключ отличается регистром',
		'{ "Profile": "node" }',
		`.stack.jsonc: unknown key "Profile", expected one of: ${KEYS}`,
	],
	[
		// parse из jsonc-parser пишет obj['__proto__'] = value: объект подменяет прототип, скаляр теряется.
		'ключ __proto__ с объектом',
		'{ "profile": "node", "__proto__": { "with": ["libs"] } }',
		`.stack.jsonc: unknown key "__proto__", expected one of: ${KEYS}`,
	],
	[
		'ключ __proto__ со скаляром',
		'{ "profile": "node", "__proto__": 5 }',
		`.stack.jsonc: unknown key "__proto__", expected one of: ${KEYS}`,
	],
	[
		'__proto__ — единственный ключ',
		'{ "__proto__": { "profile": "node" } }',
		`.stack.jsonc: unknown key "__proto__", expected one of: ${KEYS}`,
	],
	[
		'ключ с переводом строки остаётся в одной строке сообщения',
		'{ "profile": "node", "a\\nb": 1 }',
		`.stack.jsonc: unknown key "a\\nb", expected one of: ${KEYS}`,
	],
	[
		'исключение с ключом __proto__',
		'{ "profile": "node", "exceptions": [{ "file": "a", "reason": "r", "__proto__": {} }] }',
		'.stack.jsonc: exception has unknown key "__proto__", expected one of: file, catalog, name, reason: {"file":"a","reason":"r","__proto__":{}}',
	],
	[
		'исключение с лишним ключом',
		'{ "profile": "node", "exceptions": [{ "file": "a", "reason": "r", "note": "x" }] }',
		'.stack.jsonc: exception has unknown key "note", expected one of: file, catalog, name, reason: {"file":"a","reason":"r","note":"x"}',
	],
	[
		'причина — число',
		'{ "profile": "node", "exceptions": [{ "file": "a", "reason": 5 }] }',
		'.stack.jsonc: exception "reason" must be a non-empty string: {"file":"a","reason":5}',
	],
	[
		'$schema — не строка',
		'{ "$schema": 1, "profile": "node" }',
		'.stack.jsonc: "$schema" must be a string',
	],
	[
		'верхний уровень — массив',
		'[{ "profile": "node" }]',
		'.stack.jsonc: top level must be an object',
	],
	['верхний уровень — строка', '"node"', '.stack.jsonc: top level must be an object'],
	['верхний уровень — null', 'null', '.stack.jsonc: top level must be an object'],
	[
		'исключение — строка',
		'{ "profile": "node", "exceptions": ["a"] }',
		'.stack.jsonc: exception must be an object: "a"',
	],
	[
		'with — null',
		'{ "profile": "node", "with": null }',
		'.stack.jsonc: "with" must be an array of strings',
	],
	[
		'exceptions — null',
		'{ "profile": "node", "exceptions": null }',
		'.stack.jsonc: "exceptions" must be an array',
	],
];

test.each(rejected)('читатель отклоняет: %s', (_name, text, message) => {
	const error = configError(text);
	expect(error).toBeInstanceOf(StackConfigError);
	expect(error.message).toBe(message);
});

test('$schema-строка принимается и в конфигурацию не попадает', () => {
	const dir = repoDir({
		'.stack.jsonc': '{ "$schema": "./node_modules/@alxwlw/stack/schema.json", "profile": "node" }',
	});
	expect(readStackConfig(dir, OWNER_SOURCE.settings)).toEqual({
		profile: 'node',
		with: [],
		exceptions: [],
	});
});

// schema.json читает редактор по `$schema`, который пишет init; CLI его не читает. Файл — производный:
// форму заявляют профили настроек канона, CONFIG_KEYS, EXCEPTION_SHAPES и группы канона, схема строится из них.
test('schema.json равен схеме, построенной из констант читателя и групп канона', () => {
	const built = stackConfigSchema(OWNER_SOURCE.settings, knownGroups(OWNER_SOURCE));
	expect(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'))).toEqual(built);
});

test('stackConfigSchema: enum групп — переданный список как есть', () => {
	const schema = stackConfigSchema(OWNER_SOURCE.settings, ['b', 'a']) as {
		properties: { with: { items: { enum: string[] } } };
	};
	expect(schema.properties.with.items.enum).toEqual(['b', 'a']);
});

test('readStackConfig читает файл с именем из настроек канона', () => {
	const dir = repoDir({
		'.acme.jsonc': '{ "profile": "chain" }',
		'.stack.jsonc': '{ "profile": "node" }',
	});
	expect(readStackConfig(dir, ACME_SETTINGS)).toStrictEqual({
		profile: 'chain',
		with: [],
		exceptions: [],
	});
});

test('сообщения называют файл, команду и профили канона', () => {
	expect(() => readStackConfig(repoDir({}), ACME_SETTINGS)).toThrow(
		'.acme.jsonc not found. Create it: acme init --profile <profile>',
	);
	const dir = repoDir({ '.acme.jsonc': '{ "profile": "node" }' });
	expect(() => readStackConfig(dir, ACME_SETTINGS)).toThrow(
		'.acme.jsonc: profile="node", expected one of: web, chain',
	);
	const extra = repoDir({ '.acme.jsonc': '{ "profile": "web", "wiht": [] }' });
	expect(() => readStackConfig(extra, ACME_SETTINGS)).toThrow('.acme.jsonc: unknown key "wiht"');
});

test('схема строится из настроек канона', () => {
	const schema = stackConfigSchema(ACME_SETTINGS, ['x']);
	const props = schema.properties as Record<string, { enum?: string[]; description?: string }>;
	expect(schema.title).toBe('acme config (.acme.jsonc)');
	expect(props.profile?.enum).toStrictEqual(['web', 'chain']);
	expect(props.exceptions?.description).toContain('`acme check`');
	expect(props.exceptions?.description).toContain('`acme sync`');
	expect(props.exceptions?.description).not.toContain('stack');
});

test.each([
	[{}, 'Opt-in canon groups.'],
	[
		{ a: 'A.', b: 'B.' },
		'Opt-in canon groups. "a" is deprecated and does nothing: A. "b" is deprecated and does nothing: B.',
	],
])('схема: описание with строится из deprecatedGroups %j', (deprecatedGroups, text) => {
	const schema = stackConfigSchema({ ...TEST_SETTINGS, deprecatedGroups }, ['peers']) as {
		properties: { with: { description: string } };
	};
	expect(schema.properties.with.description).toBe(text);
});
