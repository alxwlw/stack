import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, expect, test } from 'bun:test';

import { loadCanon } from './canon.ts';
import { syncRepo } from './check.ts';
import { readStackConfig } from './config.ts';
import { initConfig } from './init.ts';
import { MOON_WORKSPACE } from './repo.ts';
import { git, gitRepo, isolateGitConfig, protoBin, runTool } from './testkit.ts';

let restore: () => void;
beforeAll(() => {
	restore = isolateGitConfig();
});
afterAll(() => {
	restore();
});

// Окружение push-события. Решает чистка MOON_*: унаследованный MOON_BASE=main дал бы moon базу
// из окружения, и контроль без настройки стал бы зелёным. GITHUB_* здесь перекрываются или
// безвредны (push с одним GITHUB_BASE_REF остаётся красным); чистка оставлена целиком для
// предсказуемости.
const PUSH_ENV: NodeJS.ProcessEnv = {
	...Object.fromEntries(
		Object.entries(process.env).filter(([k]) => !/^(CI|GITHUB_\w+|RUNNER_\w+|MOON_\w+)$/.test(k)),
	),
	CI: 'true',
	GITHUB_ACTIONS: 'true',
	GITHUB_EVENT_NAME: 'push',
	GITHUB_REF: 'refs/heads/main',
};

// Воркспейс tools и harness до их PR #2: проекты есть, vcs нет.
const USER_WS = "projects:\n  app: 'app'\n";

test('stack init с moon-tasks и свой moon-воркспейс без vcs: после sync moon run на push в main зелёный, без vcs.defaultBranch — красный на master', () => {
	const { dir } = gitRepo({
		'package.json': JSON.stringify({ name: 'repo', private: true }),
		[MOON_WORKSPACE]: USER_WS,
		'app/moon.yml': "tasks:\n  noop:\n    command: 'echo ok'\n",
	});
	initConfig(dir, { profile: 'node', with: ['moon-tasks'] });
	const cfg = readStackConfig(dir);
	syncRepo(dir, loadCanon(cfg), cfg.exceptions);
	git(dir, 'add', '-A');
	git(dir, 'commit', '-m', 'sync');

	expect(readFileSync(join(dir, MOON_WORKSPACE), 'utf8')).toBe(
		USER_WS + 'vcs:\n  defaultBranch: main\n',
	);
	const moon = protoBin('moon');
	const green = runTool(moon, ['run', ':noop'], dir, PUSH_ENV);
	expect(green.status, green.ctx).toBe(0);

	// Контроль: без vcs тот же вызов красный, иначе тест ничего не доказывает.
	writeFileSync(join(dir, MOON_WORKSPACE), USER_WS);
	git(dir, 'commit', '-am', 'без vcs');
	const red = runTool(moon, ['run', ':noop'], dir, PUSH_ENV);
	expect(red.status, red.ctx).not.toBe(0);
	expect(red.stdout + red.stderr, red.ctx).toContain("ambiguous argument 'master'");
}, 60_000);
