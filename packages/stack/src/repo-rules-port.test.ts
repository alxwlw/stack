import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

import { ownVersion } from './own-packages.ts';
import { inProcessRepoRules } from './repo-rules-port.ts';

const imports = (file: string, kind?: string): string[] =>
	new Bun.Transpiler({ loader: 'ts' })
		.scanImports(readFileSync(join(import.meta.dir, file), 'utf8').replace(/^#!.*\n/, ''))
		.filter((i) => kind === undefined || i.kind === kind)
		.map((i) => i.path);
const isKit = (f: string): boolean => /^testkit[^/]*\.ts$/.test(f);
// Исходники без помощников тестов; тесты — вместе с помощниками (testkit*.ts): обёртка над main там же тест.
const sources = (test: boolean): string[] =>
	[...new Bun.Glob('*.ts').scanSync(import.meta.dir)]
		.filter((f) =>
			test ? f.endsWith('.test.ts') || isKit(f) : !f.endsWith('.test.ts') && !isKit(f),
		)
		.toSorted();

test('inProcessRepoRules: настоящий repo-rules в процессе, вывод — строками в ответе', () => {
	expect(inProcessRepoRules(['--version'], {})).toStrictEqual({
		code: 0,
		out: ownVersion(),
		err: '',
	});
});

test('@alxwlw/repo-rules берут ровно два файла — вход и adapter, оба по имени пакета', () => {
	const importers = sources(false).filter((f) => imports(f).includes('@alxwlw/repo-rules'));
	expect(importers).toStrictEqual(['cli.ts', 'repo-rules-port.ts']);
	for (const f of importers) {
		expect(imports(f).filter((p) => p.includes('repo-rules/'))).toStrictEqual([]);
	}
});

test('тесты не импортируют main repo-rules: он зовётся через inProcessRepoRules', () => {
	const direct = sources(true).filter((f) =>
		imports(f, 'import-statement').includes('@alxwlw/repo-rules'),
	);
	expect(direct).toStrictEqual([]);
});
