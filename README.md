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

Terms used here and in the code (profile, group, drift, exception, rollout, …) are defined in [`GLOSSARY.md`](./GLOSSARY.md).

## Who it's for

Repositories already on:

- **pnpm** workspaces with **moon** as the task runner
- **proto** for toolchain pinning (node/bun/pnpm/moon)
- **TypeScript 7**
- **oxlint** + **oxfmt** for lint/format (not eslint/prettier)

The CLI's sync/drift-check mechanism is generic, but the file contents this repo ships are opinionated
for that exact stack.

## Packages

Released in lockstep — all four always share one version number.

| Package                 | What it ships                                                                                                                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@alxwlw/stack`         | The `stack` CLI (`init`, `sync`, `check`) and the canon file/catalog sources it syncs                                                                                                          |
| `@alxwlw/oxlint-config` | oxlint presets — `base`, `node`, `nest`, `react`, `next`, plus the `library` overlay — plus an in-house `stack` JS plugin                                                                      |
| `@alxwlw/tsconfig`      | TypeScript 7 `tsconfig` presets — `base`, `node`, `library`, `react`, `refs`, `nest`, `bun`                                                                                                    |
| `@alxwlw/repo-rules`    | Whole-repo rules from the defect corpus — long files, unjustified suppressions, skipped tests, `Number(x) \|\| <default>`, removed assertions — with a shrink-only baseline; Node ≥ 20, no bun |

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

These four keys are the whole file. Any other top-level key, and any key of an exception other than `file`,
`catalog`, `name` and `reason`, is a configuration error: a typo such as `"wiht"` stops `check` and `sync`
with exit code `2` instead of silently switching the groups off.

`sync` seeds or updates every canon file that applies to the chosen profile and groups, and pins the
canon's dependency versions into `pnpm-workspace.yaml#catalogs`. Some files are synced **verbatim**
(canon owns the content forever, e.g. `.prototools`, `.oxfmtrc.jsonc`); others are **seeded once**
and then left alone (`create-if-absent`, e.g. `.gitleaks.toml`, `.oxlintrc.json` — the repo owns them
from that point on). Running `sync` again with nothing changed touches nothing (idempotent).
Anything held by an exception (see [Exceptions](#exceptions)) is left as it is: `sync` prints it
as `allowed (<reason>): …` and moves on, and `check` reports the same item as allowed — `sync`
never turns a held item into a stale exception. (`check`'s report-only rules — `engines.node`,
a Renovate config without the canon preset, a leftover Dependabot config, inline versions — are not something `sync` fixes.)

`sync` also rewrites **pin copies** — versions of node, bun, pnpm and proto repeated outside `.prototools`:

- in a Dockerfile (a file named `Dockerfile`, `Dockerfile.<suffix>` or `<name>.Dockerfile`, anywhere in the
  tree): the tag of a `node` or `oven/bun` image in `FROM`, and a `pnpm@<version>` literal;
- in the workflows and composite actions of the `.github` directory: the `proto-version`, `node-version` and
  `bun-version` inputs directly under a `with`.

A copy is compared at its own precision and keeps it, together with the tag suffix: with the pins `26.13.1` and
`1.4.4`, `node:26.11.1-alpine` becomes `node:26.13.1-alpine`, `node:24-slim` becomes `node:26-slim`, and
`oven/bun:1.4-alpine` is left alone. `check` reports one `toolchain-pin` finding per file, and `sync` rewrites
every copy in that file, leaving comments, quotes and line endings as they were. The copies follow the
`.prototools` the repo has after `sync`: the canon's pins, or the repo's own pins when an exception holds
`.prototools`. An exception whose `file` is the path of the Dockerfile or workflow (with a `reason`) holds its
finding, and `sync` then leaves that file alone.

Not a pin copy, and never touched: a tag without a version (`node:lts`) or built from a variable
(`node:${NODE_VERSION}`), an image pinned by digest, an image under a registry or another namespace, an image
named in `COPY --from`, a version range (`26.x`, `latest`), a list of versions or an expression (`${{ … }}`),
`node-version-file`, a matrix entry, and a Dockerfile in a hidden directory.

When `pnpm-workspace.yaml` sets `minimumReleaseAge` above zero, `sync` also keeps
`minimumReleaseAgeExclude` covering every Own package's version, including the packages that arrive
transitively as dependencies of `@alxwlw/stack`, so a rollout on the day of publication is not
rejected by `pnpm install`. A version counts as covered by a bare name,
`@alxwlw/*`, or `<name>@<v1> || <v2>` containing it; otherwise `sync` appends ` || <version>` to the
package's own entry, or adds `<name>@<version>` (creating the list if absent). Other entries,
their order and comments are left alone. A `catalog: dev` + `name` exception on the package holds this
too, for a transitive package as well.

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
each kind; the finding codes say which is which); `2` — a usage error (no `.stack.jsonc` yet, an unknown key or a malformed exception in it, an
unknown `--profile`, an unknown group in `with` (from `.stack.jsonc` or `--with`), a bad flag).
There is no `--help`: argument parsing is strict, and `stack init --profile <node|contracts|infra>`
is the only way to create the config file in the first place. Every command accepts
`--repo <path>` to target a repo other than the current directory. `stack check --base <ref>` hands
the ref to the `diff` part of the `repo-rules` group and has no effect without that group.

`stack sync-pr [--base <branch>] [--no-install]` is meant for the sync workflow (it commits the whole
tree and force-pushes) and does the whole consumer side of a release in one command: `stack sync`;
when the repo has a root `package.json`, a wait until every Own package (the `@alxwlw/*` entries of
the canon's `dev` catalog and the `@alxwlw/*` dependencies of `@alxwlw/stack`) is listed in the npm
registry and its tarball answers a HEAD with 200 (skipped with `--no-install`),
`proto install`, `pnpm install --no-frozen-lockfile` (skipped with `--no-install`) and the
`stack:post-sync` hook; with the `repo-rules` group — in a repo with no root `package.json` and with
`--no-install` too — it lowers the fixed entries of the repo-rules baseline; then the changed files one by one, a commit by the GitHub App's bot on
`stack/v<version>`, a force-push and a PR (or the open one, reused). After the PR it closes the open
sync-PRs of the bot for older versions on the same base, with a comment that links this version's PR, and
deletes their branches unless another open PR still uses one; when there is nothing to commit it closes them the same way, and the comment
says the canon is already on the base. The bot's git commands run
without the repository's git hooks (`core.hooksPath` points at `/dev/null`, so neither `.git/hooks` nor a hooks path set by husky or
lefthook runs); the consumer's CI on the PR checks the result. The version is the package's own;
`GH_TOKEN` and `STACK_APP_SLUG` come from the environment. Exit codes: `0` — PR opened or updated, or
nothing to commit; `1` — a step failed; `2` — a usage or configuration error.

`stack peers-baseline [--init | --allow-grow]` writes the baseline of the `peers` group (see
[Peer dependencies](#peer-dependencies)): `--init` records every current peer issue in a new file,
no flag only drops the entries the lockfile no longer has, `--allow-grow` also records new ones.
Exit codes: `0` — the file is written; `1` — `pnpm peers check` could not answer (no
`pnpm-lock.yaml`, pnpm missing or failing), or there are new entries and no `--allow-grow`; `2` — a
usage or configuration error (the `peers` group is off, the file is missing, already there with
`--init`, or does not parse — it is never overwritten then).

`stack repo-rules <arguments>` runs the repo-rules of this `@alxwlw/stack` version: everything after
`repo-rules` goes to it unchanged, so a repo does not declare `@alxwlw/repo-rules` in its manifests to
use it. The rules are the same version as `@alxwlw/stack`, even when the repo has an older copy of its
own. `repo-rules` has to be the first argument; the directory is set by its own `-C <dir>`, and the
`--repo` flag of stack does not apply to it. Examples: `stack repo-rules baseline --init`,
`stack repo-rules baseline --allow-grow`. Exit codes are those of repo-rules: `0`, `1`, `2`.

## Profiles and groups

`profile` (required, set once by `init`) picks which canon files apply at all. `with` is a list of
opt-in groups layered on top — extra files, extra catalog entries, or an extra check of `stack check`
(`peers`, `repo-rules`), that not every repo on a profile needs.

| Profile     | For                                                                                                                                                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node`      | A TypeScript/Node service or library — the full canon: oxlint, oxfmt, tsconfig, moon tasks, Renovate (see [Dependency updates](#dependency-updates)).                                                                                                                           |
| `contracts` | A Hardhat/Solidity repo with a TypeScript test/deploy layer — same JS/TS canon as `node`.                                                                                                                                                                                       |
| `infra`     | A repo with no pnpm workspace/TS toolchain — canon reduces to what's stack-agnostic (editorconfig, gitleaks, yamllint, markdownlint, `.prototools`, one moon task, its own `stack-check` workflow, Renovate). Catalog checks are skipped when there's no `pnpm-workspace.yaml`. |

| Group        | Adds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Profiles                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `libs`       | Catalog pins for common application libraries (a NestJS/Prisma/React-ish stack) — grows over time                                                                                                                                                                                                                                                                                                                                                                                                 | any                          |
| `moon-tasks` | Syncs `.moon/tasks/{typescript,oxlint,oxfmt,bun-test}.yml` **verbatim** — Bun-run `typecheck` (`tsc --noEmit`), `lint`, `format`, `test` — for `node`/`contracts`; seeds `stack.yml` (repo-owned) for every profile, the only file `infra` gets. `typecheck` is `--noEmit` and does not build project `references` (refs/nest presets) — override it with `tsc --build`; override a task's args in a project's `moon.yml` with `mergeArgs: 'replace'`; skip the group if you hand-roll moon tasks | `node`, `contracts`, `infra` |
| `knip`       | Syncs `knip.base.json` **verbatim** — the canon's base for unused-code detection; build your own knip config on top of it                                                                                                                                                                                                                                                                                                                                                                         | `node`                       |
| `depcruise`  | Syncs `.dependency-cruiser.base.cjs` **verbatim** — import/architecture boundary rules; your own `.dependency-cruiser.cjs` pulls them in with `extends`                                                                                                                                                                                                                                                                                                                                           | `node`, `contracts`          |
| `peers`      | Adds the `pnpm peers check` gate to `stack check`, against a committed baseline (see [Peer dependencies](#peer-dependencies)); needs `pnpm-lock.yaml`                                                                                                                                                                                                                                                                                                                                             | `node`, `contracts`          |
| `repo-rules` | Adds the rules of `@alxwlw/repo-rules` to `stack check`, at the version of `@alxwlw/stack` and against the repo's own repo-rules baseline (see [Repo rules](#repo-rules)); needs a git repository                                                                                                                                                                                                                                                                                                 | any                          |
| `renovate`   | Deprecated, does nothing: Renovate is the canon's dependency bot for every profile. Still accepted so older `.stack.jsonc` files parse                                                                                                                                                                                                                                                                                                                                                            | —                            |

```bash
npx stack init --profile node --with libs --with moon-tasks
```

The `stack.yml` seed defines one `stack-check` task that every moon project inherits. It runs from the
workspace root, where `.stack.jsonc` lives: `pnpm exec stack check`, or `bunx @alxwlw/stack check` on `infra`
(no `package.json` there). `moon run <project>:stack-check` checks the repo once; `moon run :stack-check`
repeats the same check for every project.

## Dependency updates

Renovate is the canon's only dependency bot; Dependabot is no longer seeded. `stack sync` brings two
files:

- `.github/workflows/renovate.yml` (canon, overwritten) runs Renovate every Monday at 06:00 UTC and on
  demand (`workflow_dispatch`, with a `debug` log level when a run needs explaining). It calls the
  reusable `alxwlw/stack/.github/workflows/renovate.yml@v1` and needs a `RENOVATE_TOKEN` secret
  that can push branches and open PRs (contents, pull requests, issues, workflows: write). The job
  runs on `vars.RUNNER_LABEL`, or `ubuntu-latest` when the variable isn't set.
- `renovate.json5` (seeded once, yours to edit) extends `config:recommended` and the canon preset
  `github>alxwlw/stack//renovate/canon.json5#v1`. It isn't seeded when the repo already has a
  Renovate config under any name Renovate looks for (`renovate.json`, `.github/renovate.json5`, …).

The preset turns Renovate off for everything `stack sync` moves: `@alxwlw/*` packages and
`alxwlw/stack/...` workflow/action refs, the canon's catalogs (`dev`, and `libs` for repos with that
group), `packageManager`, `engines` and the `.prototools` pins. Without it the bot and the rollout
would fight: Renovate bumps a pin, the next `stack sync` reverts it. The preset is read from the
floating `v1` tag, so a release updates it everywhere without a PR: the update arrives once the release moves
the `v1` tag, and until then `#v1` and `@v1` still point at the previous release.

`stack check` fails when the Renovate config (the first one found, in Renovate's own lookup order)
doesn't extend the preset with exactly the `#v1` tag — no tag or `#main` would pull an unreleased
canon — and when `.github/dependabot.yml` (or `.yaml`) exists. Neither can be held back by an exception.

`stack check` also reports a `version` set in moon's toolchain config (in the `.moon` directory) for any tool the canon pins (`node: { version: … }`),
even when it equals the `.prototools` pin: `.prototools` owns the version, so leave it unset (`node: {}`). `stack sync` does
not fix it; an exception whose `file` is the path before the colon in the finding's target (with a `reason`) holds it.

`stack check` also fails when moon's YAML workspace config (a workspace file with the extension yml or yaml in the `.moon` directory; the
first one found is the config) has no `vcs.defaultBranch`, or an empty one. Other formats moon accepts (json, jsonc, toml, pkl,
hcl) are not checked. Without the setting moon takes `master` as the base: a PR check passes because moon gets the base from the
PR event, and then CI on the push to `main` dies with `fatal: ambiguous argument 'master'`. `stack sync` writes `main` — the
branch the canon's `stack` workflow runs on — when the value is missing, empty or not a string, and leaves any other non-empty
string alone. It never creates the file: the list of projects is the repo's own. A `vcs` that is not a map is only reported.
An exception whose `file` is the path of the config found (with a `reason`) holds it.

Upgrading an existing consumer: on the first `stack/v<version>` PR after the move to Renovate, `check` goes red
on `renovate-preset` if the repo already has its own Renovate config without the preset (add
`github>alxwlw/stack//renovate/canon.json5#v1` to its `extends`), and on `dependabot-config` if
`.github/dependabot.yml` (or `.yaml`) exists (move its rules into the Renovate config and delete the file).

Upgrading to the release that checks pin copies: the first `stack/v<version>` PR rewrites the Dockerfiles and
workflows whose copies lag behind `.prototools`. The rewrite can change a major inside an image (node, or the
pnpm it installs), and the tag of a freshly pinned version may not be in the image registry yet. CI that does not
build the image on a pull request shows neither, so build the image from the PR branch before merging it — or
hold the file back with an exception (`{ "file": "<path>", "reason": "…" }`) added in that same PR.

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
canon's node pin doesn't satisfy, a Renovate config whose `extends` lacks
`github>alxwlw/stack//renovate/canon.json5#v1` (or no Renovate config at all), and a
`.github/dependabot.yml` (or `.yaml`) — these always block; there's no exception shape for any of them. `check` prints every exception it actually
suppressed as a warning, and fails on one that no longer suppresses anything — the canon moved on
and the exception is now stale, so it gets deleted, not carried forward silently. The findings of
the `peers` group have no exception shape either: their baseline is the record of what the repo
accepts (see [Peer dependencies](#peer-dependencies)); the same goes for the `repo-rules` group,
whose accepted places are recorded in the repo-rules baseline (see [Repo rules](#repo-rules)).

## Peer dependencies

A peer dependency that a repo does not declare itself is resolved by pnpm from whatever the
lockfile happens to hold. When a lockfile refresh moves that peer to another major, nothing says
so: `pnpm install --frozen-lockfile` stays quiet, and every version the diff shows can look fine.
`pnpm peers check` sees it. The opt-in `peers` group makes it a gate of `stack check`, measured
against a baseline of the issues the repo already has:

```bash
# .stack.jsonc: "with": ["peers"]
npx stack peers-baseline --init   # once: record what is already there
git add .stack-peers-baseline.json
```

`check` runs `pnpm peers check --lockfile-only --json` in the repo root. It reads the lockfile
alone, with no install, so `pnpm-lock.yaml` must exist. Three findings come out of it:

| Code                  | When                                                                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `peer-dependency`     | an unmet, missing or conflicting peer that the baseline does not record                                                                       |
| `stale-peer-baseline` | a baseline entry that pnpm no longer reports — drop it, or the same issue could come back unnoticed                                           |
| `peers-unavailable`   | no `pnpm-lock.yaml`, or pnpm gave no usable answer (not installed, failed, printed something other than its JSON report); never read as clean |

None of them can be held by an exception. To turn the gate off, drop `peers` from `with`.

An entry is keyed by the importer (the workspace package), the peer, the kind (`unmet`, `missing`
or `conflict`), the package that declares the peer, and, for `unmet`, the line of the version
found: the major, `0.minor` below 1.0, `0.0.patch` below 0.1, with pre-release and build tags
dropped. A patch or minor bump on either side keeps the key, so a routine lockfile refresh adds no
noise; a peer that moves to another major gets a new key and fails the check.

`stack peers-baseline` with no flag only drops fixed entries. It refuses to record new ones (exit
`1`, listing them) unless `--allow-grow` is passed, so accepting a new issue is a visible change of
the baseline in the PR diff. Sync-PRs drop fixed entries on their own: after the install,
`stack sync-pr` removes from the baseline what the new lockfile fixed and commits it with the rest
of the canon; new entries stay findings for the PR's CI.

## Repo rules

The opt-in `repo-rules` group makes `stack check` run the `check` and `diff` commands of
`@alxwlw/repo-rules` in process and turn their result into findings. The rules are those of this
`@alxwlw/stack` version, so the package does not have to be in the repo's manifests, and an older copy
of repo-rules that the repo declares itself is not used by the group. Without the group nothing
changes: repo-rules is not called.

```bash
# .stack.jsonc: "with": ["repo-rules"]
npx stack repo-rules baseline --init   # once: record what is already there
git add <the file it wrote>
```

The file it writes is the repo-rules baseline file, described in
[`packages/repo-rules/README.md`](packages/repo-rules/README.md). Without it every violation of the
current rules is a finding. Three findings come out of the group:

| Code                        | When                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `repo-rules-violation`      | a place breaks a rule and the baseline does not cover it                                                                                         |
| `stale-repo-rules-baseline` | a baseline entry is higher than reality; lower it with `stack repo-rules baseline`                                                               |
| `repo-rules-unavailable`    | a call did not run or its answer cannot be read (a baseline that does not parse, a directory outside git, no merge-base); never read as no drift |

None of them can be held by an exception. To turn the gate off, drop `repo-rules` from `with`.

The `diff` part compares the branch with a base: `--base <ref>` names it. In GitHub Actions on a
`pull_request` or `pull_request_target` the base is `origin/$GITHUB_BASE_REF`. On other events, and locally
without `--base`, the part is skipped with a note on stderr; a note never changes the exit code. The
`history` step of `check.yml` runs on `pull_request` only. A commit trailer
`Tests-Removed: <reason>` in the range accepts a removal of assertions.

The group checks the whole git repository that holds the `--repo` directory, and the paths in findings
are relative to the git root. For the rules themselves see
[`packages/repo-rules/README.md`](packages/repo-rules/README.md).

In a pull request job the reusable `check.yml` fetches the history this part needs; see
[History for the repo-rules `diff`](#history-for-the-repo-rules-diff).

A repo that already wires repo-rules by hand keeps the same baseline file. The rules of the new version
may find more: `stack repo-rules baseline --allow-grow` records the growth, and it shows in the PR diff.

Sync-PRs lower fixed entries on their own: right before its commit, `stack sync-pr` runs
`repo-rules baseline --drop-fixed` in process, so an entry that the new rules or the rewritten canon files no
longer need leaves the baseline in the same commit. An entry that grew and a new violation are not recorded:
they stay findings for the PR's CI. The step needs neither the install nor a root `package.json`. When it
fails (a baseline file that does not parse, for one), `stack sync-pr` prints one line on stderr and goes on;
`stack check` on the PR then reports `repo-rules-unavailable`.

## CI

`alxwlw/stack/.github/actions/setup@v1` installs the toolchain pinned in `.prototools` (via
`moonrepo/setup-toolchain`) and runs `pnpm install --frozen-lockfile` unless `install: false`.

For a private npm registry, pass its host and, optionally, the **name** of the job's env var that
holds the token. The action writes a reference (`${NODE_AUTH_TOKEN}`), never the value, to a user-level
npmrc of the job — pnpm >= 11.15 ignores env-var credentials in a committed project `.npmrc`. That file
lives in the runner's temp directory and the later steps of the job find it through `NPM_CONFIG_USERCONFIG`:
it holds the previous user-level config (`~/.npmrc`) minus the auth lines of this registry, plus this job's
line. The shared `~/.npmrc` is never written: on a self-hosted runner it outlives the job, and a line for the
same registry from another job would win, since pnpm takes the last line of a key. pnpm, npm and bun read
the job's file instead of `~/.npmrc`, so a later step that adds npm config writes it to the file that
`NPM_CONFIG_USERCONFIG` names, not to `~/.npmrc`.

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

`registry-token-var` may be left out — with `registry` set, the action points the job's npmrc at the env
var `STACK_REGISTRY_TOKEN` (pnpm reads it), so the job only declares that variable; `registry-token-var` without
`registry` fails the step.

The project `.npmrc` must still map the scope to the registry (e.g.
`@acme:registry=https://npm.pkg.github.com`); the action only adds the auth line.

The reusable workflows `check.yml`, `sync.yml` and `renovate.yml` pass this through: each takes an
optional `registry` input (host without scheme, default empty) and an optional `registry-token`
secret. With `registry` empty they behave as before and no npmrc is written. The canon files
synced into a consumer wire them to the repository variable `STACK_REGISTRY` and the secret
`STACK_REGISTRY_TOKEN`, so a repo opts in by setting those two (for `acme/app`: variable
`STACK_REGISTRY=npm.pkg.github.com`, secret `STACK_REGISTRY_TOKEN`). `check.yml` and `sync.yml` call
the action with `registry` only and set `STACK_REGISTRY_TOKEN` in the job env from the
`registry-token` secret. `renovate.yml` also gives Renovate an npm host rule for that host and token.

The action also exports `ACTIONLINT_BIN` / `SHELLCHECK_BIN` — the real binaries behind the proto
shims, which race each other when run in parallel — only for those two tools, and only when the
repository-root `.prototools` pins them.

### History for the repo-rules `diff`

With the `repo-rules` group in `.stack.jsonc`, the reusable `check.yml` fetches the history of the base
branch itself in a `pull_request` job (`git fetch --filter=blob:none --unshallow`): commits and trees at
once, file contents on demand. The step needs the credentials that `actions/checkout` leaves in place by
default, for the fetch and for the later on-demand downloads. Without the group, and on other events, the
checkout stays as it was and nothing is fetched. If the base branch cannot be fetched, the job fails at
that step. A workflow that calls `stack check` itself, without `check.yml`, provides the history itself:
`fetch-depth: 0`, or `--base <ref>` naming a ref that exists in the clone.

### Secret scanning

The reusable `alxwlw/stack/.github/workflows/check.yml@v1` accepts `gitleaks: true`: it scans the whole
history (`fetch-depth: 0`) with the config chain `.gitleaks.toml` (seeded by `stack sync`) → `.gitleaks.canon.toml` → gitleaks'
default. It is off by default: a history that was never cleaned would turn the check red on the day of
the bump.

The canon `stack-check` workflow file is synced verbatim, so any other `with:` entry in it is drift.
Enable the input from your own workflow that calls `check.yml`, or run a separate job: `actions/checkout`
with `fetch-depth: 0` → `alxwlw/stack/.github/actions/setup@v1` with `install: false` →
`gitleaks git --redact --no-banner .`.

## Releases

All four packages share one semver version, tagged `vX.Y.Z`. Publishing runs through npm's trusted
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

Step by step: [docs/release.md](docs/release.md).

### Keeping the canon current

Renovate runs on this repo too (`.github/workflows/renovate-self.yml`, Mondays 06:00 UTC, needs a
`RENOVATE_TOKEN` secret). Unlike a consumer it does not extend the canon preset — moving the
canon's pins is its job. One version lives in several places here: the canon
(`packages/stack/canon/files/prototools`, `canon/catalogs.json`) and this repo's own toolchain
(`.prototools`, `pnpm-workspace.yaml`, `package.json#packageManager`). Renovate moves each
dependency in both places at once, because the dogfood tests fail when the root and the canon
disagree:
minor and patch bumps land in the `canon pins` PR, major bumps in their own `major-canon-pins` PR.
Merge them one at a time; Renovate rebases the other on its next run or on a manual
`workflow_dispatch`. Merging changes nothing for consumers until a release: tag it, and the rollout
below carries the new pins out.

### Rollout to consumers

A release pushes itself out. When `publish` succeeds, the canon dispatches `stack-sync.yml` in every
repository on its consumer list; that workflow runs `stack sync-pr` for the new version
(`bunx @alxwlw/stack@<version> sync-pr`) and, if anything changed, opens a PR on branch
`stack/v<version>`. Re-dispatching the same version force-updates that
branch and reuses the open PR instead of opening a second one. After a rollout the consumer is left with at most one sync-PR on its base,
and re-dispatching an old version does not close the PR of a newer one.

`sync.yml` keeps only the App token, the checkout, the setup action and a short wait until
`@alxwlw/stack@<version>` and every Own package among its dependencies (which `bunx` installs) are
listed in the npm registry and their tarballs answer a HEAD with 200; everything after that is
`stack sync-pr`. It needs a version that has the command, 1.11.0 or later: re-dispatching an older
version fails with a usage error (exit code 2).

The work is done by the [`alxwlw-stack-bot`](https://github.com/apps/alxwlw-stack-bot) GitHub App,
which a consumer installs on its own repositories. It asks for exactly what opening that PR and closing the ones it replaces takes —
**actions**, **contents**, **pull requests**, **workflows** (write) and metadata (read) — and nothing
else. Tokens are minted per installation and expire within the hour, so the canon never holds a
long-lived credential for a consumer.

A repository joins the list after its first sync lands: the dispatch target
(`.github/workflows/stack-sync.yml`) is itself a canon file, so the first adoption is a PR you open
yourself with `stack init` and `stack sync`.

The consumer list is the `STACK_CONSUMERS` secret of this repository (`owner/repo`, one per line).
A consumer tunes its sync with one repository variable: `STACK_SYNC_BASE` opens the PR against that
branch instead of the default one (for a repo whose default branch only takes merges from another).
`STACK_SYNC_INSTALL` is no longer read: the repository decides itself — a root `package.json` means the
registry wait, `proto install` and `pnpm install`. A consumer's copy of that workflow made before 1.12.0 still passes
the variable as the `install` input on its first sync (`false` becomes `--no-install`), and that sync PR
replaces the copy.

A consumer can add a repo-owned finishing step: a `stack:post-sync` script in the root
`package.json`. A repo with a `package.json` gets, in this order, `proto install` (the pins the sync
just raised must be installed first), `pnpm install` (unless `--no-install`) and then
`pnpm run stack:post-sync` if the script exists, so regenerated files land in the same sync PR. Only
after the hook does the command look for changed files. The script gets `VERSION` (the stack version,
without `v`) in its environment. The hook runs with or without `--no-install`, so it decides itself
whether it needs dependencies. A failing `proto install`, install or hook, or an unreadable
`package.json`, fails the job: no commit and no PR, rather than a PR without the finishing. Without
the script the command only runs `proto install` and the install; without a `package.json` it does
nothing of that.

## License

MIT — see each package's own `LICENSE`. `@alxwlw/oxlint-config` additionally ships a `NOTICE` for one
rule ported from a private original that is no longer kept in lockstep with it.
