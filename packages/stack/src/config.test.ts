import { expect, test } from 'bun:test';

import { readStackConfig, StackConfigError } from './config.ts';
import { repoDir } from './testkit.ts';

test('читает профиль, группы и исключения, не спотыкаясь о комментарии', () => {
	const dir = repoDir({
		'.stack.jsonc': `{
		// профиль репозитория
		"profile": "node",
		"with": ["libs"],
		"exceptions": [{ "catalog": "libs", "name": "react", "reason": "миграция" }]
	}`,
	});
	const cfg = readStackConfig(dir);
	expect(cfg.profile).toBe('node');
	expect(cfg.with).toEqual(['libs']);
	expect(cfg.exceptions[0]?.name).toBe('react');
});

test('по умолчанию groups и exceptions пустые', () => {
	const cfg = readStackConfig(repoDir({ '.stack.jsonc': '{ "profile": "infra" }' }));
	expect(cfg.with).toEqual([]);
	expect(cfg.exceptions).toEqual([]);
});

test('неизвестный профиль — ошибка', () => {
	expect(() => readStackConfig(repoDir({ '.stack.jsonc': '{ "profile": "python" }' }))).toThrow(
		StackConfigError,
	);
});

test('исключение без reason — ошибка', () => {
	const dir = repoDir({
		'.stack.jsonc': '{ "profile": "node", "exceptions": [{ "file": ".editorconfig" }] }',
	});
	expect(() => readStackConfig(dir)).toThrow(/reason/);
});

test('исключение — null в массиве — StackConfigError, а не сырой TypeError', () => {
	const dir = repoDir({ '.stack.jsonc': '{ "profile": "node", "exceptions": [null] }' });
	expect(() => readStackConfig(dir)).toThrow(StackConfigError);
});

test('исключение и на файл, и на запись каталога — ошибка', () => {
	const dir = repoDir({
		'.stack.jsonc':
			'{ "profile": "node", "exceptions": [{ "file": ".editorconfig", "catalog": "dev", "name": "oxlint", "reason": "x" }] }',
	});
	expect(() => readStackConfig(dir)).toThrow(StackConfigError);
});

test('отсутствие файла — ошибка с подсказкой про init', () => {
	const dir = repoDir({});
	expect(() => readStackConfig(dir)).toThrow(/stack init/);
});

test('исключение: file и catalog без name — ошибка', () => {
	const dir = repoDir({
		'.stack.jsonc':
			'{ "profile": "node", "exceptions": [{ "file": ".editorconfig", "catalog": "dev", "reason": "x" }] }',
	});
	expect(() => readStackConfig(dir)).toThrow(StackConfigError);
});

test('исключение: file и name без catalog — ошибка', () => {
	const dir = repoDir({
		'.stack.jsonc':
			'{ "profile": "node", "exceptions": [{ "file": ".editorconfig", "name": "oxlint", "reason": "x" }] }',
	});
	expect(() => readStackConfig(dir)).toThrow(StackConfigError);
});

test('исключение: только catalog, без file и name — ошибка', () => {
	const dir = repoDir({
		'.stack.jsonc': '{ "profile": "node", "exceptions": [{ "catalog": "dev", "reason": "x" }] }',
	});
	expect(() => readStackConfig(dir)).toThrow(StackConfigError);
});

test('нечитаемый JSONC — ошибка', () => {
	const dir = repoDir({ '.stack.jsonc': '{ "profile": "node", ' });
	expect(() => readStackConfig(dir)).toThrow(StackConfigError);
});

test('"with" не массив строк — ошибка', () => {
	const dir = repoDir({ '.stack.jsonc': '{ "profile": "node", "with": "libs" }' });
	expect(() => readStackConfig(dir)).toThrow(StackConfigError);
});

test('"exceptions" не массив — ошибка', () => {
	const dir = repoDir({ '.stack.jsonc': '{ "profile": "node", "exceptions": {} }' });
	expect(() => readStackConfig(dir)).toThrow(StackConfigError);
});

test('исключение: file и пустой catalog — ошибка', () => {
	const dir = repoDir({
		'.stack.jsonc':
			'{ "profile": "node", "exceptions": [{ "file": "x", "catalog": "", "reason": "r" }] }',
	});
	expect(() => readStackConfig(dir)).toThrow(StackConfigError);
});

test('исключение: file и пустой name — ошибка', () => {
	const dir = repoDir({
		'.stack.jsonc':
			'{ "profile": "node", "exceptions": [{ "file": "x", "name": "", "reason": "r" }] }',
	});
	expect(() => readStackConfig(dir)).toThrow(StackConfigError);
});

test('исключение: пустой file — ошибка', () => {
	const dir = repoDir({
		'.stack.jsonc': '{ "profile": "node", "exceptions": [{ "file": "", "reason": "r" }] }',
	});
	expect(() => readStackConfig(dir)).toThrow(StackConfigError);
});

test('исключение: catalog и пустой name — ошибка', () => {
	const dir = repoDir({
		'.stack.jsonc':
			'{ "profile": "node", "exceptions": [{ "catalog": "dev", "name": "", "reason": "r" }] }',
	});
	expect(() => readStackConfig(dir)).toThrow(StackConfigError);
});

test('исключение: только name, без file и catalog — ошибка', () => {
	const dir = repoDir({
		'.stack.jsonc': '{ "profile": "node", "exceptions": [{ "name": "oxlint", "reason": "r" }] }',
	});
	expect(() => readStackConfig(dir)).toThrow(StackConfigError);
});

function configError(text: string): Error {
	try {
		readStackConfig(repoDir({ '.stack.jsonc': text }));
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
	expect(readStackConfig(dir)).toEqual({ profile: 'node', with: [], exceptions: [] });
});
