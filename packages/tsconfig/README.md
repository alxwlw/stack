# @alxwlw/tsconfig

TypeScript 7 `tsconfig` presets for the canon. Each preset is a plain `.json` file — extend it by
package specifier (published consumers) or by path (this repo, which extends its own presets
directly from `packages/tsconfig/`).

## Presets

| Preset         | Extends | Use it for                                                                                                                                                                                                                    |
| -------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `base.json`    | —       | Never extended directly by an app. Strict TS7 defaults every other preset builds on: `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `declaration`.                                                             |
| `node.json`    | `base`  | A Node-targeted package or script. Adds `lib: ["ES2023"]` and `types: ["node"]`.                                                                                                                                              |
| `library.json` | `base`  | A package that ships compiled output for others to import. `emitDeclarationOnly` — types out, no `.js` (a bundler/`tsc -p` elsewhere produces the runtime file).                                                              |
| `react.json`   | `base`  | Browser/React code. `lib: ["ES2023", "DOM", "DOM.Iterable"]`, `jsx: "react-jsx"`, bundler resolution.                                                                                                                         |
| `refs.json`    | `node`  | A pnpm+moon **project-references** monorepo package: `composite`, `incremental`, emits only `.d.ts` into `.tsbuild/` — runtime JS comes from Bun/SWC/a bundler, not `tsc`.                                                    |
| `nest.json`    | `refs`  | A NestJS package on `refs.json`'s project-references discipline: legacy decorators + `emitDecoratorMetadata`, and `verbatimModuleSyntax: false` (DI needs the type import to survive erasure — see the preset's own comment). |
| `bun.json`     | `base`  | A Bun-native script or CLI (this repo's own `packages/stack` uses it): bundler resolution, `types: ["bun"]`, `noEmit`, `allowImportingTsExtensions`.                                                                          |

## Usage

```jsonc
// tsconfig.json (repo root, or a package's own tsconfig)
{
	"extends": "@alxwlw/tsconfig/node.json",
}
```

None of these presets declare `@types/node` or `@types/bun` as a dependency of this package — **you
install the one(s) your `types` array needs yourself.** `node.json`/`refs.json`/`nest.json` expect
`@types/node` in your own `devDependencies`; `bun.json` (and any project whose tests use `bun:test`)
expects `@types/bun`. This package's own `devDependencies` on both are for running ITS tests
(`presets.test.ts` compiles a fixture per preset) — they are not re-exported to consumers, and pnpm's
strict linking will not hand them to you for free.

## Sharp edge: `.ts`-extension imports and `bun:test` need more than `node.json`

If your source imports with an explicit `.ts` extension (`import { x } from './x.ts'` — required for
Bun/`nodenext` ESM to resolve at runtime without a build step) or your tests use `bun:test`, extending
`node.json` alone is **not enough** and will fail loudly:

```
error TS5097: An import path can only end with '.ts' when 'allowImportingTsExtensions' is enabled.
```

`allowImportingTsExtensions` requires `noEmit` (or `emitDeclarationOnly`) to be set — `node.json`
doesn't set either, because a plain Node package normally compiles its `.ts` to `.js` and does not
import by `.ts` extension. If your package is Bun-run and never emits, override on top:

```jsonc
{
	"extends": "@alxwlw/tsconfig/node.json",
	"compilerOptions": {
		"allowImportingTsExtensions": true,
		"noEmit": true,
		"types": ["node", "bun"],
	},
}
```

(This is exactly what this repo's own root `tsconfig.options.json` does — `bun.json` alone doesn't
fit either, since it drops `types: ["node"]`, which `node:*` built-in imports still need.) If you're
building a plain Bun CLI/script with no Node-specific typings, `bun.json` on its own is the simpler
fit — reach for the override above only when you need both surfaces at once.
