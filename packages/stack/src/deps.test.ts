import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

import type { StackConfig } from './config.ts';
import {
	canonNodePin,
	checkDependabotIgnore,
	checkEnginesNode,
	checkInlineVersions,
} from './deps.ts';
import { canonDir } from './manifest.ts';

const cfg: StackConfig = { profile: 'node', with: [], exceptions: [] };

function canonFixture(): string {
	const dir = mkdtempSync(join(tmpdir(), 'stack-canon-'));
	mkdirSync(join(dir, 'files'), { recursive: true });
	writeFileSync(join(dir, 'files', 'prototools-node'), 'node = "26.8.1"\npnpm = "11.15.0"\n');
	writeFileSync(
		join(dir, 'manifest.json'),
		JSON.stringify({
			files: [{ src: 'files/prototools-node', dest: '.prototools', appliesTo: ['node', 'infra'] }],
		}),
	);
	writeFileSync(join(dir, 'catalogs.json'), JSON.stringify({ dev: { oxlint: '1.83.0' } }));
	return dir;
}

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
			'{ "name": "a", "devDependencies": { "oxlint": "1.70.0", "lodash": "4.17.21" } }',
		'node_modules/x/package.json': '{ "name": "x", "devDependencies": { "oxlint": "1.60.0" } }',
	});
	const found = checkInlineVersions(dir, cfg, canonFixture());
	expect(found).toHaveLength(1);
	expect(found[0]?.code).toBe('inline-version');
	expect(found[0]?.target).toBe('packages/a/package.json:oxlint');
});

test('catalog: нарушением не считается', () => {
	const dir = repo({
		'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
		'package.json': '{ "name": "root" }',
		'packages/a/package.json': '{ "name": "a", "devDependencies": { "oxlint": "catalog:dev" } }',
	});
	expect(checkInlineVersions(dir, cfg, canonFixture())).toEqual([]);
});

test('workspace: тоже не нарушение', () => {
	const dir = repo({
		'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
		'package.json': '{ "name": "root" }',
		'packages/a/package.json': '{ "name": "a", "devDependencies": { "oxlint": "workspace:*" } }',
	});
	expect(checkInlineVersions(dir, cfg, canonFixture())).toEqual([]);
});

test('engines.node, не покрывающий пин, — находка', () => {
	const bad = repo({ 'package.json': '{ "name": "r", "engines": { "node": "^24" } }' });
	expect(checkEnginesNode(bad, cfg, canonFixture())[0]?.code).toBe('engines-node');
	const good = repo({ 'package.json': '{ "name": "r", "engines": { "node": ">=26.8.1" } }' });
	expect(checkEnginesNode(good, cfg, canonFixture())).toEqual([]);
	const none = repo({ 'package.json': '{ "name": "r" }' });
	expect(checkEnginesNode(none, cfg, canonFixture())).toEqual([]);
});

test('canonNodePin: в манифесте нет .prototools для профиля — ошибка', () => {
	const dir = mkdtempSync(join(tmpdir(), 'stack-canon-'));
	writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ files: [] }));
	expect(() => canonNodePin(cfg, dir)).toThrow(
		'canon manifest has no .prototools entry for profile node',
	);
});

test('canonNodePin: в каноне .prototools нет пина node — ошибка', () => {
	const dir = mkdtempSync(join(tmpdir(), 'stack-canon-'));
	mkdirSync(join(dir, 'files'), { recursive: true });
	writeFileSync(join(dir, 'files', 'prototools-node'), 'pnpm = "11.15.0"\n');
	writeFileSync(
		join(dir, 'manifest.json'),
		JSON.stringify({
			files: [{ src: 'files/prototools-node', dest: '.prototools', appliesTo: ['node'] }],
		}),
	);
	expect(() => canonNodePin(cfg, dir)).toThrow('canon .prototools has no node pin');
});

test('dependabot без ignore для @alxwlw/* — находка', () => {
	const bad = repo({
		'pnpm-workspace.yaml': 'packages: []\n',
		'.github/dependabot.yml':
			'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n',
	});
	expect(checkDependabotIgnore(bad, cfg)[0]?.code).toBe('dependabot-ignore');
	const good = repo({
		'pnpm-workspace.yaml': 'packages: []\n',
		'.github/dependabot.yml':
			'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    ignore:\n      - dependency-name: "@alxwlw/*"\n',
	});
	expect(checkDependabotIgnore(good, cfg)).toEqual([]);
});

test('dependabot: без файла на репозитории с workspace — молчит', () => {
	const dir = repo({ 'pnpm-workspace.yaml': 'packages: []\n' });
	expect(checkDependabotIgnore(dir, cfg)).toEqual([]);
});

test('dependabot: сид канона проходит проверку', () => {
	const template = readFileSync(join(canonDir(), 'files', 'dependabot.template.yml'), 'utf8');
	const dir = repo({ 'pnpm-workspace.yaml': 'packages: []\n', '.github/dependabot.yml': template });
	expect(checkDependabotIgnore(dir, cfg)).toEqual([]);
});

test('dependabot: закомментированный ignore — находка', () => {
	const dir = repo({
		'pnpm-workspace.yaml': 'packages: []\n',
		'.github/dependabot.yml':
			'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    ignore:\n      # - dependency-name: "@alxwlw/*"\n',
	});
	expect(checkDependabotIgnore(dir, cfg)[0]?.code).toBe('dependabot-ignore');
});

test('dependabot: ignore на чужом пакете — находка', () => {
	const dir = repo({
		'pnpm-workspace.yaml': 'packages: []\n',
		'.github/dependabot.yml':
			'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    ignore:\n      - dependency-name: "lodash"\n',
	});
	expect(checkDependabotIgnore(dir, cfg)[0]?.code).toBe('dependabot-ignore');
});

test('dependabot: битый YAML — находка, а не исключение', () => {
	const dir = repo({
		'pnpm-workspace.yaml': 'packages: []\n',
		'.github/dependabot.yml': 'version: 2\nupdates: [\n  - broken: [\n',
	});
	expect(() => checkDependabotIgnore(dir, cfg)).not.toThrow();
	expect(checkDependabotIgnore(dir, cfg)[0]?.code).toBe('unreadable-file');
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
	const found = checkInlineVersions(dir, cfg, canonFixture());
	const unreadable = found.find((f) => f.code === 'unreadable-file');
	expect(unreadable?.target).toBe('packages/broken/package.json');
	const inline = found.find((f) => f.code === 'inline-version');
	expect(inline?.target).toBe('packages/a/package.json:oxlint');
});

test('битый корневой package.json — checkEnginesNode находка, не исключение', () => {
	const dir = repo({ 'package.json': '{ "name": "r", ' });
	expect(() => checkEnginesNode(dir, cfg, canonFixture())).not.toThrow();
	expect(checkEnginesNode(dir, cfg, canonFixture())[0]?.code).toBe('unreadable-file');
});

test('без pnpm-workspace.yaml правила каталогов и dependabot молчат', () => {
	const dir = repo({
		'package.json': '{ "name": "infra", "devDependencies": { "oxlint": "1.70.0" } }',
		'.github/dependabot.yml':
			'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n',
	});
	const infra: StackConfig = { profile: 'infra', with: [], exceptions: [] };
	expect(checkInlineVersions(dir, infra, canonFixture())).toEqual([]);
	expect(checkDependabotIgnore(dir, infra)).toEqual([]);
});
