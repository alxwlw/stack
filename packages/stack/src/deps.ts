import type { Canon } from './canon.ts';
import type { Finding } from './findings.ts';
import { DEPENDABOT_CONFIGS, type Repo, WORKSPACE_FILE } from './repo.ts';

// Только при pnpm-workspace.yaml: без него каталогов нет, и inline-версия — единственный способ.
export function checkInlineVersions(repo: Repo, canon: Canon): Finding[] {
	if (!repo.paths.has(WORKSPACE_FILE)) return [];
	const canonNames = new Set(Object.values(canon.catalogs).flatMap((e) => Object.keys(e)));
	const findings: Finding[] = [];
	for (const [file, pkg] of repo.packages) {
		for (const section of ['dependencies', 'devDependencies'] as const) {
			for (const [name, spec] of Object.entries((pkg[section] ?? {}) as Record<string, unknown>)) {
				if (
					typeof spec !== 'string' ||
					!canonNames.has(name) ||
					spec.startsWith('catalog:') ||
					spec.startsWith('workspace:')
				) {
					continue;
				}
				findings.push({
					code: 'inline-version',
					target: `${file}:${name}`,
					message: `${name} is declared as "${spec}" instead of catalog:`,
					name,
				});
			}
		}
	}
	return findings;
}

export function checkEnginesNode(repo: Repo, canon: Canon): Finding[] {
	const range = (repo.packages.get('package.json')?.engines as { node?: string } | undefined)?.node;
	if (!range) return [];
	if (Bun.semver.satisfies(canon.pins.node, range)) return [];
	return [
		{
			code: 'engines-node',
			target: 'package.json:engines.node',
			message: `"${range}" doesn't cover the canon pin ${canon.pins.node} — proto will rewrite .prototools from engines`,
		},
	];
}

// Пресет канона выключает Renovate для всего, что двигает sync — без него бот и rollout перетягивают одни
// версии. Строку подключения называет канон параметром правила. Профиль не важен.
export function checkRenovatePreset(repo: Repo, canon: Canon, preset: string): Finding[] {
	const { renovate } = repo;
	const { command } = canon.settings;
	if (!renovate) {
		return [
			{
				code: 'renovate-preset',
				target: 'renovate.json5',
				message: `no Renovate config found — ${command} sync seeds renovate.json5; an own config must extend "${preset}"`,
			},
		];
	}
	// Конфиг не разобрался: находка unreadable-file уже в repo.unreadable.
	if (renovate.config === undefined) return [];
	const { config } = renovate;
	const ext =
		typeof config === 'object' && config !== null && 'extends' in config
			? config.extends
			: undefined;
	return Array.isArray(ext) && ext.includes(preset)
		? []
		: [
				{
					code: 'renovate-preset',
					target: renovate.path,
					message: `"extends" must include "${preset}" — without the canon preset the bot fights ${command} sync`,
				},
			];
}

// Renovate — единственный бот канона: второй бот открывал бы те же PR, а dependabot не умеет
// выключить каталоги канона или .prototools.
export function checkDependabot(repo: Repo): Finding[] {
	return DEPENDABOT_CONFIGS.filter((p) => repo.paths.has(p)).map((p) => ({
		code: 'dependabot-config',
		target: p,
		message: `${p}: the canon's dependency bot is Renovate — move these rules into the Renovate config and delete the file`,
	}));
}
