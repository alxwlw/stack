import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { assertKnownGroups, canonFor, type CanonSource, readCanonSource } from './canon.ts';
import { checkRepo, syncRepo } from './check.ts';
import { readStackConfig, StackConfigError } from './config.ts';
import type { GuardrailRunner } from './guardrails-port.ts';
import { initConfig } from './init.ts';
import { checkOutput, type Print, printLines, syncOutput } from './output.ts';
import { ownVersion } from './own-packages.ts';
import type { PeersReader } from './peers.ts';
import { peersBaseline } from './peers-baseline.ts';
import type { Registry } from './registry.ts';
import type { RepoRulesReader } from './repo-rules.ts';
import { type GitHub, type RunProcess, SYNC_PR_WAIT, syncPr } from './sync-pr.ts';

// Функция команды: argv, окружение, cwd и порты на входе, строки в порт печати и код выхода на выходе.
// Процесс она не читает: окружение, cwd и argv приходят параметрами, выход — возвращаемым кодом.

export type ExitCode = 0 | 1 | 2;

export interface CommandInput {
	argv: readonly string[]; // без имени программы
	env: NodeJS.ProcessEnv;
	cwd: string; // корень репозитория, когда --repo не дан
}

export interface CommandPorts {
	print: Print;
	peers: PeersReader;
	repoRules: RepoRulesReader;
	guardrails: (repoRoot: string) => GuardrailRunner; // фабрика от корня
	run: RunProcess;
	github: (repoRoot: string) => GitHub; // фабрика от корня
	registry: Registry;
}

/** Флаги всех команд в форме parseArgs; `repo` читает каждая команда. */
export const FLAGS = {
	repo: { type: 'string' },
	profile: { type: 'string' },
	with: { type: 'string', multiple: true },
	base: { type: 'string' },
	'no-install': { type: 'boolean' },
	init: { type: 'boolean' },
	'allow-grow': { type: 'boolean' },
} as const;

export type FlagName = keyof typeof FLAGS;

type FlagValues = ReturnType<typeof parseArgs<{ options: typeof FLAGS }>>['values'];

export interface CommandContext {
	repoRoot: string; // --repo как дан, иначе cwd
	flags: { [K in FlagName]?: FlagValues[K] };
	env: NodeJS.ProcessEnv;
	ports: CommandPorts;
	source: CanonSource; // канон, прочитанный один раз на запуск
}

export interface Command {
	flags: readonly Exclude<FlagName, 'repo'>[]; // что команда читает, кроме --repo
	run(ctx: CommandContext): ExitCode | Promise<ExitCode>;
}

/** Команда, которую исполняет вход: в таблице её нет, в списке «Available» она последняя. */
export const PASS_THROUGH = 'repo-rules';

// Ошибка использования: строка в err и код 2, как StackConfigError.
class UsageError extends Error {}

function usage(message: string): never {
	throw new UsageError(message);
}

// Один разбор для всех: исключение parseArgs — ошибка использования с его текстом.
function parse(argv: readonly string[], options: Record<string, (typeof FLAGS)[FlagName]>) {
	try {
		return parseArgs({ args: [...argv], allowPositionals: true, options });
	} catch (error) {
		return usage(error instanceof Error ? error.message : String(error));
	}
}

export const COMMANDS: Record<'init' | 'sync' | 'check' | 'sync-pr' | 'peers-baseline', Command> = {
	init: {
		flags: ['profile', 'with'],
		run({ repoRoot, flags, ports, source }) {
			if (!existsSync(repoRoot)) usage(`--repo does not exist: ${repoRoot}`);
			const profile = flags.profile;
			const { profiles } = source.settings;
			if (!profile) usage(`--profile is required: <${profiles.join('|')}>`);
			if (!profiles.includes(profile)) {
				usage(`unknown --profile "${profile}", expected one of: ${profiles.join(', ')}`);
			}
			assertKnownGroups(flags.with ?? [], source);
			const path = initConfig(repoRoot, source, { profile, with: flags.with ?? [] });
			ports.print('out', `created ${path}`);
			return 0;
		},
	},
	sync: {
		flags: [],
		run({ repoRoot, ports, source }) {
			const cfg = readStackConfig(repoRoot, source.settings);
			printLines(
				ports.print,
				syncOutput(syncRepo(repoRoot, canonFor(source, cfg), cfg.exceptions)),
			);
			return 0;
		},
	},
	check: {
		flags: ['base'],
		run({ repoRoot, flags, env, ports, source }) {
			const cfg = readStackConfig(repoRoot, source.settings);
			const { lines, code } = checkOutput(
				checkRepo(repoRoot, canonFor(source, cfg), cfg.exceptions, {
					ports: {
						peers: ports.peers,
						'repo-rules': ports.repoRules,
						guardrails: ports.guardrails(repoRoot),
					},
					env,
					base: flags.base,
				}),
				source.settings.command,
			);
			printLines(ports.print, lines);
			return code;
		},
	},
	'sync-pr': {
		flags: ['base', 'no-install'],
		run({ repoRoot, flags, env, ports, source }) {
			const appSlug = env.STACK_APP_SLUG;
			if (!env.GH_TOKEN || !appSlug) {
				usage('sync-pr needs GH_TOKEN and STACK_APP_SLUG in the environment');
			}
			return syncPr(
				{
					repoRoot,
					version: ownVersion(),
					base: flags.base,
					appSlug,
					install: !flags['no-install'],
					wait: SYNC_PR_WAIT,
					source,
				},
				{
					run: ports.run,
					github: ports.github(repoRoot),
					registry: ports.registry,
					print: ports.print,
					peers: ports.peers,
					repoRules: ports.repoRules,
				},
			);
		},
	},
	'peers-baseline': {
		flags: ['init', 'allow-grow'],
		run({ repoRoot, flags, ports, source }) {
			if (flags.init && flags['allow-grow']) usage('--init and --allow-grow do not go together');
			const cfg = readStackConfig(repoRoot, source.settings);
			const mode = flags.init ? 'init' : flags['allow-grow'] ? 'grow' : 'lower';
			const r = peersBaseline(repoRoot, canonFor(source, cfg), mode, ports.peers);
			for (const line of r.out) ports.print('out', line);
			for (const line of r.err) ports.print('err', line);
			return r.code;
		},
	},
};

/** Порядок ошибок: чтение канона первым (его сбой вылетает как есть, до разбора argv), разбор всех флагов,
 *  отказ `repo-rules` среди позиционных, неизвестная команда, флаги выбранной команды. Ошибка использования
 *  и StackConfigError — строка в err и код 2; прочее вылетает. */
export async function runCommand(input: CommandInput, ports: CommandPorts): Promise<ExitCode> {
	try {
		const source = readCanonSource();
		const { positionals } = parse(input.argv, FLAGS);
		if (positionals.includes(PASS_THROUGH)) {
			usage(
				`${PASS_THROUGH} takes its own arguments and must come first: ${source.settings.command} ${PASS_THROUGH} [-C <dir>] <command>`,
			);
		}
		const name = positionals[0];
		if (name === undefined || !Object.hasOwn(COMMANDS, name)) {
			const available = [...Object.keys(COMMANDS), PASS_THROUGH].join(', ');
			usage(`unknown command "${name ?? ''}". Available: ${available}`);
		}
		const command = COMMANDS[name as keyof typeof COMMANDS];
		// Второй разбор принимает только --repo и флаги команды: чужой флаг — Unknown option с его именем.
		const own: Record<string, (typeof FLAGS)[FlagName]> = { repo: FLAGS.repo };
		for (const flag of command.flags) own[flag] = FLAGS[flag];
		const { values } = parse(input.argv, own);
		const flags = values as CommandContext['flags'];
		return await command.run({
			repoRoot: flags.repo ?? input.cwd,
			flags,
			env: input.env,
			ports,
			source,
		});
	} catch (error) {
		if (error instanceof UsageError || error instanceof StackConfigError) {
			ports.print('err', error.message);
			return 2;
		}
		throw error;
	}
}
