import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Glob } from 'bun';
import JSON5 from 'json5';

import type { Canon } from './canon.ts';
import type { Finding } from './findings.ts';

const SKIP = /node_modules|\.worktrees|\.moon\/cache|(^|\/)(dist|build)\//;

export function checkInlineVersions(repoRoot: string, canon: Canon): Finding[] {
	if (!existsSync(join(repoRoot, 'pnpm-workspace.yaml'))) return [];
	const canonNames = new Set(Object.values(canon.catalogs).flatMap((e) => Object.keys(e)));
	const findings: Finding[] = [];
	for (const file of new Glob('**/package.json').scanSync({ cwd: repoRoot })) {
		if (SKIP.test(file)) continue;
		let pkg: Record<string, unknown>;
		try {
			pkg = JSON.parse(readFileSync(join(repoRoot, file), 'utf8')) as Record<string, unknown>;
		} catch (err) {
			findings.push({
				code: 'unreadable-file',
				target: file,
				message: `${file} does not parse: ${err instanceof Error ? err.message : String(err)}`,
			});
			continue;
		}
		for (const section of ['dependencies', 'devDependencies'] as const) {
			for (const [name, spec] of Object.entries((pkg[section] ?? {}) as Record<string, string>)) {
				if (!canonNames.has(name) || spec.startsWith('catalog:') || spec.startsWith('workspace:')) {
					continue;
				}
				findings.push({
					code: 'inline-version',
					target: `${file}:${name}`,
					message: `${name} is declared as "${spec}" instead of catalog:`,
					address: { name },
				});
			}
		}
	}
	return findings;
}

export function checkEnginesNode(repoRoot: string, canon: Canon): Finding[] {
	const path = join(repoRoot, 'package.json');
	if (!existsSync(path)) return [];
	let pkg: { engines?: { node?: string } };
	try {
		pkg = JSON.parse(readFileSync(path, 'utf8')) as { engines?: { node?: string } };
	} catch (err) {
		return [
			{
				code: 'unreadable-file',
				target: 'package.json',
				message: `package.json does not parse: ${err instanceof Error ? err.message : String(err)}`,
			},
		];
	}
	const range = pkg.engines?.node;
	if (!range) return [];
	if (Bun.semver.satisfies(canon.nodePin, range)) return [];
	return [
		{
			code: 'engines-node',
			target: 'package.json:engines.node',
			message: `"${range}" doesn't cover the canon pin ${canon.nodePin} — proto will rewrite .prototools from engines`,
		},
	];
}

// Имена и порядок поиска — как у самого Renovate (renovate.json{,c,5} для каждого места; первый
// найденный файл и есть конфиг), без устаревшего package.json#renovate. JSON5.parse читает и JSONC.
export const RENOVATE_CONFIGS = [
	'renovate.json',
	'renovate.jsonc',
	'renovate.json5',
	'.github/renovate.json',
	'.github/renovate.jsonc',
	'.github/renovate.json5',
	'.gitlab/renovate.json',
	'.gitlab/renovate.jsonc',
	'.gitlab/renovate.json5',
	'.renovaterc',
	'.renovaterc.json',
	'.renovaterc.jsonc',
	'.renovaterc.json5',
];
// Строка подключения пресета канона. Ровно с тегом мажора: без тега или с #main потребитель
// получал бы неопубликованный канон, а пресет — тот же источник, что и rollout (плавающий v1).
export const STACK_RENOVATE_PRESET = 'github>alxwlw/stack//renovate/canon.json5#v1';

// Пресет выключает Renovate для всего, что двигает stack sync (proto, каталог dev, @alxwlw/*,
// ссылки alxwlw/stack) — без него бот и rollout перетягивают одни версии. Профиль не важен.
export function checkRenovatePreset(repoRoot: string): Finding[] {
	const found = RENOVATE_CONFIGS.find((p) => existsSync(join(repoRoot, p)));
	if (!found) {
		return [
			{
				code: 'renovate-preset',
				target: 'renovate.json5',
				message: `no Renovate config found — stack sync seeds renovate.json5; an own config must extend "${STACK_RENOVATE_PRESET}"`,
			},
		];
	}
	let doc: unknown;
	try {
		doc = JSON5.parse(readFileSync(join(repoRoot, found), 'utf8'));
	} catch {
		return [
			{ code: 'unreadable-file', target: found, message: `${found} does not parse as JSON5` },
		];
	}
	const ext = (doc as { extends?: unknown } | null)?.extends;
	return Array.isArray(ext) && ext.includes(STACK_RENOVATE_PRESET)
		? []
		: [
				{
					code: 'renovate-preset',
					target: found,
					message: `"extends" must include "${STACK_RENOVATE_PRESET}" — without the canon preset the bot fights stack sync`,
				},
			];
}

const DEPENDABOT_CONFIGS = ['.github/dependabot.yml', '.github/dependabot.yaml'];

// Renovate — единственный бот канона: второй бот открывал бы те же PR, а dependabot не умеет
// выключить каталог dev или .prototools.
export function checkDependabot(repoRoot: string): Finding[] {
	return DEPENDABOT_CONFIGS.filter((p) => existsSync(join(repoRoot, p))).map((p) => ({
		code: 'dependabot-config',
		target: p,
		message: `${p}: the canon's dependency bot is Renovate — move these rules into the Renovate config and delete the file`,
	}));
}
