import type { Canon } from './canon.ts';
import type { Finding } from './findings.ts';
import { MOON_TOOLCHAIN_V1, MOON_TOOLCHAINS, type Repo } from './repo.ts';

// Версию инструмента задаёт .prototools: `version` в moon toolchains — второй пин, и после подъёма
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

// Файл MOON_TOOLCHAIN_V1 moon 2 как конфиг не читает (ни ошибки на невалидном YAML, ни действия пина), поэтому
// содержимое не смотрится и не разбирается: важно само наличие пути. Только отчёт; sync файл не трогает.
export function checkMoonV1Toolchain(repo: Repo): Finding[] {
	if (!repo.paths.has(MOON_TOOLCHAIN_V1)) return [];
	return [
		{
			code: 'moon-v1-toolchain',
			target: MOON_TOOLCHAIN_V1,
			file: MOON_TOOLCHAIN_V1,
			message: `moon 2 does not read this file — it reads ${MOON_TOOLCHAINS} — so nothing in it applies; move the settings still needed there and delete it`,
		},
	];
}
