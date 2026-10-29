import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'bun:test';
import { parse as parseJsonc } from 'jsonc-parser';

import { repoDir } from './testkit.ts';

const CLI = join(import.meta.dir, 'cli.ts');

async function run(args: string[], cwd: string) {
	const proc = Bun.spawn(['bun', CLI, ...args, '--repo', cwd], { stdout: 'pipe', stderr: 'pipe' });
	const [out, err] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { code: await proc.exited, out, err };
}

// Репозиторий до init: package.json с engines на реальном каноне и пустой workspace.
const BARE = {
	'package.json': '{ "name": "r", "engines": { "node": ">=26.8.1" } }',
	'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
};

test('init создаёт конфигурацию, повторный init — код 2', async () => {
	const dir = repoDir(BARE);
	expect((await run(['init', '--profile', 'node'], dir)).code).toBe(0);
	expect((await run(['init', '--profile', 'node'], dir)).code).toBe(2);
});

test('check без .stack.jsonc — код 2 с подсказкой', async () => {
	const dir = repoDir(BARE);
	const r = await run(['check'], dir);
	expect(r.code).toBe(2);
	expect(r.err).toContain('stack init');
});

test('check до sync — код 1, после sync — код 0', async () => {
	const dir = repoDir(BARE);
	await run(['init', '--profile', 'node'], dir);
	expect((await run(['check'], dir)).code).toBe(1);
	const synced = await run(['sync'], dir);
	expect(synced.code).toBe(0);
	expect(synced.out).toContain('seeded');
	expect(synced.out).toContain('updated');
	expect((await run(['check'], dir)).code).toBe(0);
});

test('неизвестная команда — код 2', async () => {
	expect((await run(['помой-посуду'], repoDir(BARE))).code).toBe(2);
});

test('init без --profile — код 2', async () => {
	const dir = repoDir(BARE);
	const r = await run(['init'], dir);
	expect(r.code).toBe(2);
	expect(r.err).toContain('--profile');
	expect(existsSync(join(dir, '.stack.jsonc'))).toBe(false);
});

test('init с недопустимым --profile — код 2, файл не создан', async () => {
	const dir = repoDir(BARE);
	const r = await run(['init', '--profile', 'банан'], dir);
	expect(r.code).toBe(2);
	expect(r.err).toContain('банан');
	expect(existsSync(join(dir, '.stack.jsonc'))).toBe(false);
});

test('.stack.jsonc с синтаксической ошибкой — check и sync код 2', async () => {
	const dir = repoDir(BARE);
	writeFileSync(join(dir, '.stack.jsonc'), '{ nope');
	const checked = await run(['check'], dir);
	expect(checked.code).toBe(2);
	expect(checked.err).toContain('JSONC');
	expect((await run(['sync'], dir)).code).toBe(2);
});

test('повторный sync — без изменений, код 0', async () => {
	const dir = repoDir(BARE);
	await run(['init', '--profile', 'node'], dir);
	await run(['sync'], dir);
	const again = await run(['sync'], dir);
	expect(again.code).toBe(0);
	expect(again.out).toContain('already up to date');
});

test('подавленная находка печатается предупреждением, код 0', async () => {
	const dir = repoDir(BARE);
	await run(['init', '--profile', 'node'], dir);
	await run(['sync'], dir);
	rmSync(join(dir, '.editorconfig'));
	// jsonc-parser, не JSON.parse: .stack.jsonc — JSONC (trailing comma), как читает readStackConfig.
	const cfg = parseJsonc(readFileSync(join(dir, '.stack.jsonc'), 'utf8')) as Record<
		string,
		unknown
	>;
	cfg.exceptions = [{ file: '.editorconfig', reason: 'тест: намеренно подавлено' }];
	writeFileSync(join(dir, '.stack.jsonc'), JSON.stringify(cfg, null, '\t'));
	const r = await run(['check'], dir);
	expect(r.code).toBe(0);
	expect(r.err).toContain('тест: намеренно подавлено');
	expect(r.err).toContain('.editorconfig');
	expect(r.out).toContain('no drift');
});

test('неизвестный флаг — код 2, без необработанного исключения', async () => {
	const dir = repoDir(BARE);
	const r = await run(['sync', '--bogus'], dir);
	expect(r.code).toBe(2);
	expect(r.err).toContain('bogus');
	expect(r.err).not.toContain('cli.ts');
});

test('init с несуществующим --repo — код 2, без стектрейса', async () => {
	const dir = join(repoDir(BARE), 'nope');
	const r = await run(['init', '--profile', 'node'], dir);
	expect(r.code).toBe(2);
	expect(r.err).not.toContain('cli.ts');
	expect(r.err).not.toContain('ENOENT');
});

test('sync с исключением на файл: файл не тронут, строка allowed, check — код 0', async () => {
	const dir = repoDir(BARE);
	writeFileSync(
		join(dir, '.stack.jsonc'),
		'{ "profile": "node", "with": [], "exceptions": [{ "file": ".editorconfig", "reason": "свой отступ" }] }',
	);
	writeFileSync(join(dir, '.editorconfig'), 'свой\n');
	const synced = await run(['sync'], dir);
	expect(synced.code).toBe(0);
	expect(synced.out).not.toContain('updated .editorconfig');
	expect(synced.err).toContain('allowed (свой отступ): .editorconfig');
	expect(readFileSync(join(dir, '.editorconfig'), 'utf8')).toBe('свой\n');
	expect((await run(['check'], dir)).code).toBe(0);
});

// dependabot.yml в репо — находка dependabot-config: её правят руками (перенос в Renovate), sync файл не трогает.
const DEPENDABOT_CONFIG =
	"version: 2\nupdates:\n  - package-ecosystem: 'npm'\n    directory: '/'\n    schedule:\n      interval: 'weekly'\n";

async function syncedRepo(): Promise<string> {
	const dir = repoDir(BARE);
	await run(['init', '--profile', 'node'], dir);
	await run(['sync'], dir);
	mkdirSync(join(dir, '.github'), { recursive: true });
	writeFileSync(join(dir, '.github/dependabot.yml'), DEPENDABOT_CONFIG);
	return dir;
}

test('check: находка, которую sync не чинит, — без совета stack sync', async () => {
	const r = await run(['check'], await syncedRepo());
	expect(r.code).toBe(1);
	expect(r.err).toContain('dependabot-config');
	expect(r.err).not.toContain('Fix with: stack sync');
	expect(r.err).toContain('1 finding(s). stack sync does not fix these — fix them by hand');
});

test('check: смесь — в подсказке оба числа', async () => {
	const dir = await syncedRepo();
	rmSync(join(dir, '.editorconfig'));
	rmSync(join(dir, '.oxfmtrc.jsonc'));
	const r = await run(['check'], dir);
	expect(r.code).toBe(1);
	expect(r.err).toContain('3 finding(s): 2 fixable with: stack sync, 1 to fix by hand');
});

test('check: подавленная находка не входит в числа подсказки', async () => {
	const dir = await syncedRepo();
	rmSync(join(dir, '.editorconfig'));
	const cfg = parseJsonc(readFileSync(join(dir, '.stack.jsonc'), 'utf8')) as Record<
		string,
		unknown
	>;
	cfg.exceptions = [{ file: '.editorconfig', reason: 'тест: подавлено' }];
	writeFileSync(join(dir, '.stack.jsonc'), JSON.stringify(cfg, null, '\t'));
	const r = await run(['check'], dir);
	expect(r.code).toBe(1);
	expect(r.err).toContain('1 finding(s). stack sync does not fix these');
});

test('check: всё чинит sync — подсказка прежняя', async () => {
	const dir = repoDir(BARE);
	await run(['init', '--profile', 'node'], dir);
	await run(['sync'], dir);
	rmSync(join(dir, '.editorconfig'));
	const r = await run(['check'], dir);
	expect(r.code).toBe(1);
	expect(r.err).toMatch(/\n\d+ finding\(s\)\. Fix with: stack sync\n/);
});

// Группа renovate устарела и ничего не включает: репо с ней и без конфига Renovate получает засев
// от sync, и check после этого чист — прежнее правило про ignore краснело на засеянном пресете.
test('with renovate без конфига Renovate: sync засевает renovate.json5, check — код 0 без находок', async () => {
	const dir = repoDir(BARE);
	expect((await run(['init', '--profile', 'node', '--with', 'renovate'], dir)).code).toBe(0);
	expect(existsSync(join(dir, 'renovate.json5'))).toBe(false);
	const synced = await run(['sync'], dir);
	expect(synced.code).toBe(0);
	expect(readFileSync(join(dir, 'renovate.json5'), 'utf8')).toContain(
		'github>alxwlw/stack//renovate/canon.json5#v1',
	);
	const checked = await run(['check'], dir);
	expect(checked.err).not.toContain('renovate');
	expect(checked.code).toBe(0);
});

test('check и sync с опечаткой в with — код 2, ошибка называет группу', async () => {
	const dir = repoDir(BARE);
	writeFileSync(join(dir, '.stack.jsonc'), '{ "profile": "node", "with": ["moon-task"] }');
	for (const command of ['check', 'sync']) {
		const r = await run([command], dir);
		expect(r.code).toBe(2);
		expect(r.err).toContain('unknown group "moon-task"');
		expect(r.err).not.toContain('cli.ts');
	}
});

test('init с неизвестной --with — код 2, файл не создан', async () => {
	const dir = repoDir(BARE);
	const r = await run(['init', '--profile', 'node', '--with', 'moon-task'], dir);
	expect(r.code).toBe(2);
	expect(existsSync(join(dir, '.stack.jsonc'))).toBe(false);
});

test('init с опечаткой во второй --with — код 2, файл не создан', async () => {
	const dir = repoDir(BARE);
	const r = await run(['init', '--profile', 'node', '--with', 'libs', '--with', 'moon-task'], dir);
	expect(r.code).toBe(2);
	expect(r.err).toContain('unknown group "moon-task"');
	expect(existsSync(join(dir, '.stack.jsonc'))).toBe(false);
});

test('init и check отвергают опечатку в with одной и той же строкой', async () => {
	const initDir = repoDir(BARE);
	const init = await run(['init', '--profile', 'node', '--with', 'typo'], initDir);
	const checkDir = repoDir(BARE);
	writeFileSync(join(checkDir, '.stack.jsonc'), '{ "profile": "node", "with": ["typo"] }');
	const check = await run(['check'], checkDir);
	expect(init.code).toBe(2);
	expect(check.code).toBe(2);
	const line = (err: string) => err.split('\n').find((l) => l.includes('unknown group'));
	expect(line(init.err)).toContain('unknown group "typo" in "with", expected one of: ');
	expect(line(init.err)).toBe(line(check.err));
});
