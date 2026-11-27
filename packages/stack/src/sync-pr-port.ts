import { spawnSync } from 'node:child_process';

import type { Print } from './output.ts';
import { type RunProcess, withoutGhToken } from './sync-pr.ts';

// Боевой adapter порта процессов: stdio наследуется, вывод идёт в лог job. Окружение дочернего
// процесса — окружение из параметра без GH_TOKEN (он нужен только gh: установка и хук его не
// получают, скрипты зависимостей читают окружение), сверху — env вызова. Строки об ошибке запуска
// идут в порт печати.
export function runProcess(env: NodeJS.ProcessEnv, print: Print): RunProcess {
	return (cmd, args, opts) => {
		const r = spawnSync(cmd, [...args], {
			cwd: opts.cwd,
			stdio: 'inherit',
			env: { ...withoutGhToken(env), ...opts.env },
		});
		if (r.error) {
			print('err', `sync-pr: ${cmd}: ${r.error.message}`);
			return 127;
		}
		if (r.signal) {
			print('err', `sync-pr: ${cmd} killed by ${r.signal}`);
			return 1;
		}
		return r.status ?? 1;
	};
}
