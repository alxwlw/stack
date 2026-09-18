import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

import { readStackConfig, StackConfigError } from './config.ts';

function repoWith(contents: string): string {
	const dir = mkdtempSync(join(tmpdir(), 'stack-cfg-'));
	writeFileSync(join(dir, '.stack.jsonc'), contents);
	return dir;
}

test('читает профиль, группы и исключения, не спотыкаясь о комментарии', () => {
	const dir = repoWith(`{
		// профиль репозитория
		"profile": "node",
		"with": ["libs"],
		"exceptions": [{ "catalog": "libs", "name": "react", "reason": "миграция" }]
	}`);
	const cfg = readStackConfig(dir);
	expect(cfg.profile).toBe('node');
	expect(cfg.with).toEqual(['libs']);
	expect(cfg.exceptions[0]?.name).toBe('react');
});

test('по умолчанию groups и exceptions пустые', () => {
	const cfg = readStackConfig(repoWith('{ "profile": "infra" }'));
	expect(cfg.with).toEqual([]);
	expect(cfg.exceptions).toEqual([]);
});

test('неизвестный профиль — ошибка', () => {
	expect(() => readStackConfig(repoWith('{ "profile": "python" }'))).toThrow(StackConfigError);
});

test('исключение без reason — ошибка', () => {
	const dir = repoWith('{ "profile": "node", "exceptions": [{ "file": ".editorconfig" }] }');
	expect(() => readStackConfig(dir)).toThrow(/reason/);
});

test('исключение — null в массиве — StackConfigError, а не сырой TypeError', () => {
	const dir = repoWith('{ "profile": "node", "exceptions": [null] }');
	expect(() => readStackConfig(dir)).toThrow(StackConfigError);
});

test('исключение и на файл, и на запись каталога — ошибка', () => {
	const dir = repoWith(
		'{ "profile": "node", "exceptions": [{ "file": ".editorconfig", "catalog": "dev", "name": "oxlint", "reason": "x" }] }',
	);
	expect(() => readStackConfig(dir)).toThrow(StackConfigError);
});

test('отсутствие файла — ошибка с подсказкой про init', () => {
	const dir = mkdtempSync(join(tmpdir(), 'stack-cfg-'));
	expect(() => readStackConfig(dir)).toThrow(/stack init/);
});

test('исключение: file и catalog без name — ошибка', () => {
	const dir = repoWith(
		'{ "profile": "node", "exceptions": [{ "file": ".editorconfig", "catalog": "dev", "reason": "x" }] }',
	);
	expect(() => readStackConfig(dir)).toThrow(StackConfigError);
});

test('исключение: file и name без catalog — ошибка', () => {
	const dir = repoWith(
		'{ "profile": "node", "exceptions": [{ "file": ".editorconfig", "name": "oxlint", "reason": "x" }] }',
	);
	expect(() => readStackConfig(dir)).toThrow(StackConfigError);
});

test('исключение: только catalog, без file и name — ошибка', () => {
	const dir = repoWith(
		'{ "profile": "node", "exceptions": [{ "catalog": "dev", "reason": "x" }] }',
	);
	expect(() => readStackConfig(dir)).toThrow(StackConfigError);
});

test('нечитаемый JSONC — ошибка', () => {
	const dir = repoWith('{ "profile": "node", ');
	expect(() => readStackConfig(dir)).toThrow(StackConfigError);
});

test('"with" не массив строк — ошибка', () => {
	const dir = repoWith('{ "profile": "node", "with": "libs" }');
	expect(() => readStackConfig(dir)).toThrow(StackConfigError);
});

test('"exceptions" не массив — ошибка', () => {
	const dir = repoWith('{ "profile": "node", "exceptions": {} }');
	expect(() => readStackConfig(dir)).toThrow(StackConfigError);
});

test('исключение: file и пустой catalog — ошибка', () => {
	const dir = repoWith(
		'{ "profile": "node", "exceptions": [{ "file": "x", "catalog": "", "reason": "r" }] }',
	);
	expect(() => readStackConfig(dir)).toThrow(StackConfigError);
});

test('исключение: file и пустой name — ошибка', () => {
	const dir = repoWith(
		'{ "profile": "node", "exceptions": [{ "file": "x", "name": "", "reason": "r" }] }',
	);
	expect(() => readStackConfig(dir)).toThrow(StackConfigError);
});

test('исключение: пустой file — ошибка', () => {
	const dir = repoWith('{ "profile": "node", "exceptions": [{ "file": "", "reason": "r" }] }');
	expect(() => readStackConfig(dir)).toThrow(StackConfigError);
});

test('исключение: catalog и пустой name — ошибка', () => {
	const dir = repoWith(
		'{ "profile": "node", "exceptions": [{ "catalog": "dev", "name": "", "reason": "r" }] }',
	);
	expect(() => readStackConfig(dir)).toThrow(StackConfigError);
});

test('исключение: только name, без file и catalog — ошибка', () => {
	const dir = repoWith(
		'{ "profile": "node", "exceptions": [{ "name": "oxlint", "reason": "r" }] }',
	);
	expect(() => readStackConfig(dir)).toThrow(StackConfigError);
});
