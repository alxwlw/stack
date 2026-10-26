import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

import { canonDir } from './canon.ts';
import { check } from './check.ts';
import { STACK_RENOVATE_PRESET } from './deps.ts';
import type { FindingCode } from './findings.ts';
import { testCanon, testRepo } from './testkit.ts';

// Пин node у testCanon нарочно не совпадает с реальным каноном (26.x): иначе тест engines-node
// не отличит canon.pins.node от зашитой константы.
const canon = testCanon({ catalogs: { dev: { oxlint: '1.83.0' }, libs: { react: '19.2.7' } } });

// Находки заданных кодов у репозитория, согласованного с каноном, с правками теста (null удаляет файл).
const found = (over: Record<string, string | null>, ...codes: FindingCode[]) =>
	check(testRepo(canon, over), canon, []).filter((f) => codes.includes(f.code));

// Конфиг Renovate теста вместо засеянного стендом: у репозитория один конфиг.
const renovate = (over: Record<string, string>) =>
	found({ 'renovate.json5': null, ...over }, 'renovate-preset', 'unreadable-file');

test('пакет канона, объявленный версией вместо catalog:, — находка', () => {
	// Имена берутся из всех групп канона (dev и libs), lodash в каноне нет.
	expect(
		found(
			{
				'packages/a/package.json':
					'{ "name": "a", "dependencies": { "react": "18.3.1" }, "devDependencies": { "oxlint": "1.70.0", "lodash": "4.17.21" } }',
			},
			'inline-version',
		),
	).toMatchObject([
		{ code: 'inline-version', target: 'packages/a/package.json:react', name: 'react' },
		{ code: 'inline-version', target: 'packages/a/package.json:oxlint', name: 'oxlint' },
	]);
});

test('catalog: нарушением не считается', () => {
	expect(
		found(
			{
				'packages/a/package.json':
					'{ "name": "a", "devDependencies": { "oxlint": "catalog:dev" } }',
			},
			'inline-version',
		),
	).toEqual([]);
});

test('workspace: тоже не нарушение', () => {
	expect(
		found(
			{
				'packages/a/package.json':
					'{ "name": "a", "devDependencies": { "oxlint": "workspace:*" } }',
			},
			'inline-version',
		),
	).toEqual([]);
});

test('engines.node, не покрывающий пин, — находка', () => {
	const engines = (json: string) => found({ 'package.json': json }, 'engines-node');
	expect(
		engines('{ "name": "r", "packageManager": "pnpm@10.99.0", "engines": { "node": "^24" } }').map(
			(f) => [f.code, f.message],
		),
	).toEqual([
		[
			'engines-node',
			'"^24" doesn\'t cover the canon pin 25.4.1 — proto will rewrite .prototools from engines',
		],
	]);
	// ^25 покрывает пин фикстуры, но не реальный 26.x — константа вместо canon.pins.node красит тест.
	expect(engines('{ "name": "r", "engines": { "node": "^25" } }')).toEqual([]);
	expect(engines('{ "name": "r" }')).toEqual([]);
});

test('engines.node не строкой (число) — находка, как на base: сравнение идёт как есть', () => {
	expect(
		found({ 'package.json': '{ "name": "r", "engines": { "node": 20 } }' }, 'engines-node').map(
			(f) => [f.code, f.message],
		),
	).toEqual([
		[
			'engines-node',
			'"20" doesn\'t cover the canon pin 25.4.1 — proto will rewrite .prototools from engines',
		],
	]);
});

// Порядок обхода пакетов не гарантирован: находки ищем через .find по code, а не по позиции.
test('битый package.json — находка unreadable-file, остальные пакеты проверяются дальше', () => {
	const result = found(
		{
			'packages/broken/package.json': '{ "name": "broken", ',
			'packages/a/package.json': '{ "name": "a", "devDependencies": { "oxlint": "1.70.0" } }',
		},
		'unreadable-file',
		'inline-version',
	);
	expect(result.find((f) => f.code === 'unreadable-file')?.target).toBe(
		'packages/broken/package.json',
	);
	expect(result.find((f) => f.code === 'inline-version')?.target).toBe(
		'packages/a/package.json:oxlint',
	);
});

test('битый корневой package.json — engines-node молчит, находка одна, с pnpm-workspace.yaml и без', () => {
	for (const ws of ['packages:\n  - packages/*\n', null]) {
		const result = found(
			{ 'package.json': '{ "name": "r", ', 'pnpm-workspace.yaml': ws },
			'engines-node',
			'unreadable-file',
			'inline-version',
		);
		expect(
			result.map((f) => [f.code, f.target]),
			`workspace: ${ws !== null}`,
		).toEqual([['unreadable-file', 'package.json']]);
	}
});

test('без pnpm-workspace.yaml правила каталогов молчат', () => {
	expect(
		found(
			{
				'pnpm-workspace.yaml': null,
				'package.json': '{ "name": "infra", "devDependencies": { "oxlint": "1.70.0" } }',
			},
			'inline-version',
		),
	).toEqual([]);
});

// renovate-preset: конфиг ищется в порядке самого Renovate (первый найденный — и есть конфиг),
// extends должен содержать пресет канона ровно с тегом #v1.
const WITH_PRESET = `{
	// свои правила потребителя
	extends: ['config:recommended', '${STACK_RENOVATE_PRESET}'],
	packageRules: [{ groupName: 'types', matchPackageNames: ['@types/**'] }],
}
`;

test('renovate-preset: renovate.json5 с пресетом — без находки', () => {
	expect(renovate({ 'renovate.json5': WITH_PRESET })).toEqual([]);
});

test('renovate-preset: .github/renovate.json с пресетом — без находки', () => {
	expect(
		renovate({
			'.github/renovate.json': `{ "extends": ["config:recommended", "${STACK_RENOVATE_PRESET}"] }\n`,
		}),
	).toEqual([]);
});

// Профиль infra: pnpm-workspace.yaml нет, а пресет всё равно нужен — он выключает proto.
test('renovate-preset: работает и без pnpm-workspace.yaml', () => {
	const result = found(
		{
			'pnpm-workspace.yaml': null,
			'renovate.json5': null,
			'renovate.json': '{ "extends": ["config:recommended"] }\n',
		},
		'renovate-preset',
	);
	expect(result).toMatchObject([{ code: 'renovate-preset', target: 'renovate.json' }]);
});

test('renovate-preset: пресет без тега, с #main или с чужим мажором — находка', () => {
	for (const ref of [
		'github>alxwlw/stack//renovate/canon.json5',
		'github>alxwlw/stack//renovate/canon.json5#main',
		'github>alxwlw/stack//renovate/canon.json5#v0',
	]) {
		const [f] = renovate({ 'renovate.json5': `{ extends: ['${ref}'] }\n` });
		expect(f?.code).toBe('renovate-preset');
		expect(f?.message).toContain(STACK_RENOVATE_PRESET);
	}
});

test('renovate-preset: первый конфиг в порядке поиска решает, даже если другой с пресетом', () => {
	expect(
		renovate({
			'renovate.json': '{ "extends": ["config:recommended"] }\n',
			'renovate.json5': WITH_PRESET,
		}).map((f) => [f.code, f.target]),
	).toEqual([['renovate-preset', 'renovate.json']]);
});

// extends нет или он не массив — типичный вход при миграции с Dependabot: находка, а не TypeError.
test('renovate-preset: конфиг без extends — находка, не исключение', () => {
	for (const body of ['{ "packageRules": [] }\n', '{}\n']) {
		expect(() => renovate({ 'renovate.json': body })).not.toThrow();
		const result = renovate({ 'renovate.json': body });
		expect(result).toHaveLength(1);
		expect(result[0]?.code).toBe('renovate-preset');
		expect(result[0]?.target).toBe('renovate.json');
	}
});

test('renovate-preset: extends строкой, даже равной пресету, — находка', () => {
	const result = renovate({ 'renovate.json': `{ "extends": "${STACK_RENOVATE_PRESET}" }\n` });
	expect(result).toHaveLength(1);
	expect(result[0]?.code).toBe('renovate-preset');
	expect(result[0]?.target).toBe('renovate.json');
});

test('renovate-preset: конфига нет — находка с подсказкой про stack sync', () => {
	const [f] = renovate({});
	expect(f?.code).toBe('renovate-preset');
	expect(f?.target).toBe('renovate.json5');
	expect(f?.message).toContain('stack sync');
});

test('renovate-preset: битый JSON5 — одна unreadable-file, пресет молчит', () => {
	expect(renovate({ 'renovate.json5': '{ extends: [ \n' }).map((f) => [f.code, f.target])).toEqual([
		['unreadable-file', 'renovate.json5'],
	]);
});

test('renovate-preset: засев канона проходит проверку', () => {
	const seed = readFileSync(join(canonDir(), 'files', 'renovate.template.json5'), 'utf8');
	expect(renovate({ 'renovate.json5': seed })).toEqual([]);
});

test('dependabot-config: .yml и .yaml — по находке на файл, без файлов — молчит', () => {
	const cfg = 'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n';
	expect(found({}, 'dependabot-config')).toEqual([]);
	expect(
		found(
			{ '.github/dependabot.yml': cfg, '.github/dependabot.yaml': cfg },
			'dependabot-config',
		).map((f) => [f.code, f.target]),
	).toEqual([
		['dependabot-config', '.github/dependabot.yml'],
		['dependabot-config', '.github/dependabot.yaml'],
	]);
});
