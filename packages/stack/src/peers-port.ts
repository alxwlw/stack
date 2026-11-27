import { spawnSync } from 'node:child_process';

import type { PeersReader } from './peers.ts';
import { withoutGhToken } from './sync-pr.ts';

// Боевой adapter порта pnpm для группы peers: вывод захватывается, разбор — peersOutcome. Проверка
// идёт по локу, без установки; GH_TOKEN не нужен pnpm, как и установке в sync-pr. Окружение дочернего
// процесса — окружение из параметра без GH_TOKEN.
export function pnpmPeers(env: NodeJS.ProcessEnv): PeersReader {
	return (cwd) => {
		const r = spawnSync('pnpm', ['peers', 'check', '--lockfile-only', '--json'], {
			cwd,
			encoding: 'utf8',
			maxBuffer: 1 << 30,
			env: withoutGhToken(env),
		});
		if (r.error) return { error: r.error.message };
		return { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr };
	};
}
