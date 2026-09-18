/**
 * Только regex, без импортов. `scripts/version.ts` тянет за собой `packages/stack/src/catalogs.ts`
 * (пакет `yaml`) и `config.ts` (`jsonc-parser`) — доступные локально, но не в job `rollout` (запускается
 * с `install: false`, см. docs/release.md), поэтому у `rollout.ts` должен быть отдельный от него,
 * ничего не тянущий источник этой регулярки.
 */
export const SEMVER_RE = /^\d+\.\d+\.\d+(-[\w.]+)?$/;
