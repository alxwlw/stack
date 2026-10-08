import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

import { type Canon, canonDir } from './canon.ts';
import {
	checkDependabot,
	checkEnginesNode,
	checkInlineVersions,
	checkRenovatePreset,
	STACK_RENOVATE_PRESET,
} from './deps.ts';

// Пин нарочно не совпадает с реальным каноном (26.x): иначе тест engines-node не отличит
// canon.nodePin от зашитой константы.
const canon: Canon = {
	files: [],
	catalogs: { dev: { oxlint: '1.83.0' }, libs: { react: '19.2.7' } },
	nodePin: '25.4.1',
	pnpmPin: '11.15.0',
};

function repo(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), 'stack-repo-'));
	for (const [p, content] of Object.entries(files)) {
		mkdirSync(join(dir, p, '..'), { recursive: true });
		writeFileSync(join(dir, p), content);
	}
	return dir;
}

test('пакет канона, объявленный версией вместо catalog:, — находка', () => {
	const dir = repo({
		'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
		'package.json': '{ "name": "root" }',
		'packages/a/package.json':
			'{ "name": "a", "dependencies": { "react": "18.3.1" }, "devDependencies": { "oxlint": "1.70.0", "lodash": "4.17.21" } }',
		'node_modules/x/package.json': '{ "name": "x", "devDependencies": { "oxlint": "1.60.0" } }',
	});
	// Имена берутся из всех групп канона (dev и libs), lodash в каноне нет, node_modules пропущен.
	expect(checkInlineVersions(dir, canon).map((f) => [f.code, f.target, f.address])).toEqual([
		['inline-version', 'packages/a/package.json:react', { name: 'react' }],
		['inline-version', 'packages/a/package.json:oxlint', { name: 'oxlint' }],
	]);
});

test('catalog: нарушением не считается', () => {
	const dir = repo({
		'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
		'package.json': '{ "name": "root" }',
		'packages/a/package.json': '{ "name": "a", "devDependencies": { "oxlint": "catalog:dev" } }',
	});
	expect(checkInlineVersions(dir, canon)).toEqual([]);
});

test('workspace: тоже не нарушение', () => {
	const dir = repo({
		'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
		'package.json': '{ "name": "root" }',
		'packages/a/package.json': '{ "name": "a", "devDependencies": { "oxlint": "workspace:*" } }',
	});
	expect(checkInlineVersions(dir, canon)).toEqual([]);
});

test('engines.node, не покрывающий пин, — находка', () => {
	const bad = repo({ 'package.json': '{ "name": "r", "engines": { "node": "^24" } }' });
	expect(checkEnginesNode(bad, canon).map((f) => [f.code, f.message])).toEqual([
		[
			'engines-node',
			'"^24" doesn\'t cover the canon pin 25.4.1 — proto will rewrite .prototools from engines',
		],
	]);
	// ^25 покрывает пин фикстуры, но не реальный 26.x — константа вместо canon.nodePin красит тест.
	const good = repo({ 'package.json': '{ "name": "r", "engines": { "node": "^25" } }' });
	expect(checkEnginesNode(good, canon)).toEqual([]);
	const none = repo({ 'package.json': '{ "name": "r" }' });
	expect(checkEnginesNode(none, canon)).toEqual([]);
});

test('битый package.json — находка unreadable-file, остальные пакеты проверяются дальше', () => {
	// Порядок Glob.scanSync не гарантирован (эмпирически — не алфавитный и не по времени
	// создания), поэтому находки ищем через .find по code, а не по позиции в массиве.
	const dir = repo({
		'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
		'package.json': '{ "name": "root" }',
		'packages/broken/package.json': '{ "name": "broken", ',
		'packages/a/package.json': '{ "name": "a", "devDependencies": { "oxlint": "1.70.0" } }',
	});
	const found = checkInlineVersions(dir, canon);
	const unreadable = found.find((f) => f.code === 'unreadable-file');
	expect(unreadable?.target).toBe('packages/broken/package.json');
	const inline = found.find((f) => f.code === 'inline-version');
	expect(inline?.target).toBe('packages/a/package.json:oxlint');
});

test('битый корневой package.json — checkEnginesNode находка, не исключение', () => {
	const dir = repo({ 'package.json': '{ "name": "r", ' });
	expect(() => checkEnginesNode(dir, canon)).not.toThrow();
	expect(checkEnginesNode(dir, canon)[0]?.code).toBe('unreadable-file');
});

test('без pnpm-workspace.yaml правила каталогов молчат', () => {
	const dir = repo({
		'package.json': '{ "name": "infra", "devDependencies": { "oxlint": "1.70.0" } }',
	});
	expect(checkInlineVersions(dir, canon)).toEqual([]);
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
	expect(checkRenovatePreset(repo({ 'renovate.json5': WITH_PRESET }))).toEqual([]);
});

test('renovate-preset: .github/renovate.json с пресетом — без находки', () => {
	const dir = repo({
		'.github/renovate.json': `{ "extends": ["config:recommended", "${STACK_RENOVATE_PRESET}"] }\n`,
	});
	expect(checkRenovatePreset(dir)).toEqual([]);
});

// Профиль infra: pnpm-workspace.yaml нет, а пресет всё равно нужен — он выключает proto.
test('renovate-preset: работает и без pnpm-workspace.yaml', () => {
	const [f] = checkRenovatePreset(
		repo({ 'renovate.json': '{ "extends": ["config:recommended"] }\n' }),
	);
	expect(f?.code).toBe('renovate-preset');
	expect(f?.target).toBe('renovate.json');
});

test('renovate-preset: пресет без тега, с #main или с чужим мажором — находка', () => {
	for (const ref of [
		'github>alxwlw/stack//renovate/canon.json5',
		'github>alxwlw/stack//renovate/canon.json5#main',
		'github>alxwlw/stack//renovate/canon.json5#v0',
	]) {
		const [f] = checkRenovatePreset(repo({ 'renovate.json5': `{ extends: ['${ref}'] }\n` }));
		expect(f?.code).toBe('renovate-preset');
		expect(f?.message).toContain(STACK_RENOVATE_PRESET);
	}
});

test('renovate-preset: первый конфиг в порядке поиска решает, даже если другой с пресетом', () => {
	const dir = repo({
		'renovate.json': '{ "extends": ["config:recommended"] }\n',
		'renovate.json5': WITH_PRESET,
	});
	expect(checkRenovatePreset(dir).map((f) => [f.code, f.target])).toEqual([
		['renovate-preset', 'renovate.json'],
	]);
});

test('renovate-preset: конфига нет — находка с подсказкой про stack sync', () => {
	const [f] = checkRenovatePreset(repo({}));
	expect(f?.code).toBe('renovate-preset');
	expect(f?.message).toContain('stack sync');
});

test('renovate-preset: битый JSON5 — unreadable-file', () => {
	expect(
		checkRenovatePreset(repo({ 'renovate.json5': '{ extends: [ \n' })).map((f) => [
			f.code,
			f.target,
		]),
	).toEqual([['unreadable-file', 'renovate.json5']]);
});

test('renovate-preset: засев канона проходит проверку', () => {
	const seed = readFileSync(join(canonDir(), 'files', 'renovate.template.json5'), 'utf8');
	expect(checkRenovatePreset(repo({ 'renovate.json5': seed }))).toEqual([]);
});

test('dependabot-config: .yml и .yaml — по находке на файл, без файлов — молчит', () => {
	const cfg = 'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n';
	expect(checkDependabot(repo({}))).toEqual([]);
	const dir = repo({ '.github/dependabot.yml': cfg, '.github/dependabot.yaml': cfg });
	expect(checkDependabot(dir).map((f) => [f.code, f.target])).toEqual([
		['dependabot-config', '.github/dependabot.yml'],
		['dependabot-config', '.github/dependabot.yaml'],
	]);
});
