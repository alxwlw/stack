// @ts-check

/**
 * Wrapper around the vendored `eslint-plugin-simple-import-sort` 14.0.0
 * (rules/vendor/, MIT, logic unmodified — see NOTICE), loaded by oxlint as a
 * JS plugin. Vendored rather than an npm dependency: the package has an
 * `eslint` peer, and pnpm pulled ESLint into every consumer's lockfile.
 */
import plugin from './vendor/simple-import-sort/index.cjs';

export default {
	meta: { name: 'simple-import-sort' },
	rules: plugin.rules,
};
