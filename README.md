# stack

Toolchain canon for a family of repositories: one source of truth for lint/format config,
`tsconfig` presets, CI workflows, moon task definitions and pinned dependency versions, kept in
sync by a small CLI instead of copy-pasted by hand.

## What it is

`stack` is three things:

- a **CLI** (`stack init | sync | check`) that seeds a repo with the canon's files, keeps them in
  sync, and fails CI the moment a repo's copy drifts from the canon;
- a **file canon**: `.editorconfig`, `.gitleaks.canon.toml`, `.yamllint`, `.markdownlint-cli2.jsonc`,
  `.prototools` (+ vendored `proto` plugins), `.oxfmtrc.jsonc`, `.oxlintrc.json`, `tsconfig.options.json`,
  GitHub Actions workflows and `moon` task files, chosen per repo **profile**;
- a **dependency catalog**: pinned versions for the shared toolchain (TypeScript, oxlint, oxfmt, …)
  and, opt-in, for common application libraries, synced into a pnpm workspace's
  `pnpm-workspace.yaml#catalogs`.

A repo adopts the canon once, drifts away from it never (or gets caught doing so in CI).

## Who it's for

Repositories already on:

- **pnpm** workspaces with **moon** as the task runner
- **proto** for toolchain pinning (node/bun/pnpm/moon)
- **TypeScript 7**
- **oxlint** + **oxfmt** for lint/format (not eslint/prettier)

The CLI's sync/drift-check mechanism is generic, but the file contents this repo ships are opinionated
for that exact stack.

## Packages

Released in lockstep — all three always share one version number.

| Package                 | What it ships                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| `@alxwlw/stack`         | The `stack` CLI (`init`, `sync`, `check`) and the canon file/catalog sources it syncs         |
| `@alxwlw/oxlint-config` | oxlint presets — `base`, `node`, `nest`, `react`, `next` — plus an in-house `stack` JS plugin |
| `@alxwlw/tsconfig`      | TypeScript 7 `tsconfig` presets — `base`, `node`, `library`, `react`, `refs`, `nest`, `bun`   |

`@alxwlw/oxlint-config` and `@alxwlw/tsconfig` also work standalone — see each package's own README.
`@alxwlw/stack` is what wires all of it into a repo and keeps it there.

## Quick start

```bash
pnpm add -D @alxwlw/stack
npx stack init --profile node
npx stack sync
```

The CLI requires **bun** on `PATH` (its shebang is `#!/usr/bin/env bun` and it uses Bun-only APIs)
— with only `node` available, `npx stack …` fails with a shell-level "command not found" instead of
a helpful message.

`init` writes `.stack.jsonc` at the repo root (it refuses to run if one already exists):

```jsonc
{
	"$schema": "./node_modules/@alxwlw/stack/schema.json",
	"profile": "node",
	"with": [],
	"exceptions": [],
}
```

`sync` seeds or updates every canon file that applies to the chosen profile and groups, and pins the
canon's dependency versions into `pnpm-workspace.yaml#catalogs`. Some files are synced **verbatim**
(canon owns the content forever, e.g. `.prototools`, `.oxfmtrc.jsonc`); others are **seeded once**
and then left alone (`create-if-absent`, e.g. `.gitleaks.toml`, `.oxlintrc.json` — the repo owns them
from that point on). Running `sync` again with nothing changed touches nothing (idempotent).
Anything held by an exception (see [Exceptions](#exceptions)) is left as it is: `sync` prints it
as `allowed (<reason>): …` and moves on, and `check` reports the same item as allowed — `sync`
never turns a held item into a stale exception. (`check`'s report-only rules — `engines.node`,
the dependabot ignore, inline versions — are not something `sync` fixes.)

`sync` also keeps `package.json#packageManager` on the canon's pnpm pin whenever that field names
pnpm (a `+sha512…` suffix on the same version is fine) — otherwise pnpm switches itself to the
version in the field and the `.prototools` pin silently stops applying. An exception on
`.prototools` holds this field back too.

Wire `check` into CI to fail the build on drift instead of finding out later:

```bash
npx stack check
```

`check` never writes anything. Exit codes: `0` — nothing has drifted; `1` — it found something:
drift that `stack sync` fixes, or a report-only finding to fix by hand (the hint under the list counts
each kind; the finding codes say which is which); `2` — a usage error (no `.stack.jsonc` yet, an
unknown `--profile`, a bad flag).
There is no `--help`: argument parsing is strict, and `stack init --profile <node|contracts|infra>`
is the only way to create the config file in the first place. All three commands accept
`--repo <path>` to target a repo other than the current directory.

## Profiles and groups

`profile` (required, set once by `init`) picks which canon files apply at all. `with` is a list of
opt-in groups layered on top — extra files, or extra catalog entries, that not every repo on a
profile needs.

| Profile     | For                                                                                                                                                                                                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node`      | A TypeScript/Node service or library — the full canon: oxlint, oxfmt, tsconfig, moon tasks, a dependency-bot config (dependabot, or renovate via the group).                                                                                                          |
| `contracts` | A Hardhat/Solidity repo with a TypeScript test/deploy layer — same JS/TS canon as `node`.                                                                                                                                                                             |
| `infra`     | A repo with no pnpm workspace/TS toolchain — canon reduces to what's stack-agnostic (editorconfig, gitleaks, yamllint, markdownlint, `.prototools`, one moon task, its own `stack-check` workflow). Catalog checks are skipped when there's no `pnpm-workspace.yaml`. |

| Group        | Adds                                                                                                                                                                                  | Profiles                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `libs`       | Catalog pins for common application libraries (a NestJS/Prisma/React-ish stack) — grows over time                                                                                     | any                          |
| `moon-tasks` | Seeds `.moon/tasks/*.yml` — typescript/oxlint/oxfmt/bun-test/stack for `node`/`contracts`, `stack` only for `infra` (skip it if you hand-roll moon tasks)                             | `node`, `contracts`, `infra` |
| `knip`       | Seeds `knip.base.json` (unused-code detection base config)                                                                                                                            | `node`                       |
| `depcruise`  | Seeds `.dependency-cruiser.base.cjs` (import/architecture boundary rules)                                                                                                             | `node`, `contracts`          |
| `renovate`   | The repo runs Renovate instead of Dependabot: `.github/dependabot.yml` is not seeded, and `check` requires the Renovate config to disable `@alxwlw/*` (see [Exceptions](#exceptions)) | `node`, `contracts`          |

```bash
npx stack init --profile node --with libs --with moon-tasks
```

## Exceptions

A drifted or missing canon **file**, or a catalog entry that's missing or off-version, can be held
back by an exception in `.stack.jsonc` — one exception per file or per catalog entry, `reason`
required on both shapes. A held item is suppressed in `check` and left untouched by `sync`:

```jsonc
{
	"exceptions": [
		{ "file": ".oxlintrc.json", "reason": "not yet migrated off a repo-local override" },
		{
			"catalog": "libs",
			"name": "react",
			"reason": "migrating off React 18, tracked in acme/app#123",
		},
	],
}
```

A `catalog`+`name` exception also covers that package declared with an inline version instead of
`catalog:` in any `package.json`: a package held back from the canon is declared directly, and one
reason covers both symptoms of the same decision.

Not every `check` finding is suppressible this way: a `package.json#engines.node` range that the
canon's node pin doesn't satisfy, and a missing `@alxwlw/*` ignore in `.github/dependabot.yml`,
always block — there's no exception shape for either. `check` prints every exception it actually
suppressed as a warning, and fails on one that no longer suppresses anything — the canon moved on
and the exception is now stale, so it gets deleted, not carried forward silently.

## CI

`alxwlw/stack/.github/actions/setup@v1` installs the toolchain pinned in `.prototools` (via
`moonrepo/setup-toolchain`) and runs `pnpm install --frozen-lockfile` unless `install: false`.

For a private npm registry, pass its host and the **name** of the job's env var that holds the
token. The action writes a reference (`${NODE_AUTH_TOKEN}`), never the value, to the user-level
`~/.npmrc` — pnpm >= 11.15 ignores env-var credentials in a committed project `.npmrc`:

```yaml
jobs:
  ci:
    runs-on: ubuntu-latest
    env:
      NODE_AUTH_TOKEN: ${{ secrets.NPM_READ_TOKEN }}
    steps:
      - uses: actions/checkout@v5
      - uses: alxwlw/stack/.github/actions/setup@v1
        with:
          registry: npm.pkg.github.com
          registry-token-var: NODE_AUTH_TOKEN
```

The project `.npmrc` must still map the scope to the registry (e.g.
`@acme:registry=https://npm.pkg.github.com`); the action only adds the auth line.

The action also exports `ACTIONLINT_BIN` / `SHELLCHECK_BIN` — the real binaries behind the proto
shims, which race each other when run in parallel — only for those two tools, and only when the
repository-root `.prototools` pins them.

## Releases

All three packages share one semver version, tagged `vX.Y.Z`. Publishing runs through npm's trusted
publishing (OIDC from GitHub Actions — no long-lived npm token in CI), and a floating `v1` tag tracks
the latest `v1.x.y` for consumers pinning a major:

```jsonc
// package.json
{
	"devDependencies": {
		"@alxwlw/stack": "^1.0.0",
	},
}
```

## License

MIT — see each package's own `LICENSE`. `@alxwlw/oxlint-config` additionally ships a `NOTICE` for one
rule ported from a private original that is no longer kept in lockstep with it.
