// Помощники приёмки ниже команды: initRepo, syncDir, checkDir, baselineDir на боевых adapter и
// guardRepos для репозиториев под git. Отдельно от testkit.ts: тот общий для всех тестов и упёрся в
// предел 800 строк; здесь только то, что берут тесты приёмки Guardrails, peers и команд.
import { rmSync } from 'node:fs';

import { assertKnownGroups, loadCanon } from './canon.ts';
import { checkRepo, syncRepo } from './check.ts';
import { type Profile, readStackConfig } from './config.ts';
import { spawnRunner } from './guardrails-port.ts';
import { initConfig } from './init.ts';
import { checkOutput, syncOutput } from './output.ts';
import { peersBaseline, type PeersBaselineMode } from './peers-baseline.ts';
import { pnpmPeers } from './peers-port.ts';
import { inProcessRepoRules } from './repo-rules-port.ts';
import { BARE, channels, git, gitRepo, OWNER_SOURCE, testEnv } from './testkit.ts';

// Приёмка ниже команды: те же функции, что зовёт обработчик, на боевых adapter. StackConfigError они
// не ловят — случаи с кодом 2 идут через runStack.

/** `stack init` в процессе: assertKnownGroups и initConfig; профиль по умолчанию — node. */
export function initRepo(dir: string, opts: { profile?: Profile; with?: string[] } = {}): void {
	const groups = opts.with ?? [];
	assertKnownGroups(groups, OWNER_SOURCE);
	initConfig(dir, OWNER_SOURCE, { profile: opts.profile ?? 'node', with: groups });
}

/** `stack sync` в процессе: syncRepo по конфигурации каталога и syncOutput. */
export function syncDir(dir: string): { out: string; err: string } {
	const cfg = readStackConfig(dir, OWNER_SOURCE.settings);
	return channels(syncOutput(syncRepo(dir, loadCanon(cfg), cfg.exceptions)));
}

/** `stack check` в процессе: checkRepo с pnpmPeers, inProcessRepoRules и spawnRunner(dir, env), затем
 *  checkOutput. env = testEnv(opts.env) — одно и то же окружение идёт в adapter и в checkRepo. */
export function checkDir(
	dir: string,
	opts: { env?: Record<string, string>; base?: string } = {},
): { code: 0 | 1; out: string; err: string } {
	const env = testEnv(opts.env);
	const cfg = readStackConfig(dir, OWNER_SOURCE.settings);
	const { lines, code } = checkOutput(
		checkRepo(dir, loadCanon(cfg), cfg.exceptions, {
			ports: {
				peers: pnpmPeers(env),
				'repo-rules': inProcessRepoRules,
				guardrails: spawnRunner(dir, env),
			},
			env,
			base: opts.base,
		}),
	);
	return { code, ...channels(lines) };
}

/** `stack peers-baseline` в процессе на pnpmPeers(testEnv(env)). */
export function baselineDir(
	dir: string,
	mode: PeersBaselineMode,
	env?: Record<string, string>,
): { code: 0 | 1 | 2; out: string; err: string } {
	const cfg = readStackConfig(dir, OWNER_SOURCE.settings);
	const r = peersBaseline(dir, loadCanon(cfg), mode, pnpmPeers(testEnv(env)));
	return {
		code: r.code,
		out: r.out.map((l) => `${l}\n`).join(''),
		err: r.err.map((l) => `${l}\n`).join(''),
	};
}

// Один репозиторий приёмки: тело guardRepos().guardRepo; made копит каталоги для clean.
function guardRepo(
	made: string[],
	files: Record<string, string>,
	opts: { group?: boolean; profile?: Profile } = {},
): { dir: string; remote: string } {
	const profile = opts.profile ?? 'node';
	const repo = gitRepo(profile === 'node' ? { ...BARE, ...files } : files);
	made.push(repo.dir, repo.remote);
	initRepo(repo.dir, { profile, with: opts.group === false ? [] : ['guardrails'] });
	syncDir(repo.dir);
	git(repo.dir, 'add', '-A');
	git(repo.dir, 'commit', '-m', 'canon');
	git(repo.dir, 'push', 'origin', 'main');
	return repo;
}

/** Репозитории под git для приёмки групп правил. guardRepo: gitRepo из files (для профиля node — поверх
 *  BARE), initRepo с группой guardrails (group: false — без неё), syncDir, коммит `canon`, push в
 *  origin/main. clean удаляет все созданные каталоги: его зовёт afterAll файла. */
export function guardRepos(): {
	guardRepo(
		files: Record<string, string>,
		opts?: { group?: boolean; profile?: Profile },
	): { dir: string; remote: string };
	clean(): void;
} {
	const made: string[] = [];
	return {
		guardRepo: (files, opts) => guardRepo(made, files, opts),
		clean: () => {
			for (const d of made) rmSync(d, { recursive: true, force: true });
		},
	};
}
