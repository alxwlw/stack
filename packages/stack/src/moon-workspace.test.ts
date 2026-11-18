import * as fs from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

import { check, plan, syncRepo } from './check.ts';
import { isDrift } from './findings.ts';
import { loadRepo } from './repo.ts';
import { ioError, repoDir, testCanon, testRepo } from './testkit.ts';

const canon = testCanon();
const FILE = '.moon/workspace.yml';
const PKG = JSON.stringify({ name: 'r', packageManager: 'pnpm@10.99.0' });
const MESSAGE = `vcs.defaultBranch is not set — moon falls back to "master", and CI on a push to main dies with "ambiguous argument 'master'"`;
const REPORT = `vcs is not a map — set vcs.defaultBranch (main, the branch the canon's stack workflow runs on) by hand`;
const LIVE = `$schema: 'https://moonrepo.dev/schemas/workspace.json'

# Проекты репозитория.
projects:
  app: 'apps/app' # главное приложение

vcs:
  client: 'git'
`;
const run = (yaml: string | Error | null, exceptions: { file: string; reason: string }[] = []) =>
	check(
		testRepo(canon, { [FILE]: yaml instanceof Error ? { failed: yaml } : yaml }),
		canon,
		exceptions,
	);
const rows = (yaml: string | Error | null) => run(yaml).map((f) => [f.code, f.target, f.message]);

test('vcs.defaultBranch задан (main, trunk) — находок нет', () => {
	expect(run("vcs:\n  defaultBranch: 'main'\n")).toStrictEqual([]);
	expect(run('vcs:\n  client: git\n  defaultBranch: trunk\n')).toStrictEqual([]);
});

test('нет vcs — drift с адресом, текстом, fix и правкой yaml-set', () => {
	const drifts = plan(testRepo(canon, { [FILE]: "projects:\n  app: 'apps/app'\n" }), canon);
	expect(drifts).toStrictEqual([
		{
			code: 'moon-default-branch',
			target: '.moon/workspace.yml:vcs.defaultBranch',
			message: MESSAGE,
			fix: '.moon/workspace.yml vcs.defaultBranch: — → main',
			change: {
				file: '.moon/workspace.yml',
				kind: 'yaml-set',
				path: ['vcs', 'defaultBranch'],
				value: 'main',
			},
		},
	]);
});

test("vcs без defaultBranch, defaultBranch '' и defaultBranch 7 — drift", () => {
	const fixes = (yaml: string) => plan(testRepo(canon, { [FILE]: yaml }), canon).map((d) => d.fix);
	expect(fixes("vcs:\n  client: 'git'\n")).toStrictEqual([`${FILE} vcs.defaultBranch: — → main`]);
	expect(fixes("vcs:\n  defaultBranch: ''\n")).toStrictEqual([
		`${FILE} vcs.defaultBranch: "" → main`,
	]);
	expect(fixes('vcs:\n  defaultBranch: 7\n')).toStrictEqual([
		`${FILE} vcs.defaultBranch: 7 → main`,
	]);
});

test('пустой файл — drift', () => {
	expect(rows('')).toStrictEqual([
		['moon-default-branch', '.moon/workspace.yml:vcs.defaultBranch', MESSAGE],
	]);
});

test('vcs без значения и vcs: git — отчёт без правки, plan пуст', () => {
	for (const yaml of ['vcs:\n', 'vcs: git\n']) {
		const repo = testRepo(canon, { [FILE]: yaml });
		const found = check(repo, canon, []);
		expect(found.map((f) => [f.code, f.target, f.message])).toStrictEqual([
			['moon-default-branch', '.moon/workspace.yml:vcs.defaultBranch', REPORT],
		]);
		expect(found.map(isDrift)).toStrictEqual([false]);
		expect(plan(repo, canon).filter((d) => d.code === 'moon-default-branch')).toStrictEqual([]);
	}
});

test('файла нет — находок нет; sync файл не создаёт', () => {
	expect(check(testRepo(canon, {}), canon, [])).toStrictEqual([]);
	const dir = repoDir({ 'package.json': PKG });
	syncRepo(dir, canon, []);
	expect(fs.existsSync(join(dir, FILE))).toBe(false);
});

test('ошибка YAML, сбой чтения и список на верхнем уровне — ровно одна unreadable-file, sync файл не пишет', () => {
	expect(rows('vcs: [\n')).toHaveLength(1);
	expect(rows('vcs: [\n')[0]?.slice(0, 2)).toStrictEqual(['unreadable-file', FILE]);
	expect(rows(ioError('EACCES', 'denied'))).toStrictEqual([
		['unreadable-file', FILE, `${FILE} does not parse: EACCES: denied`],
	]);
	expect(rows('- a\n')).toStrictEqual([
		['unreadable-file', FILE, `${FILE} does not parse: top level is not a map`],
	]);
	const dir = repoDir({ 'package.json': PKG, [FILE]: '- a\n' });
	expect(syncRepo(dir, canon, []).applied).toStrictEqual([]);
	expect(fs.readFileSync(join(dir, FILE), 'utf8')).toBe('- a\n');
});

test('sync на живом воркспейсе дописывает одну строку; второй sync без правок; check чист', () => {
	const dir = repoDir({ 'package.json': PKG, [FILE]: LIVE });
	expect(syncRepo(dir, canon, []).applied).toHaveLength(1);
	expect(fs.readFileSync(join(dir, FILE), 'utf8')).toBe(`${LIVE}  defaultBranch: main\n`);
	expect(syncRepo(dir, canon, []).applied).toHaveLength(0);
	// renovate-preset краснеет у любого репо без конфига Renovate — к этому правилу не относится.
	const after = check(loadRepo(dir, canon), canon, []).filter((f) => f.code !== 'renovate-preset');
	expect(after).toStrictEqual([]);
});

test('исключение по файлу держит drift и отчёт; sync файл не трогает', () => {
	const reason = 'ветка по умолчанию задаётся иначе';
	const exceptions = [{ file: FILE, reason }];
	for (const yaml of ["projects:\n  app: 'apps/app'\n", 'vcs: git\n']) {
		expect(run(yaml, exceptions).map((f) => [f.code, f.suppressedBy?.reason])).toStrictEqual([
			['moon-default-branch', reason],
		]);
		const dir = repoDir({ 'package.json': PKG, [FILE]: yaml });
		expect(syncRepo(dir, canon, exceptions).applied).toStrictEqual([]);
		expect(fs.readFileSync(join(dir, FILE), 'utf8')).toBe(yaml);
	}
});

test('исключение без находки — stale-exception', () => {
	const found = run('vcs:\n  defaultBranch: main\n', [{ file: FILE, reason: 'не нужно' }]);
	expect(found.map((f) => [f.code, f.target])).toStrictEqual([['stale-exception', FILE]]);
});

test('loadRepo с диска читает MOON_WORKSPACE', () => {
	const dir = repoDir({ [FILE]: 'vcs:\n  defaultBranch: main\n' });
	expect(loadRepo(dir, canon).moonWorkspace).toStrictEqual({ vcs: { defaultBranch: 'main' } });
});
