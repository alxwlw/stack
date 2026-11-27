import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { parse as parseJsonc } from 'jsonc-parser';

import { BARE, gitRepo, isolateGitConfig, repoDir, runStack, UNMET_PEER_LOCK } from './testkit.ts';
import { initRepo, syncDir } from './testkit-acceptance.ts';

// Команды на каталоге: функция команды на подставных портах, файлы пишет настоящий код. Окружение —
// только то, что тест передал; процесс cli.ts не запускается (сквозной набор — cli.test.ts).
const TOKEN_ENV = { GH_TOKEN: 'secret-token', STACK_APP_SLUG: 'acme-bot' };
const NODE_REPO = { ...BARE, '.stack.jsonc': '{ "profile": "node" }' };

test('init создаёт конфигурацию, повторный init — код 2', async () => {
	const dir = repoDir(BARE);
	expect((await runStack(['init', '--profile', 'node'], dir)).code).toBe(0);
	expect((await runStack(['init', '--profile', 'node'], dir)).code).toBe(2);
});

test('check без .stack.jsonc — код 2 с подсказкой', async () => {
	const dir = repoDir(BARE);
	const r = await runStack(['check'], dir);
	expect(r.code).toBe(2);
	expect(r.err).toContain('stack init');
});

test('check до sync — код 1, после sync — код 0', async () => {
	const dir = repoDir(BARE);
	initRepo(dir);
	expect((await runStack(['check'], dir)).code).toBe(1);
	const synced = await runStack(['sync'], dir);
	expect(synced.code).toBe(0);
	expect(synced.out).toContain('seeded');
	expect(synced.out).toContain('updated');
	expect((await runStack(['check'], dir)).code).toBe(0);
});

test('sync-pr --base без значения — код 2, сообщение parseArgs, файлы не тронуты', async () => {
	const dir = repoDir({ '.stack.jsonc': '{ "profile": "node" }' });
	// --repo после --base даёт «argument is ambiguous»: parseArgs читает его как значение флага.
	const r = await runStack(['sync-pr', '--base', '--repo', dir], dir, { env: TOKEN_ENV });
	expect(r.code).toBe(2);
	expect(r.err).toContain("Option '--base' argument is ambiguous");
	expect(readdirSync(dir)).toEqual(['.stack.jsonc']);
});

describe('sync-pr на подставных портах', () => {
	let restore: () => void;
	beforeAll(() => {
		restore = isolateGitConfig();
	});
	afterAll(() => restore());

	test('окружение задано, нет .stack.jsonc — код 2 из sync, не из проверки окружения', async () => {
		const r = await runStack(['sync-pr'], repoDir(BARE), { env: TOKEN_ENV });
		expect(r.code).toBe(2);
		expect(r.err).not.toContain('sync-pr needs');
		expect(r.err).toContain('stack init');
	});

	test('proto не найден — код 127 в сообщении шага', async () => {
		// Порт процессов отвечает 127 на `proto install`; строка «sync-pr: proto: …» — дело adapter,
		// её держит sync-pr-port.test.ts («команды нет на PATH»).
		const r = await runStack(['sync-pr', '--no-install'], repoDir(NODE_REPO), {
			env: TOKEN_ENV,
			ports: { run: (cmd) => (cmd === 'proto' ? 127 : 0) },
		});
		expect(r.code).toBe(1);
		expect(r.err).toContain('`proto install` exited with 127');
	});

	test('--no-install: pnpm не зовётся', async () => {
		const { dir } = gitRepo(NODE_REPO);
		const r = await runStack(['sync-pr', '--no-install'], dir, { env: TOKEN_ENV });
		expect(r.code, r.err).toBe(0);
		expect(r.journal).toContain('proto install');
		expect(
			r.journal.filter((l) => l.startsWith('pnpm install') || l.startsWith('pnpm dedupe')),
		).toStrictEqual([]);
	});
});

test('init без --profile — код 2', async () => {
	const dir = repoDir(BARE);
	const r = await runStack(['init'], dir);
	expect(r.code).toBe(2);
	expect(r.err).toContain('--profile');
	expect(existsSync(join(dir, '.stack.jsonc'))).toBe(false);
});

test('init с недопустимым --profile — код 2, файл не создан', async () => {
	const dir = repoDir(BARE);
	const r = await runStack(['init', '--profile', 'банан'], dir);
	expect(r.code).toBe(2);
	expect(r.err).toContain('банан');
	expect(existsSync(join(dir, '.stack.jsonc'))).toBe(false);
});

test('.stack.jsonc с синтаксической ошибкой — check и sync код 2', async () => {
	const dir = repoDir(BARE);
	writeFileSync(join(dir, '.stack.jsonc'), '{ nope');
	const checked = await runStack(['check'], dir);
	expect(checked.code).toBe(2);
	expect(checked.err).toContain('JSONC');
	expect((await runStack(['sync'], dir)).code).toBe(2);
});

test('.stack.jsonc с неизвестным ключом — check и sync код 2, одна строка, sync ничего не пишет', async () => {
	const dir = repoDir(BARE);
	writeFileSync(join(dir, '.stack.jsonc'), '{ "profile": "node", "wiht": ["libs"] }');
	const checked = await runStack(['check'], dir);
	expect(checked.code).toBe(2);
	expect(checked.err).toContain('unknown key "wiht"');
	expect(checked.err.trim().split('\n')).toHaveLength(1);
	expect((await runStack(['sync'], dir)).code).toBe(2);
	expect(existsSync(join(dir, '.editorconfig'))).toBe(false);
});

test('повторный sync — без изменений, код 0', async () => {
	const dir = repoDir(BARE);
	initRepo(dir);
	syncDir(dir);
	const again = await runStack(['sync'], dir);
	expect(again.code).toBe(0);
	expect(again.out).toContain('already up to date');
});

test('подавленная находка печатается предупреждением, код 0', async () => {
	const dir = repoDir(BARE);
	initRepo(dir);
	syncDir(dir);
	rmSync(join(dir, '.editorconfig'));
	// jsonc-parser, не JSON.parse: .stack.jsonc — JSONC (trailing comma), как читает readStackConfig.
	const cfg = parseJsonc(readFileSync(join(dir, '.stack.jsonc'), 'utf8')) as Record<
		string,
		unknown
	>;
	cfg.exceptions = [{ file: '.editorconfig', reason: 'тест: намеренно подавлено' }];
	writeFileSync(join(dir, '.stack.jsonc'), JSON.stringify(cfg, null, '\t'));
	const r = await runStack(['check'], dir);
	expect(r.code).toBe(0);
	expect(r.err).toContain('тест: намеренно подавлено');
	expect(r.err).toContain('.editorconfig');
	expect(r.out).toContain('no drift');
});

test('неизвестный флаг — код 2, без необработанного исключения', async () => {
	const dir = repoDir(BARE);
	const r = await runStack(['sync', '--bogus'], dir);
	expect(r.code).toBe(2);
	expect(r.err).toContain('bogus');
	// В процессе — «строка ошибки одна и без пути»: стектрейс с cli.ts здесь невозможен, утверждение держит форму.
	expect(r.err).not.toContain('cli.ts');
});

test('init с несуществующим --repo — код 2, без стектрейса', async () => {
	const missing = join(repoDir(BARE), 'nope');
	const r = await runStack(['init', '--profile', 'node', '--repo', missing], repoDir(BARE));
	expect(r.code).toBe(2);
	expect(r.err).toBe(`--repo does not exist: ${missing}\n`);
	expect(r.err).not.toContain('cli.ts');
	expect(r.err).not.toContain('ENOENT');
});

test('sync с исключением на файл: файл не тронут, строка allowed, check — код 0', async () => {
	const dir = repoDir(BARE);
	writeFileSync(
		join(dir, '.stack.jsonc'),
		'{ "profile": "node", "with": [], "exceptions": [{ "file": ".editorconfig", "reason": "свой отступ" }] }',
	);
	writeFileSync(join(dir, '.editorconfig'), 'свой\n');
	const synced = await runStack(['sync'], dir);
	expect(synced.code).toBe(0);
	expect(synced.out).not.toContain('updated .editorconfig');
	expect(synced.err).toContain('allowed (свой отступ): .editorconfig');
	expect(readFileSync(join(dir, '.editorconfig'), 'utf8')).toBe('свой\n');
	expect((await runStack(['check'], dir)).code).toBe(0);
});

// конфиг dependabot в репо — находка dependabot-config: её правят руками (перенос в Renovate), sync файл не трогает.
const DEPENDABOT_CONFIG =
	"version: 2\nupdates:\n  - package-ecosystem: 'npm'\n    directory: '/'\n    schedule:\n      interval: 'weekly'\n";

function syncedRepo(): string {
	const dir = repoDir(BARE);
	initRepo(dir);
	syncDir(dir);
	mkdirSync(join(dir, '.github'), { recursive: true });
	writeFileSync(join(dir, '.github/dependabot.yml'), DEPENDABOT_CONFIG);
	return dir;
}

test('check: находка, которую sync не чинит, — без совета stack sync', async () => {
	const r = await runStack(['check'], syncedRepo());
	expect(r.code).toBe(1);
	expect(r.err).toContain('dependabot-config');
	expect(r.err).not.toContain('Fix with: stack sync');
	expect(r.err).toContain('1 finding(s). stack sync does not fix these — fix them by hand');
});

test('check: смесь — в подсказке оба числа', async () => {
	const dir = syncedRepo();
	rmSync(join(dir, '.editorconfig'));
	rmSync(join(dir, '.oxfmtrc.jsonc'));
	const r = await runStack(['check'], dir);
	expect(r.code).toBe(1);
	expect(r.err).toContain('3 finding(s): 2 fixable with: stack sync, 1 to fix by hand');
});

test('check: подавленная находка не входит в числа подсказки', async () => {
	const dir = syncedRepo();
	rmSync(join(dir, '.editorconfig'));
	const cfg = parseJsonc(readFileSync(join(dir, '.stack.jsonc'), 'utf8')) as Record<
		string,
		unknown
	>;
	cfg.exceptions = [{ file: '.editorconfig', reason: 'тест: подавлено' }];
	writeFileSync(join(dir, '.stack.jsonc'), JSON.stringify(cfg, null, '\t'));
	const r = await runStack(['check'], dir);
	expect(r.code).toBe(1);
	expect(r.err).toContain('1 finding(s). stack sync does not fix these');
});

test('check: всё чинит sync — подсказка прежняя', async () => {
	const dir = repoDir(BARE);
	initRepo(dir);
	syncDir(dir);
	rmSync(join(dir, '.editorconfig'));
	const r = await runStack(['check'], dir);
	expect(r.code).toBe(1);
	expect(r.err).toMatch(/\n\d+ finding\(s\)\. Fix with: stack sync\n/);
});

// Группа renovate устарела и ничего не включает: репо с ней и без конфига Renovate получает засев
// от sync, и check после этого чист — прежнее правило про ignore краснело на засеянном пресете.
test('with renovate без конфига Renovate: sync засевает renovate.json5, check — код 0 без находок', async () => {
	const dir = repoDir(BARE);
	expect((await runStack(['init', '--profile', 'node', '--with', 'renovate'], dir)).code).toBe(0);
	expect(existsSync(join(dir, 'renovate.json5'))).toBe(false);
	const synced = await runStack(['sync'], dir);
	expect(synced.code).toBe(0);
	expect(readFileSync(join(dir, 'renovate.json5'), 'utf8')).toContain(
		'github>alxwlw/stack//renovate/canon.json5#v1',
	);
	const checked = await runStack(['check'], dir);
	expect(checked.err).not.toContain('renovate');
	expect(checked.code).toBe(0);
});

test('check и sync с опечаткой в with — код 2, ошибка называет группу', async () => {
	const dir = repoDir(BARE);
	writeFileSync(join(dir, '.stack.jsonc'), '{ "profile": "node", "with": ["moon-task"] }');
	for (const command of ['check', 'sync']) {
		const r = await runStack([command], dir);
		expect(r.code).toBe(2);
		expect(r.err).toContain('unknown group "moon-task"');
		expect(r.err).not.toContain('cli.ts');
	}
});

test('init с неизвестной --with — код 2, файл не создан', async () => {
	const dir = repoDir(BARE);
	const r = await runStack(['init', '--profile', 'node', '--with', 'moon-task'], dir);
	expect(r.code).toBe(2);
	expect(existsSync(join(dir, '.stack.jsonc'))).toBe(false);
});

test('init с опечаткой во второй --with — код 2, файл не создан', async () => {
	const dir = repoDir(BARE);
	const r = await runStack(
		['init', '--profile', 'node', '--with', 'libs', '--with', 'moon-task'],
		dir,
	);
	expect(r.code).toBe(2);
	expect(r.err).toContain('unknown group "moon-task"');
	expect(existsSync(join(dir, '.stack.jsonc'))).toBe(false);
});

describe('peers-baseline на подставных портах', () => {
	test('peers-baseline: --init и --allow-grow вместе — код 2, файл не создан', async () => {
		const dir = repoDir(BARE);
		initRepo(dir, { with: ['peers'] });
		syncDir(dir);
		writeFileSync(join(dir, 'pnpm-lock.yaml'), UNMET_PEER_LOCK);
		const r = await runStack(['peers-baseline', '--init', '--allow-grow'], dir);
		expect(r.code).toBe(2);
		expect(r.err).toBe('--init and --allow-grow do not go together\n');
		expect(existsSync(join(dir, '.stack-peers-baseline.json'))).toBe(false);
	});

	test('peers-baseline без группы peers — код 2, сообщение называет with', async () => {
		const dir = repoDir(BARE);
		initRepo(dir);
		writeFileSync(join(dir, 'pnpm-lock.yaml'), UNMET_PEER_LOCK);
		const r = await runStack(['peers-baseline', '--init'], dir);
		expect(r.code).toBe(2);
		expect(r.err).toBe('peers-baseline needs "peers" in "with" of .stack.jsonc\n');
	});

	test('peers-baseline без .stack.jsonc — код 2 с подсказкой stack init', async () => {
		const r = await runStack(['peers-baseline'], repoDir(BARE));
		expect(r.code).toBe(2);
		expect(r.err).toContain('stack init');
	});
});

test('init и check отвергают опечатку в with одной и той же строкой', async () => {
	const initDir = repoDir(BARE);
	const init = await runStack(['init', '--profile', 'node', '--with', 'typo'], initDir);
	const checkDir = repoDir(BARE);
	writeFileSync(join(checkDir, '.stack.jsonc'), '{ "profile": "node", "with": ["typo"] }');
	const check = await runStack(['check'], checkDir);
	expect(init.code).toBe(2);
	expect(check.code).toBe(2);
	const line = (err: string) => err.split('\n').find((l) => l.includes('unknown group'));
	expect(line(init.err)).toContain('unknown group "typo" in "with", expected one of: ');
	expect(line(init.err)).toBe(line(check.err));
});
