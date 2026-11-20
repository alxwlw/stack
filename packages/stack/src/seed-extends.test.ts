import { expect, test } from 'bun:test';

import { SEED_CHECKS } from './seed-extends.ts';
import { canonFile } from './testkit.ts';

// Тексты находок заданы планом и записаны литералами, не через константы модуля.
const M1 =
	'[extend] path must be ".gitleaks.canon.toml" — without it the canon ruleset does not apply';
const M2 =
	'[extend] must set path = ".gitleaks.canon.toml" in place of useDefault = true — the canon ruleset already extends the default one, and gitleaks refuses a config that sets both';
const M3 =
	'"extends" must include a preset of @alxwlw/oxlint-config, such as "./node_modules/@alxwlw/oxlint-config/node.jsonc" — without it the canon lint rules do not apply';
const M4 =
	'"extends" must name a preset of @alxwlw/tsconfig, such as "@alxwlw/tsconfig/node.json" — without it the canon compiler options do not apply';

const read = (dest: string, text: string): string | undefined => {
	const check = SEED_CHECKS.get(dest);
	if (!check) throw new Error(`SEED_CHECKS has no ${dest}`);
	return check(text);
};

type Row = [name: string, text: string, expected: string | undefined | RegExp];

const expectRow = (dest: string, text: string, expected: string | undefined | RegExp) => {
	const got = read(dest, text);
	if (expected instanceof RegExp) expect(got).toMatch(expected);
	else expect(got).toBe(expected);
};

const GITLEAKS: Row[] = [
	['засев канона', canonFile('.gitleaks.toml'), undefined],
	['таблица', '[extend]\npath = ".gitleaks.canon.toml"\n', undefined],
	['ведущий ./', '[extend]\npath = "./.gitleaks.canon.toml"\n', undefined],
	['два ведущих ./', '[extend]\npath = "././.gitleaks.canon.toml"\n', undefined],
	['точечный ключ', 'extend.path = ".gitleaks.canon.toml"\n', undefined],
	['встроенная таблица', 'extend = { path = ".gitleaks.canon.toml" }\n', undefined],
	['литерал и комментарий', "[extend] # канон\npath = '.gitleaks.canon.toml' # нужно\n", undefined],
	['CRLF', '[extend]\r\npath = ".gitleaks.canon.toml"\r\n', undefined],
	[
		'useDefault = false',
		'[extend]\nuseDefault = false\npath = ".gitleaks.canon.toml"\n',
		undefined,
	],
	[
		'свои allowlists ниже',
		"[extend]\npath = \".gitleaks.canon.toml\"\n\n[[allowlists]]\ndescription = \"x\"\npaths = ['''tests/.*''']\n",
		undefined,
	],
	['только useDefault', '[extend]\nuseDefault = true\n', M2],
	['оба ключа', '[extend]\nuseDefault = true\npath = ".gitleaks.canon.toml"\n', M2],
	['пустой файл', '', M1],
	['нет таблицы', 'title = "x"\n', M1],
	['path закомментирован', '[extend]\n# path = ".gitleaks.canon.toml"\n', M1],
	['другой файл', '[extend]\npath = ".gitleaks.other.toml"\n', M1],
	['путь через ..', '[extend]\npath = "../.gitleaks.canon.toml"\n', M1],
	['path массивом', '[extend]\npath = [".gitleaks.canon.toml"]\n', M1],
	['extend строкой', 'extend = ".gitleaks.canon.toml"\n', M1],
	[
		'path в чужой таблице',
		'[[allowlists]]\ndescription = "x"\npath = ".gitleaks.canon.toml"\n',
		M1,
	],
	[
		'битый TOML',
		'[extend\npath = ".gitleaks.canon.toml"\n',
		/^does not parse as TOML \(.+\) — stack cannot tell whether it extends the canon$/,
	],
];

const OXLINT: Row[] = [
	['засев канона', canonFile('.oxlintrc.json'), undefined],
	['один пресет', '{ "extends": ["./node_modules/@alxwlw/oxlint-config/node.jsonc"] }', undefined],
	[
		'пресет не первый',
		'{ "extends": ["./a.jsonc", "./node_modules/@alxwlw/oxlint-config/nest.jsonc"] }',
		undefined,
	],
	[
		'без ведущего ./',
		'{ "extends": ["node_modules/@alxwlw/oxlint-config/react.jsonc"] }',
		undefined,
	],
	['строкой', '{ "extends": "./node_modules/@alxwlw/oxlint-config/node.jsonc" }', undefined],
	[
		'комментарии и хвостовые запятые',
		'// верх\n{\n\t"extends": [\n\t\t// свой слой\n\t\t"./node_modules/@alxwlw/oxlint-config/node.jsonc",\n\t],\n}\n',
		undefined,
	],
	['BOM', '\uFEFF{ "extends": ["./node_modules/@alxwlw/oxlint-config/node.jsonc"] }', undefined],
	['нет extends', '{}', M3],
	['пустой массив', '{ "extends": [] }', M3],
	['только свой файл', '{ "extends": ["./local.jsonc"] }', M3],
	[
		'имя — хвост чужого сегмента',
		'{ "extends": ["./node_modules/my-@alxwlw/oxlint-config/node.jsonc"] }',
		M3,
	],
	['не строки', '{ "extends": [1, null] }', M3],
	['корень — массив', '[]', M3],
	[
		'упоминание вне extends верхнего уровня',
		'// ./node_modules/@alxwlw/oxlint-config/node.jsonc\n{ "$schema": "./node_modules/@alxwlw/oxlint-config/schema.json", "overrides": [{ "extends": ["./node_modules/@alxwlw/oxlint-config/node.jsonc"] }] }',
		M3,
	],
	[
		'оборванный текст',
		'{ "extends": [',
		'does not parse as JSON with comments (CloseBracketExpected at offset 14) — stack cannot tell whether it extends the canon',
	],
];

const TSCONFIG: Row[] = [
	['засев канона', canonFile('tsconfig.options.json'), undefined],
	['строкой', '{ "extends": "@alxwlw/tsconfig/node.json" }', undefined],
	['без расширения', '{ "extends": "@alxwlw/tsconfig/bun" }', undefined],
	['через node_modules', '{ "extends": "./node_modules/@alxwlw/tsconfig/node.json" }', undefined],
	[
		'массив, пресет не первый',
		'{ "extends": ["./other.json", "@alxwlw/tsconfig/nest.json"] }',
		undefined,
	],
	[
		'комментарии и хвостовая запятая',
		'// верх\n{\n\t"extends": "@alxwlw/tsconfig/node.json", // хвост\n}\n',
		undefined,
	],
	['нет extends', '{ "compilerOptions": {} }', M4],
	['чужой пакет', '{ "extends": "acme-tsconfig/base.json" }', M4],
	['пустой массив', '{ "extends": [] }', M4],
	['имя — хвост чужого сегмента', '{ "extends": "x@alxwlw/tsconfig/node.json" }', M4],
	['число', '{ "extends": 1 }', M4],
	[
		'пустой файл',
		'',
		'does not parse as JSON with comments (ValueExpected at offset 0) — stack cannot tell whether it extends the canon',
	],
];

test.each(GITLEAKS)('засев gitleaks: %s', (_name, text, expected) => {
	expectRow('.gitleaks.toml', text, expected);
});

test.each(OXLINT)('засев oxlint: %s', (_name, text, expected) => {
	expectRow('.oxlintrc.json', text, expected);
});

test.each(TSCONFIG)('засев tsconfig: %s', (_name, text, expected) => {
	expectRow('tsconfig.options.json', text, expected);
});

test('SEED_CHECKS: три засева, в порядке манифеста', () => {
	expect([...SEED_CHECKS.keys()]).toStrictEqual([
		'.gitleaks.toml',
		'.oxlintrc.json',
		'tsconfig.options.json',
	]);
});
