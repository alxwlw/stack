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

test.each(NO_PROCESS)('%s не читает процесс: ни окружения, ни cwd, ни argv, ни выхода', (file) => {
	const text = readFileSync(join(import.meta.dir, file), 'utf8');
	expect(text.match(/process\.(?:env|cwd|exit)|Bun\.argv/g) ?? []).toStrictEqual([]);
});
