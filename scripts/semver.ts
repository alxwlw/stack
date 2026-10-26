/**
 * Только regex, без импортов: его берут `scripts/version.ts` и `scripts/rollout.ts`, а job `rollout`
 * запускается с `install: false` (см. docs/release.md) — источник регулярки не тянет пакеты.
 */
export const SEMVER_RE = /^\d+\.\d+\.\d+(-[\w.]+)?$/;
