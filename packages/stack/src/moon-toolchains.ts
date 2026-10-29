import type { Canon } from './canon.ts';
import type { Finding } from './findings.ts';
import { MOON_TOOLCHAINS, type Repo } from './repo.ts';

// Версию инструмента задаёт .prototools: `version` в .moon/toolchains.yml — второй пин, и после подъёма
// канона moon разойдётся с ним. Находка при любой заданной версии, даже равной пину; только отчёт.
export function checkMoonToolchains(repo: Repo, canon: Canon): Finding[] {
	const findings: Finding[] = [];
	for (const [tool, cfg] of Object.entries(repo.moonToolchains ?? {})) {
		if (!Object.hasOwn(canon.pins, tool)) continue;
		const version = (cfg as { version?: unknown } | null)?.version;
		if (typeof version !== 'string') continue;
		findings.push({
			code: 'moon-toolchain-version',
			target: `${MOON_TOOLCHAINS}:${tool}.version`,
			message: `"${version}" pins ${tool} a second time — .prototools owns the version; leave it unset (${tool}: {})`,
		});
	}
	return findings;
}
