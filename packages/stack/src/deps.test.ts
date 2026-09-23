import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

import { type Canon, canonDir } from './canon.ts';
import { checkDependabotIgnore, checkEnginesNode, checkInlineVersions } from './deps.ts';

// Пин нарочно не совпадает с реальным каноном (26.x): иначе тест engines-node не отличит
// canon.nodePin от зашитой константы.
const canon: Canon = {
	files: [],
	catalogs: { dev: { oxlint: '1.83.0' }, libs: { react: '19.2.7' } },
	nodePin: '25.4.1',
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

test('dependabot без ignore для @alxwlw/* — находка', () => {
	const bad = repo({
		'pnpm-workspace.yaml': 'packages: []\n',
		'.github/dependabot.yml':
			'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n',
	});
	expect(checkDependabotIgnore(bad)[0]?.code).toBe('dependabot-ignore');
	const good = repo({
		'pnpm-workspace.yaml': 'packages: []\n',
		'.github/dependabot.yml':
			'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    ignore:\n      - dependency-name: "@alxwlw/*"\n',
	});
	expect(checkDependabotIgnore(good)).toEqual([]);
});

test('dependabot: без файла на репозитории с workspace — молчит', () => {
	const dir = repo({ 'pnpm-workspace.yaml': 'packages: []\n' });
	expect(checkDependabotIgnore(dir)).toEqual([]);
});

test('dependabot: сид канона проходит проверку', () => {
	const template = readFileSync(join(canonDir(), 'files', 'dependabot.template.yml'), 'utf8');
	const dir = repo({ 'pnpm-workspace.yaml': 'packages: []\n', '.github/dependabot.yml': template });
	expect(checkDependabotIgnore(dir)).toEqual([]);
});

test('dependabot: закомментированный ignore — находка', () => {
	const dir = repo({
		'pnpm-workspace.yaml': 'packages: []\n',
		'.github/dependabot.yml':
			'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    ignore:\n      # - dependency-name: "@alxwlw/*"\n',
	});
	expect(checkDependabotIgnore(dir)[0]?.code).toBe('dependabot-ignore');
});

test('dependabot: ignore на чужом пакете — находка', () => {
	const dir = repo({
		'pnpm-workspace.yaml': 'packages: []\n',
		'.github/dependabot.yml':
			'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    ignore:\n      - dependency-name: "lodash"\n',
	});
	expect(checkDependabotIgnore(dir)[0]?.code).toBe('dependabot-ignore');
});

test('dependabot: битый YAML — находка, а не исключение', () => {
	const dir = repo({
		'pnpm-workspace.yaml': 'packages: []\n',
		'.github/dependabot.yml': 'version: 2\nupdates: [\n  - broken: [\n',
	});
	expect(() => checkDependabotIgnore(dir)).not.toThrow();
	expect(checkDependabotIgnore(dir)[0]?.code).toBe('unreadable-file');
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

test('без pnpm-workspace.yaml правила каталогов и dependabot молчат', () => {
	const dir = repo({
		'package.json': '{ "name": "infra", "devDependencies": { "oxlint": "1.70.0" } }',
		'.github/dependabot.yml':
			'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n',
	});
	expect(checkInlineVersions(dir, canon)).toEqual([]);
	expect(checkDependabotIgnore(dir)).toEqual([]);
});
