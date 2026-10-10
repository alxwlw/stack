# @alxwlw/oxlint-config

The alxwlw lint canon for **oxlint 1.x + oxlint-tsgolint**, built for repos on
**TypeScript 7** (typescript-eslint has no TS7-compatible compiler API until
TS 7.1 and upstream will not support 7.0; tsgolint embeds typescript-go, so
the repo's `typescript` version is irrelevant to linting).

## Presets

| Preset    | Extends     | Adds                                                                                                                                                |
| --------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `base`    | —           | correctness category, full type-aware set (tsgolint), simple-import-sort                                                                            |
| `node`    | `base`      | `stack/naming-convention` (canon selector set)                                                                                                      |
| `nest`    | `node`      | `stack/require-nest-di-decorator`; `typescript/require-await` off (Nest guard contract); `typescript/consistent-type-imports` off (DI-safe imports) |
| `react`   | `base`      | react-hooks classic pair + eslint-plugin-react recommended + jsx-a11y recommended ports                                                             |
| `next`    | `react`     | oxlint `nextjs` plugin                                                                                                                              |
| `library` | — (overlay) | `stack/tsdoc-syntax` for TS/TSX; reads the nearest `tsdoc.json`                                                                                     |

`base` deliberately carries a curated strict subset beyond
typescript-eslint's `recommendedTypeChecked` defaults, proven at error level
in production (`no-unnecessary-condition`, `no-deprecated`,
`restrict-template-expressions`, …). Prettier remains a
separate gate (oxlint does not format); dependency-cruiser remains the
architecture/cycle engine (`import/no-cycle` stays off).

## Usage

```jsonc
// .oxlintrc.json (repo root)
{
	"extends": ["./node_modules/@alxwlw/oxlint-config/nest.jsonc"],
	"ignorePatterns": ["**/dist/**", "**/*.generated.*"],
}
```

```bash
oxlint --type-aware --report-unused-disable-directives --config .oxlintrc.json .
```

Packages that publish an API layer the `library` overlay after their preset (not
usable on its own — the `stack` plugin comes from the preset):

```jsonc
// .oxlintrc.json of the publishing package
{
	"extends": [
		"./node_modules/@alxwlw/oxlint-config/node.jsonc",
		"./node_modules/@alxwlw/oxlint-config/library.jsonc",
	],
}
```

Declare your own TSDoc tags in `tsdoc.json` instead of switching the rule off; the file needs the standard `"$schema": "https://developer.microsoft.com/json-schemas/tsdoc/v0/tsdoc.schema.json"` (without it tsdoc-config reports `Unsupported JSON "$schema" value`).
The overlay goes after the preset on purpose: it does not extend `base`, so it cannot
switch back on what `nest` or `react` turned off.

For browser code in a mixed repo, drop a nested `.oxlintrc.json` extending
`react.jsonc` into the frontend root — oxlint auto-discovers nested configs per
subtree (a nested config REPLACES the root one for that subtree, which is why
`react.jsonc` extends `base.jsonc` itself).

## Sharp edges (all empirically verified)

- **`--type-aware` is load-bearing.** Without the flag every `typescript/*`
  type-aware rule is SILENTLY skipped — no error, no warning. Keep the flag in
  the repo's lint task; `oxlint-tsgolint` must be installed (optional peer).
- **Build `.d.ts` before type-aware lint** in project-reference monorepos
  (`tsc --build` first; the canon moon-tasks `lint` has no typecheck dependency, so this applies to project-reference repos): unresolved imports produce `error`-typed values that
  fire the `no-unsafe-*` rules as phantoms.
- **Top-level `plugins` REPLACES the inherited set** — a consumer overriding
  `plugins` must restate the full list (see `react.jsonc` for the pattern).
- **Never run `--fix-suggestions` in automation**: tsgolint's `require-await`
  "suggestion" rewrites public signatures (`Promise<T>` → `T`). Plain `--fix`
  is safe; outside `nest` (which turns `consistent-type-imports` off), the
  `consistent-type-imports` × `import/no-duplicates` fixers can
  collide on one import pair — a second `--fix` pass converges.
- **Out-of-program files** (tests, tool config files, plain JS) are linted under an
  inferred strict program by tsgolint; `base.jsonc` mirrors tseslint's
  `disableTypeChecked` for the universal globs — extend that override in the
  consuming repo for repo-specific out-of-program trees (`scripts/`, `e2e/`,
  bundler-frontend subdirs). Tool config files are an explicit list
  (vite/vitest/playwright/…); production `src/**/*.config.ts` stays type-checked.
- **`import type` conversions can break NestJS DI**: `nest.jsonc` turns off
  `typescript/consistent-type-imports` — oxlint does not model
  `emitDecoratorMetadata`, and the rule's autofix used to convert the import of
  a class injected by ctor-param type into `import type` (Nest DI then fails at
  startup while tsc and lint stay green). A Nest consumer no longer needs its
  own override; an `import type` of an injected class in Nest code is an error
  only a startup catches. An explicit `@Inject(Class)` (this canon's
  convention) remains an optional way to make the dependency explicit.

## The `stack` JS plugin

`./plugin` exports the in-house rules (ESLint rule API, run by oxlint's
`jsPlugins` host — requires running oxlint via the npm CLI, which every moon
task does):

- `stack/require-nest-di-decorator` — ported from a private ESLint-rule
  original; see `NOTICE` for provenance. The two are no longer kept in
  lockstep and will drift.
- `stack/naming-convention` — port of the canon naming selector set; option
  `{ "leadingUnderscore": "none" | "allow" | "allowSingleOrDouble" }` for
  repos with a `_`-prefix private-by-convention marker.
- `stack/tsdoc-syntax` — enabled by the `library` overlay; reads the nearest
  `tsdoc.json` (like eslint-plugin-tsdoc). `@microsoft/tsdoc`-backed TSDoc validation
  (eslint-plugin-tsdoc ≥0.5 requires the `eslint` package at load time, which
  oxlint consumers no longer install).
