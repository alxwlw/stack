/**
 * Compile-smoke for the tsconfig presets: each fixture project extends the
 * preset by absolute path (so `${configDir}` resolves against the fixture,
 * exactly like a consuming repo) and must compile with the workspace tsc.
 * Fixtures live INSIDE this package (.test-tmp/, gitignored) so `types`
 * entries (`@types/node`, `@types/bun`) resolve via node_modules walk-up.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, expect, test } from 'bun:test';

const PKG = import.meta.dir;
const TSC = join(PKG, 'node_modules', '.bin', 'tsc');
// Каталог свой у каждого процесса. Раньше он был общий (`.test-tmp`), а `afterEach` сносил его
// целиком — два одновременных `bun test` по одному чекауту убивали фикстуры друг друга, и тесты
// падали с TS5058/EINVAL на исчезнувших путях. Внутри пакета он остаётся сознательно: `types`
// резолвятся обходом node_modules вверх, из /tmp это не работает.
const TMP = join(PKG, '.test-tmp', String(process.pid));

let dir: string;
let counter = 0;
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

function fixture(preset: string, files: Record<string, string>, extra: object = {}): string {
	dir = join(TMP, `fx-${counter++}`);
	mkdirSync(dir, { recursive: true });
	// nodenext treats extensionless files as CJS without a package.json `type`;
	// consuming repos are ESM — mirror that.
	writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
	writeFileSync(
		join(dir, 'tsconfig.json'),
		JSON.stringify({ extends: join(PKG, preset), ...extra }),
	);
	for (const [rel, content] of Object.entries(files)) {
		const abs = join(dir, rel);
		mkdirSync(join(abs, '..'), { recursive: true });
		writeFileSync(abs, content);
	}
	return dir;
}

function tsc(cwd: string, args: string[]): { status: number | null; out: string } {
	const res = spawnSync(TSC, args, { cwd, encoding: 'utf8' });
	return { status: res.status, out: `${res.stdout}\n${res.stderr}` };
}

test('base.json: noUncheckedIndexedAccess rejects an unchecked array read', () => {
	const cwd = fixture(
		'base.json',
		{
			'index.ts': 'const arr: number[] = [1];\nconst x: number = arr[0];\nexport { x };\n',
		},
		{ include: ['*.ts'] },
	);
	const res = tsc(cwd, ['--noEmit', '-p', 'tsconfig.json']);
	expect(res.status).not.toBe(0);
	expect(res.out).toContain('TS2322');
});

test('node.json: types: ["node"] resolves process.env without extra config', () => {
	const cwd = fixture(
		'node.json',
		{
			'index.ts': 'const port: string | undefined = process.env.PORT;\nexport { port };\n',
		},
		{ include: ['*.ts'] },
	);
	const res = tsc(cwd, ['--noEmit', '-p', 'tsconfig.json']);
	expect(res.status, res.out).toBe(0);
});

test('library.json: emitDeclarationOnly writes only .d.ts (+ .d.ts.map), no .js', () => {
	const cwd = fixture(
		'library.json',
		{ 'index.ts': 'export const answer: number = 42;\n' },
		{ include: ['*.ts'], compilerOptions: { outDir: 'dist' } },
	);
	const res = tsc(cwd, ['-p', 'tsconfig.json']);
	expect(res.status, res.out).toBe(0);
	expect(existsSync(join(cwd, 'dist', 'index.d.ts'))).toBe(true);
	expect(existsSync(join(cwd, 'dist', 'index.d.ts.map'))).toBe(true);
	expect(existsSync(join(cwd, 'dist', 'index.js'))).toBe(false);
});

test('react.json: lib DOM resolves browser globals without @types/react', () => {
	const cwd = fixture(
		'react.json',
		{ 'index.ts': 'const el: Element | null = document.querySelector("div");\nexport { el };\n' },
		{ include: ['*.ts'] },
	);
	const res = tsc(cwd, ['--noEmit', '-p', 'tsconfig.json']);
	expect(res.status, res.out).toBe(0);
});

test('refs.json: project-references discipline emits only .d.ts into .tsbuild', () => {
	const cwd = fixture('refs.json', {
		'src/index.ts': 'export const answer: number = 42;\n',
	});
	const res = tsc(cwd, ['--build', 'tsconfig.json']);
	expect(res.status, res.out).toBe(0);
	expect(existsSync(join(cwd, '.tsbuild', 'index.d.ts'))).toBe(true);
	expect(existsSync(join(cwd, '.tsbuild', 'index.js'))).toBe(false);
});

test('nest.json: legacy decorators + metadata compile', () => {
	const cwd = fixture('nest.json', {
		'src/index.ts': [
			'function Injectable(): ClassDecorator {',
			'\treturn () => undefined;',
			'}',
			'export class Dep {}',
			'@Injectable()',
			'export class Svc {',
			'\tconstructor(readonly dep: Dep) {}',
			'}',
			'',
		].join('\n'),
	});
	const res = tsc(cwd, ['--build', 'tsconfig.json']);
	expect(res.status, res.out).toBe(0);
});

test('nest.json really disables verbatimModuleSyntax (type-position value import legal)', () => {
	const cwd = fixture('nest.json', {
		'src/types.ts': 'export interface Shape {\n\ta: number;\n}\n',
		'src/index.ts': 'import { Shape } from "./types.js";\nexport const s: Shape = { a: 1 };\n',
	});
	// Under verbatimModuleSyntax:true (base default) importing a type without the
	// `type` qualifier is an error (TS1484); the nest preset must accept it —
	// decorator DI depends on non-elided imports.
	const res = tsc(cwd, ['--build', 'tsconfig.json']);
	expect(res.status, res.out).toBe(0);
});

test('bun.json: Bun globals + .ts-extension imports typecheck under noEmit', () => {
	const cwd = fixture(
		'bun.json',
		{
			'util.ts': 'export const name: string = "x";\n',
			'main.ts': 'import { name } from "./util.ts";\nconsole.log(Bun.version, name);\n',
		},
		{ include: ['*.ts'] },
	);
	const res = tsc(cwd, ['--noEmit', '-p', 'tsconfig.json']);
	expect(res.status, res.out).toBe(0);
});
