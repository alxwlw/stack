// @ts-check

/**
 * Local re-export shim for `eslint-plugin-simple-import-sort`, loaded by
 * oxlint as a JS plugin (the upstream package runs unmodified under oxlint's
 * ESLint-compatible rule API, autofix included).
 *
 * Why a shim instead of naming the npm package directly in `jsPlugins`:
 * module resolution then happens relative to THIS file — i.e. from
 * `@alxwlw/oxlint-config`'s own dependency tree — independent of the consuming
 * repo's cwd or hoisting layout (strict-pnpm safe).
 */
import plugin from 'eslint-plugin-simple-import-sort';

export default {
	meta: { name: 'simple-import-sort' },
	rules: plugin.rules,
};
