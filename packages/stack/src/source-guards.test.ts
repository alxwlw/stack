import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

// Код функции команды и боевых портов получает окружение, cwd и argv параметрами: прочитанное из процесса
// делает тест в процессе зависимым от места запуска (в GitHub Actions GITHUB_ACTIONS=true меняет группы).
const NO_PROCESS = [
	'command.ts',
	'output.ts',
	'peers-port.ts',
	'repo-rules-port.ts',
	'sync-pr-port.ts',
	'guardrails-port.ts',
];

// Любое упоминание процесса: окружение, argv и выход, в том числе через Bun.env и деструктуризацию.
const PROCESS_READ = /\bprocess\b|Bun\.(?:env|argv)/;

test.each(NO_PROCESS)('%s не читает процесс: ни окружения, ни cwd, ни argv, ни выхода', (file) => {
	const text = readFileSync(join(import.meta.dir, file), 'utf8');
	expect(text.match(new RegExp(PROCESS_READ, 'g')) ?? []).toStrictEqual([]);
});

test.each([
	'const t = Bun.env.GH_TOKEN;',
	'const { env, argv } = process;',
	'const a = process.argv[2];',
	'const e = process.env;',
	'process.exit(1);',
	'const d = process.cwd();',
	'const v = Bun.argv;',
])('регулярка сторожа ловит нарушение: %s', (line) => {
	expect(PROCESS_READ.test(line)).toBe(true);
});

// Порт печати входа пишет через console: запись в поток обрывает вывод при немедленном выходе (128 КиБ).
test('cli.ts после проводника печатает только через console.log и console.error', () => {
	const text = readFileSync(join(import.meta.dir, 'cli.ts'), 'utf8');
	const entry = text.slice(text.indexOf('const print'));
	expect(entry).toContain('console.log(');
	expect(entry).toContain('console.error(');
	expect(entry.match(STREAM_WRITE) ?? []).toStrictEqual([]);
});

// Сторож шире одного `.write(`: writeSync, Bun.stdout.writer() и любое упоминание stdout/stderr.
const STREAM_WRITE = /\.write\w*\(|\bstd(?:out|err)\b/g;
test.each(['fs.writeSync(1, s)', 'Bun.stdout.writer()', 'process.stdout.write(s)'])(
	'регулярка печати входа ловит запись в поток: %s',
	(line) => {
		expect(line.match(STREAM_WRITE)).not.toBeNull();
	},
);

// Строка 5 приёмки: сквозных запусков cli.ts мало и они в двух файлах; остальное идёт в процессе.
test('сквозных запусков cli.ts вне блока проводника — не больше пятнадцати, в двух файлах', () => {
	const BLOCK = "describe('stack repo-rules', () => {";
	const launches: Record<string, number> = {};
	const aliased: string[] = [];
	for (const f of new Bun.Glob('*.test.ts').scanSync(import.meta.dir)) {
		if (f === 'source-guards.test.ts') continue;
		let text = readFileSync(join(import.meta.dir, f), 'utf8');
		// Псевдоним при импорте прячет запуск от счёта: красный тест называет файл-нарушитель.
		if (/\brunCli\s+as\b|\bCLI\s+as\b/.test(text)) aliased.push(f);
		if (f === 'cli.test.ts') {
			const at = text.indexOf(BLOCK);
			expect(at).toBeGreaterThan(0);
			text = text.slice(0, at);
		}
		// Список импорта — не запуск. Запуск — вызов runCli или константа CLI среди аргументов.
		const body = text.replace(/^import[\s\S]*?;\n/gm, '');
		const n = body.match(/\brunCli\(|[,[(]\s*CLI\s*[,\])]/g)?.length ?? 0;
		if (n > 0) launches[f] = n;
	}
	expect(aliased).toStrictEqual([]);
	expect(Object.keys(launches).toSorted()).toStrictEqual([
		'cli-guardrails-gitleaks.test.ts',
		'cli.test.ts',
	]);
	expect(Object.values(launches).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(15);
});

// Имена канона владельца живут в его настройках, не в исходниках движка (спецификация, «Чего нельзя допустить»).
const ENGINE_SOURCES = readdirSync(import.meta.dir).filter(
	(f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.startsWith('testkit'),
);
// Имена удалённых констант собраны из частей: цельным словом они в тесте были бы остатком удалённого для cite-check.
const REMOVED = [
	['PROF', 'ILES'],
	['STACK_CONFIG_', 'FILE'],
	['SCO', 'PE'],
].map((p) => p.join(''));
const OWNER_NAMES = new RegExp(
	String.raw`\.stack\.jsonc|node\|contracts\|infra|@alxwlw/stack|\b(?:${REMOVED.join('|')})\b`,
	'g',
);

// Имена из частей закреплены в обратном написании: опечатка в части, даже при той же длине, краснит тест.
test('имена удалённых констант собраны без опечаток', () => {
	expect(REMOVED.map((s) => [...s].toReversed().join(''))).toStrictEqual([
		'SELIFORP',
		'ELIF_GIFNOC_KCATS',
		'EPOCS',
	]);
});

test('граница слова: удалённое имя внутри длинного идентификатора не ловится', () => {
	expect(`${REMOVED[2]}D`.match(OWNER_NAMES)).toBeNull();
	expect(`D${REMOVED[2]}`.match(OWNER_NAMES)).toBeNull();
});

test('сторож имён видит исходники', () => {
	expect(ENGINE_SOURCES.length).toBeGreaterThanOrEqual(50);
	expect(ENGINE_SOURCES).toContain('canon-settings.ts');
	expect(ENGINE_SOURCES).not.toContain('testkit-sources.ts');
});

test.each(ENGINE_SOURCES)('%s не называет имена канона владельца', (file) => {
	expect(readFileSync(join(import.meta.dir, file), 'utf8').match(OWNER_NAMES) ?? []).toStrictEqual(
		[],
	);
});

test.each([
	"'.stack.jsonc'",
	"'--profile is required: <node|contracts|infra>'",
	"'./node_modules/@alxwlw/stack/schema.json'",
	`${REMOVED[0]}.join`,
	`join(repoRoot, ${REMOVED[1]})`,
	`name.startsWith(${REMOVED[2]})`,
])('регулярка имён канона владельца ловит: %s', (sample) => {
	expect(sample.match(OWNER_NAMES)).not.toBeNull();
});
