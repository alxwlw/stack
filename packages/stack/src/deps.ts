import type { Canon } from './canon.ts';
import type { Finding } from './findings.ts';
import { DEPENDABOT_CONFIGS, type Repo } from './repo.ts';

// Только при pnpm-workspace.yaml: без него каталогов нет, и inline-версия — единственный способ.
export function checkInlineVersions(repo: Repo, canon: Canon): Finding[] {
	if (!repo.paths.has('pnpm-workspace.yaml')) return [];
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

// Строка подключения пресета канона. Ровно с тегом мажора: без тега или с #main потребитель
// получал бы неопубликованный канон, а пресет — тот же источник, что и rollout (плавающий v1).
export const STACK_RENOVATE_PRESET = 'github>alxwlw/stack//renovate/canon.json5#v1';

// Пресет выключает Renovate для всего, что двигает stack sync (proto, каталоги канона dev и libs, @alxwlw/*,
// ссылки alxwlw/stack) — без него бот и rollout перетягивают одни версии. Профиль не важен.
export function checkRenovatePreset(repo: Repo): Finding[] {
	const { renovate } = repo;
	if (!renovate) {
		return [
			{
				code: 'renovate-preset',
				target: 'renovate.json5',
				message: `no Renovate config found — stack sync seeds renovate.json5; an own config must extend "${STACK_RENOVATE_PRESET}"`,
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
	return Array.isArray(ext) && ext.includes(STACK_RENOVATE_PRESET)
		? []
		: [
				{
					code: 'renovate-preset',
					target: renovate.path,
					message: `"extends" must include "${STACK_RENOVATE_PRESET}" — without the canon preset the bot fights stack sync`,
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
