// @ts-check

/**
 * The `stack` oxlint JS plugin — canon rules the native oxlint rule set does not
 * carry. Loaded from the presets via `jsPlugins` (see `../base.jsonc`); rules
 * are addressed as `stack/<rule>`.
 *
 * - `stack/require-nest-di-decorator` — the canon Nest-DI guard, written
 *   against the ESLint rule API (which runs unmodified under oxlint's
 *   `jsPlugins` host); see the NOTICE file for this rule's origin.
 * - `stack/naming-convention` — port of the canon
 *   `@typescript-eslint/naming-convention` selector subset (typescript-eslint
 *   itself is incompatible with TypeScript 7).
 * - `stack/tsdoc-syntax` — `@microsoft/tsdoc`-backed replacement for
 *   `eslint-plugin-tsdoc`'s `tsdoc/syntax` (whose ≥0.5 module graph requires
 *   the `eslint` package at load time).
 */
import namingConvention from './naming-convention.mjs';
import nestDiPlugin from './require-nest-di-decorator.js';
import tsdocSyntax from './tsdoc-syntax.mjs';

export default {
	meta: { name: 'stack' },
	rules: {
		'require-nest-di-decorator': nestDiPlugin.rules['require-nest-di-decorator'],
		'naming-convention': namingConvention,
		'tsdoc-syntax': tsdocSyntax,
	},
};
