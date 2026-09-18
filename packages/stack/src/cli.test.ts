import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'bun:test';
import { parse as parseJsonc } from 'jsonc-parser';

const CLI = join(import.meta.dir, 'cli.ts');

async function run(args: string[], cwd: string) {
	const proc = Bun.spawn(['bun', CLI, ...args, '--repo', cwd], { stdout: 'pipe', stderr: 'pipe' });
	const [out, err] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { code: await proc.exited, out, err };
}

function emptyRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), 'stack-cli-'));
	writeFileSync(join(dir, 'package.json'), '{ "name": "r", "engines": { "node": ">=26.8.1" } }');
	writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
	return dir;
}

test('init создаёт конфигурацию, повторный init — код 2', async () => {
	const dir = emptyRepo();
	expect((await run(['init', '--profile', 'node'], dir)).code).toBe(0);
	expect((await run(['init', '--profile', 'node'], dir)).code).toBe(2);
});

test('check без .stack.jsonc — код 2 с подсказкой', async () => {
	const dir = emptyRepo();
	const r = await run(['check'], dir);
	expect(r.code).toBe(2);
	expect(r.err).toContain('stack init');
});

test('check до sync — код 1, после sync — код 0', async () => {
	const dir = emptyRepo();
	await run(['init', '--profile', 'node'], dir);
	expect((await run(['check'], dir)).code).toBe(1);
	const synced = await run(['sync'], dir);
	expect(synced.code).toBe(0);
	expect(synced.out).toContain('seeded');
	expect(synced.out).toContain('updated');
	expect((await run(['check'], dir)).code).toBe(0);
});

test('неизвестная команда — код 2', async () => {
	expect((await run(['помой-посуду'], emptyRepo())).code).toBe(2);
});

test('init без --profile — код 2', async () => {
	const dir = emptyRepo();
	const r = await run(['init'], dir);
	expect(r.code).toBe(2);
	expect(r.err).toContain('--profile');
	expect(existsSync(join(dir, '.stack.jsonc'))).toBe(false);
});

test('init с недопустимым --profile — код 2, файл не создан', async () => {
	const dir = emptyRepo();
	const r = await run(['init', '--profile', 'банан'], dir);
	expect(r.code).toBe(2);
	expect(r.err).toContain('банан');
	expect(existsSync(join(dir, '.stack.jsonc'))).toBe(false);
});

test('.stack.jsonc с синтаксической ошибкой — check и sync код 2', async () => {
	const dir = emptyRepo();
	writeFileSync(join(dir, '.stack.jsonc'), '{ nope');
	const checked = await run(['check'], dir);
	expect(checked.code).toBe(2);
	expect(checked.err).toContain('JSONC');
	expect((await run(['sync'], dir)).code).toBe(2);
});

test('повторный sync — без изменений, код 0', async () => {
	const dir = emptyRepo();
	await run(['init', '--profile', 'node'], dir);
	await run(['sync'], dir);
	const again = await run(['sync'], dir);
	expect(again.code).toBe(0);
	expect(again.out).toContain('already up to date');
});

test('подавленная находка печатается предупреждением, код 0', async () => {
	const dir = emptyRepo();
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
	const dir = emptyRepo();
	const r = await run(['sync', '--bogus'], dir);
	expect(r.code).toBe(2);
	expect(r.err).toContain('bogus');
	expect(r.err).not.toContain('cli.ts');
});

test('init с несуществующим --repo — код 2, без стектрейса', async () => {
	const dir = join(emptyRepo(), 'nope');
	const r = await run(['init', '--profile', 'node'], dir);
	expect(r.code).toBe(2);
	expect(r.err).not.toContain('cli.ts');
	expect(r.err).not.toContain('ENOENT');
});
