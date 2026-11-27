import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, expect, test } from 'bun:test';
import { parse as parseJsonc } from 'jsonc-parser';

import { canonFor, readCanonSource } from './canon.ts';
import { check, plan, syncRepo } from './check.ts';
import { PROFILES } from './config.ts';
import type { Exception } from './exceptions.ts';
import { loadRepo } from './repo.ts';
import { checkSeedExtends, GITLEAKS_CANON, SEED_CHECKS } from './seed-extends.ts';
import {
	BARE,
	canonFile,
	canonRepoFiles,
	ioError,
	protoBin,
	repoDir,
	runTool,
	testCanon,
	testRepo,
	toolJson,
} from './testkit.ts';
import { checkDir, initRepo, syncDir } from './testkit-acceptance.ts';

// Тексты находок заданы планом и записаны литералами, не через константы модуля.
const M1 =
	'[extend] path must be ".gitleaks.canon.toml" — without it the canon ruleset does not apply';
const M2 =
	'[extend] must set path = ".gitleaks.canon.toml" in place of useDefault = true — the canon ruleset already extends the default one, and gitleaks refuses a config that sets both';
const M5 = (shown: string) =>
	`[extend] useDefault = ${shown} is not a boolean — gitleaks refuses to load the config`;
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
	['[Extend] и Path', '[Extend]\nPath = ".gitleaks.canon.toml"\n', undefined],
	['[EXTEND] и PATH', '[EXTEND]\nPATH = ".gitleaks.canon.toml"\n', undefined],
	['встроенная таблица Extend', 'extend = { Path = ".gitleaks.canon.toml" }\n', undefined],
	[
		'useDefault = "false"',
		'[extend]\nuseDefault = "false"\npath = ".gitleaks.canon.toml"\n',
		undefined,
	],
	['useDefault = 0', '[extend]\nuseDefault = 0\npath = ".gitleaks.canon.toml"\n', undefined],
	['useDefault = ""', '[extend]\nuseDefault = ""\npath = ".gitleaks.canon.toml"\n', undefined],
	['useDefault = "F"', '[extend]\nuseDefault = "F"\npath = ".gitleaks.canon.toml"\n', undefined],
	[
		'две таблицы, действует [Extend] с path',
		'[extend]\nuseDefault = true\n\n[Extend]\npath = ".gitleaks.canon.toml"\n',
		undefined,
	],
	[
		'path и Path в одной таблице, действует Path',
		'[extend]\npath = ".gitleaks.other.toml"\nPath = ".gitleaks.canon.toml"\n',
		undefined,
	],
	['usedefault = true', '[extend]\nusedefault = true\n', M2],
	['UseDefault = "true"', '[extend]\nUseDefault = "true"\n', M2],
	['useDefault = 1', '[extend]\nuseDefault = 1\n', M2],
	['useDefault = -1', '[extend]\nuseDefault = -1\n', M2],
	['useDefault = "T" и path', '[extend]\nuseDefault = "T"\npath = ".gitleaks.canon.toml"\n', M2],
	[
		'две таблицы, действует [Extend] с useDefault',
		'[Extend]\nuseDefault = true\n\n[extend]\npath = ".gitleaks.canon.toml"\n',
		M2,
	],
	['path пустой', '[extend]\npath = ""\n', M1],
	['path с ведущим пробелом', '[extend]\npath = " .gitleaks.canon.toml"\n', M1],
	[
		'useDefault = "yes"',
		'[extend]\nuseDefault = "yes"\npath = ".gitleaks.canon.toml"\n',
		M5('"yes"'),
	],
	[
		'useDefault = [true]',
		'[extend]\nuseDefault = [true]\npath = ".gitleaks.canon.toml"\n',
		M5('[true]'),
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
	['вложенный массив', '{ "extends": [["./node_modules/@alxwlw/oxlint-config/node.jsonc"]] }', M3],
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
	['вложенный массив', '{ "extends": [["@alxwlw/tsconfig/node.json"]] }', M4],
	[
		'пустой файл',
		'',
		'does not parse as JSON with comments (ValueExpected at offset 0) — stack cannot tell whether it extends the canon',
	],
];

test.each(GITLEAKS)('засев gitleaks: %s', (_name, text, expected) => {
	expectRow('.gitleaks.toml', text, expected);
});

// Сверка с настоящим gitleaks: строка таблицы GITLEAKS подключает канон тогда и только тогда, когда
// gitleaks с этим конфигом применяет правило канона (eth-private-key-no-prefix).
// 64 hex собираются во время выполнения; в имени нет key, secret, token.
const HEX = '0123456789abcdef'.repeat(4);
let gitleaksBin = '';
beforeAll(() => {
	gitleaksBin = protoBin('gitleaks');
});

test.each(GITLEAKS)(
	'засев gitleaks читается как у gitleaks: %s',
	(_name, text) => {
		const dir = repoDir({
			'.gitleaks.toml': text,
			'.gitleaks.canon.toml': canonFile('.gitleaks.canon.toml'),
			'src/a.ts': `ETH_PRIV=0x${HEX}\n`,
		});
		try {
			const run = runTool(
				gitleaksBin,
				[
					'dir',
					'.',
					'--no-banner',
					'--no-color',
					'--exit-code',
					'3',
					'--report-format',
					'json',
					'--report-path',
					'-',
				],
				dir,
			);
			const found =
				(run.status === 0 || run.status === 3) &&
				toolJson<{ RuleID: string }[]>(run).some((f) => f.RuleID === 'eth-private-key-no-prefix');
			expect(read('.gitleaks.toml', text) === undefined, run.ctx).toBe(found);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
	30_000,
);

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

// Правило над снимком репозитория.
const seed = (dest: string) => ({
	dest,
	content: canonFile(dest),
	strategy: 'create-if-absent' as const,
});
const canon = testCanon({
	files: [seed('.gitleaks.toml'), seed('.oxlintrc.json'), seed('tsconfig.options.json')],
});
type Over = Parameters<typeof testRepo>[1];
const seeds = (over: Over = {}, exceptions: Exception[] = [], c = canon) =>
	check(testRepo(c, over), c, exceptions);
const NO_PATH = '[extend]\nuseDefault = true\n';
const M6 = 'is not a readable file — stack cannot tell whether it extends the canon';
const BROKEN: [string, string, string][] = [
	['.gitleaks.toml', NO_PATH, M2],
	['.oxlintrc.json', '{}', M3],
	['tsconfig.options.json', '{ "compilerOptions": {} }', M4],
];

test('засевы канона подключают канон — находок нет', () => {
	expect(seeds()).toStrictEqual([]);
});

test.each(BROKEN)('%s не подключает канон — одна находка с адресом и текстом', (dest, text, m) => {
	const findings = seeds({ [dest]: text });
	expect(findings.map((f) => [f.code, f.target, f.message])).toStrictEqual([
		['canon-not-extended', dest, m],
	]);
	expect(findings[0]).toHaveProperty('file', dest);
});

test.each(BROKEN)(
	'%s нет в репозитории — canon-not-extended нет, отсутствие сообщает file-missing',
	(dest) => {
		expect(seeds({ [dest]: null }).map((f) => f.code)).toStrictEqual(['file-missing']);
	},
);

test('три засева не подключают — три находки в порядке файлов канона', () => {
	const findings = seeds(Object.fromEntries(BROKEN.map(([dest, text]) => [dest, text])));
	expect(findings.map((f) => f.code)).toStrictEqual([
		'canon-not-extended',
		'canon-not-extended',
		'canon-not-extended',
	]);
	expect(findings.map((f) => f.target)).toStrictEqual([
		'.gitleaks.toml',
		'.oxlintrc.json',
		'tsconfig.options.json',
	]);
});

test('путь есть, а файла нет (каталог) — находка, не падение и не тишина', () => {
	const findings = seeds({
		'.oxlintrc.json': { failed: ioError('EISDIR', 'illegal operation on a directory, read') },
	});
	expect(findings.map((f) => [f.code, f.target, f.message])).toStrictEqual([
		['canon-not-extended', '.oxlintrc.json', M6],
	]);
});

test('файл не разбирается — canon-not-extended, не unreadable-file', () => {
	const findings = seeds({ '.gitleaks.toml': '[extend\n' });
	expect(findings.map((f) => f.code)).toStrictEqual(['canon-not-extended']);
	expect(findings[0]?.message).toMatch(/^does not parse as TOML \(/);
});

test('исключение { file } держит находку; на подключающий засев оно stale-exception, как раньше', () => {
	const held = { file: '.gitleaks.toml', reason: 'свой набор правил' };
	expect(
		seeds({ '.gitleaks.toml': NO_PATH }, [held]).map((f) => [f.code, f.suppressedBy?.reason]),
	).toStrictEqual([['canon-not-extended', 'свой набор правил']]);
	expect(seeds({}, [held]).map((f) => f.code)).toStrictEqual(['stale-exception']);
});

test('исключение на засев, которого нет, держит file-missing — ни stale-exception, ни новой находки', () => {
	const held = { file: '.oxlintrc.json', reason: 'линтера пока нет' };
	expect(
		seeds({ '.oxlintrc.json': null }, [held]).map((f) => [f.code, f.suppressedBy?.reason]),
	).toStrictEqual([['file-missing', 'линтера пока нет']]);
});

test('исключение на другой файл находку не держит', () => {
	const other = { file: '.oxlintrc.json', reason: 'не тот файл' };
	const pairs = seeds({ '.gitleaks.toml': NO_PATH }, [other])
		.map((f) => [f.code, f.suppressedBy?.reason])
		.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
	expect(pairs).toStrictEqual([
		['canon-not-extended', undefined],
		['stale-exception', undefined],
	]);
});

test('канон без засева — проверки нет, что бы ни лежало по этому пути', () => {
	const onlyGitleaks = testCanon({ files: [seed('.gitleaks.toml')] });
	expect(
		seeds({ '.oxlintrc.json': '{}', 'tsconfig.options.json': '{}' }, [], onlyGitleaks),
	).toStrictEqual([]);
});

test('ключи таблицы — засевы настоящего канона; GITLEAKS_CANON — его verbatim-файл', () => {
	const source = readCanonSource();
	const expected: Record<string, string[]> = {
		node: ['.gitleaks.toml', '.oxlintrc.json', 'tsconfig.options.json'],
		contracts: ['.gitleaks.toml', '.oxlintrc.json', 'tsconfig.options.json'],
		infra: ['.gitleaks.toml'],
	};
	for (const profile of PROFILES) {
		const real = canonFor(source, { profile, with: [], exceptions: [] });
		const seedsOf = real.files
			.filter((f) => f.strategy === 'create-if-absent' && SEED_CHECKS.has(f.dest))
			.map((f) => f.dest);
		expect(seedsOf).toStrictEqual(expected[profile] ?? []);
		const verbatim = real.files.find((f) => f.dest === GITLEAKS_CANON);
		expect(verbatim).toBeDefined();
		expect(verbatim?.strategy).toBeUndefined();
	}
});

test('замена из satisfiedBy не читается; сам засев рядом с ней — читается', () => {
	const replaced = testCanon({
		files: [{ ...seed('.oxlintrc.json'), satisfiedBy: ['oxlint.config.ts'] }],
	});
	expect(
		seeds({ '.oxlintrc.json': null, 'oxlint.config.ts': 'export default {};\n' }, [], replaced),
	).toStrictEqual([]);
	expect(
		seeds({ '.oxlintrc.json': '{}', 'oxlint.config.ts': 'export default {};\n' }, [], replaced).map(
			(f) => f.code,
		),
	).toStrictEqual(['canon-not-extended']);
});

test('sync засев не меняет и находку не снимает', () => {
	expect(plan(testRepo(canon, { '.gitleaks.toml': NO_PATH }), canon)).toStrictEqual([]);
	const dir = repoDir({ ...Object.fromEntries(canonRepoFiles(canon)), '.gitleaks.toml': NO_PATH });
	expect(syncRepo(dir, canon, []).applied).toStrictEqual([]);
	expect(readFileSync(join(dir, '.gitleaks.toml'), 'utf8')).toBe(NO_PATH);
	expect(check(loadRepo(dir, canon), canon, []).map((f) => f.code)).toStrictEqual([
		'canon-not-extended',
	]);
});

test('checkSeedExtends: правило само по себе даёт находку без правки', () => {
	const findings = checkSeedExtends(testRepo(canon, { '.gitleaks.toml': NO_PATH }), canon);
	expect(findings).toStrictEqual([
		{ code: 'canon-not-extended', target: '.gitleaks.toml', file: '.gitleaks.toml', message: M2 },
	]);
});

test('приёмка 7: check сообщает засев без подключения, исключение его держит, sync файл не трогает', () => {
	const dir = repoDir(BARE);
	initRepo(dir);
	syncDir(dir);
	expect(checkDir(dir).code).toBe(0);
	writeFileSync(join(dir, '.gitleaks.toml'), NO_PATH);

	const red = checkDir(dir);
	expect(red.code).toBe(1);
	expect(red.err).toContain(`canon-not-extended: .gitleaks.toml — ${M2}`);
	expect(red.err).toContain('1 finding(s). stack sync does not fix these — fix them by hand');

	// jsonc-parser, не JSON.parse: .stack.jsonc — JSONC, как в cli.test.ts.
	const cfg = parseJsonc(readFileSync(join(dir, '.stack.jsonc'), 'utf8')) as Record<
		string,
		unknown
	>;
	cfg.exceptions = [{ file: '.gitleaks.toml', reason: 'свой набор правил' }];
	writeFileSync(join(dir, '.stack.jsonc'), JSON.stringify(cfg, null, '\t'));
	const held = checkDir(dir);
	expect(held.code).toBe(0);
	expect(held.err).toContain(`allowed (свой набор правил): .gitleaks.toml — ${M2}`);
	expect(held.out).toContain('no drift');

	syncDir(dir);
	expect(readFileSync(join(dir, '.gitleaks.toml'), 'utf8')).toBe(NO_PATH);
});
