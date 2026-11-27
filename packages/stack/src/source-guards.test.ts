import { readFileSync } from 'node:fs';
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
	expect(entry.match(/\.write\(/g) ?? []).toStrictEqual([]);
});
