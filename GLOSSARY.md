# Stack canon

The vocabulary of the toolchain canon and its `stack` CLI: what a repo adopts, what drifts, and how the canon travels out to repos.

## Language

### Canon and consumers

**Canon**:
The one shared set of toolchain files and pinned dependency versions, shipped inside `@alxwlw/stack`. Loaded per repo as a value by `loadCanon` (`packages/stack/src/canon.ts`: `readCanonSource` reads `canon/` once, `canonFor` is the pure step of profile and `with` selection, group check and pins); its sources are `packages/stack/canon/`.
_Avoid_: template, boilerplate, preset

**Consumer**:
A repository that adopts the canon and is kept in line with it by `stack sync` and `stack check` (for example `acme/app`). It states how in its `.stack.jsonc` (`readStackConfig`, `packages/stack/src/config.ts`). Loaded once per command as a value by `loadRepo` (`packages/stack/src/repo.ts`): the content of the files it could read, and which paths exist. An unreadable or unparsable `package.json` (root or nested), `pnpm-workspace.yaml`, Renovate config, moon's toolchain or workspace config, or **Peer baseline** becomes exactly one `unreadable-file` finding; the rules are pure functions of that value and the canon. The shape of that file is declared once, by `CONFIG_KEYS`, `PROFILES`, `EXCEPTION_SHAPES` and the canon's group names (`knownGroups`): `readStackConfig` rejects any other key or shape, `canonFor` rejects an unknown group, and `packages/stack/schema.json` must equal what `stackConfigSchema` builds from them.
_Avoid_: client, downstream, target repo

**Profile**:
The kind of repository a consumer declares, `node`, `contracts` or `infra`; it decides which canon files apply. `PROFILES` in `packages/stack/src/config.ts`, `appliesTo` in `canon/manifest.json`.
_Avoid_: preset, flavour, template

**Group**:
A named opt-in slice of the canon, switched on through `with` in `.stack.jsonc`. There are four kinds: a **file group** (the `group` field of a manifest entry), a **catalog group** (a key of `canon/catalogs.json` other than `dev`, which every consumer gets), a **rule group** (switches on a rule of `stack check` rather than a file or a catalog: `RULE_GROUPS`, enabled ones in `Canon.rules`; there are two: `peers` and `repo-rules`) and a **deprecated group** (accepted for old configs, enables nothing). Names come from `readCanonSource().groups` in `packages/stack/src/canon.ts`; `knownGroups` lists all four kinds.
_Avoid_: feature, module, flag

### What the canon holds

**Canon file**:
A file the canon places at a path (`dest`) in a consumer, listed in `canon/manifest.json` and stored under `canon/files/`. Its strategy is either **verbatim** (the consumer's copy must equal the canon's byte for byte) or **seed** (`create-if-absent`: written once, then owned by the consumer, and only its absence is drift; not the seed of a **Fixture**, which holds no canon file). A seed may name `satisfiedBy` paths, other legitimate names that already close the seeding. The manifest is checked where it is read (`readCanonSource`): a profile outside `PROFILES`, a strategy outside `SYNC_STRATEGIES`, `satisfiedBy` on a verbatim file, an unknown key of an entry, or a `dest` listed twice for one profile is an error of the package, not a finding. `CanonFile`, `SyncStrategy`, `SYNC_STRATEGIES` in `packages/stack/src/canon.ts`; `planFiles` in `packages/stack/src/files.ts`.
_Avoid_: template (for a verbatim file), config file

**Catalog**:
A set of pinned dependency versions that lands in a consumer's `pnpm-workspace.yaml#catalogs`, one catalog for `dev` (every consumer) and one per catalog group enabled in `with`. `CanonCatalogs` in `packages/stack/src/canon.ts`, `planCatalogs` in `packages/stack/src/catalogs.ts`.
_Avoid_: version list, lockfile

**Catalog entry**:
One package name with its pinned version inside a catalog; the unit that drifts or is held by an exception.
_Avoid_: dependency line

**Bundle**:
A set of catalog entries that pin each other exactly and must move together: this repository's Renovate bumps them in one branch, major and minor alike, and inside each version group they share one version within each catalog. A bundle is a record of `packages/stack/canon/bundles.json`: `match` (glob patterns of Renovate's `matchPackageNames`, no negation or regex), `required` (names every catalog holding the bundle must have) and `sameVersion` (groups of patterns with one version). Only tests read it, against `canon/catalogs.json` and the root `renovate.json5`; it is not part of `Canon`. `canonBundles` in `packages/stack/src/testkit.ts`.
_Avoid_: group (a **Group** is a slice switched on through `with`), package family

**Pin**:
A tool version fixed in the consumer's `.prototools` (node, pnpm and the other proto-managed tools); the canon's own pins are in `canon/files/prototools`, and `loadCanon` returns them as `Canon.pins` (`node` and `pnpm` are required).
_Avoid_: lock, freeze

**Own package**:
A package this repository publishes that reaches a Consumer with the Canon: an `@alxwlw/*` Catalog entry of the dev Catalog, or an `@alxwlw/*` dependency of `@alxwlw/stack`. Sync keeps each in `minimumReleaseAgeExclude`, and `stack sync-pr` waits for each in the registry. `ownPackages` in `packages/stack/src/own-packages.ts`.
_Avoid_: internal package, scoped package

### Verdicts

**Finding**:
One statement that a consumer departs from the canon, with a `code` (`FindingCode`, such as `file-drift` or `inline-version`) and a `target` (the file, or the catalog entry, it is about). `Finding` in `packages/stack/src/findings.ts`.
_Avoid_: violation, error, issue

**Drift**:
A finding that `stack sync` can close, because it carries a `Change` (an edit of one file as data) that `applyChanges` writes, one write per file. The changes to one file do not depend on each other, so `sync` can apply any subset of them: a held drift drops its change and the rest still apply. A finding without a change, such as `engines-node`, is only reported. `Drift`, `Change`, `isDrift` in `packages/stack/src/findings.ts`; `applyChanges` in `packages/stack/src/apply.ts`.
_Avoid_: diff, mismatch

**Exception**:
A recorded reason, in `.stack.jsonc`, why a consumer deliberately differs from the canon. It names an **address** (a `file`, or a `catalog` plus `name`) and covers the findings at that address; a covered finding is **held** (reported as suppressed, and left unapplied by `sync`). An exception that covers nothing any more is itself a `stale-exception` finding. An exception on a `catalog` plus `name` also holds the `inline-version` finding of the same package in any `package.json` (the knip case in `fixtures/node`). `Exception`, `EXCEPTION_SHAPES`, `EXCEPTION_KEYS`, `exceptionProblem`, `exceptionSchema`, `covers`, `resolve`, `allowedLine` in `packages/stack/src/exceptions.ts`; `held` in `SyncResult`, `packages/stack/src/check.ts`.
_Avoid_: ignore, override, waiver

**Peer baseline**:
The peer-dependency issues a consumer with the `peers` group already has, recorded in the file `PEERS_BASELINE` names, at the consumer's root, as `PeerEntry` records: importer, peer, kind (`unmet`, `missing`, `conflict`), the package that declares the peer, and for `unmet` the line of the version found (`versionLine`: the major, `0.minor`, or `0.0.patch`). Check compares what `pnpm peers check --lockfile-only --json` reports (`peersOutcome`, read through the `PeersReader` port) with it (`comparePeers`): an issue not recorded is a `peer-dependency` finding, a record no longer reported is `stale-peer-baseline`, and no lockfile or no usable pnpm answer is `peers-unavailable`. None of the three is held by an exception: the baseline plays that part. `packages/stack/src/peers.ts`, `checkPeers` in `packages/stack/src/peers-rule.ts`.
_Avoid_: allowlist, snapshot, exceptions list

**Note**:
A line of Check's output saying that part of a rule group was skipped or accepted (the `diff` part outside a pull request, a `Tests-Removed` trailer), or a hint under a finding (the `Tests-Removed` hint under a removed-assertions violation); it never changes the exit code and no exception applies to it. `CheckReport.notes` in `packages/stack/src/check.ts`, `repoRulesNotes` in `packages/stack/src/repo-rules-rule.ts`.
_Avoid_: warning, info finding

**Repo rules**:
The rules of `@alxwlw/repo-rules` that Check runs in process for a consumer with the `repo-rules` group, at the version of `@alxwlw/stack`. A violation (repo-rules' own word for a place that breaks a rule) is a `repo-rules-violation` finding, an entry higher than reality is `stale-repo-rules-baseline`, and a call that did not run or whose answer cannot be read is `repo-rules-unavailable`. None of the three is held by an exception: the baseline of repo-rules plays that part. `RepoRulesReader`, `readRepoRules` in `packages/stack/src/repo-rules.ts`, `checkRepoRules` in `packages/stack/src/repo-rules-rule.ts`.
_Avoid_: lint, policy

### Commands

**Check**:
Reports every finding of a consumer and fails when any is not held by an exception; it also returns notes (`CheckReport`), which do not change the exit code. `stack check`, `checkRepo` in `packages/stack/src/check.ts`.
_Avoid_: lint, audit, verify

**Sync**:
Applies every drift the exceptions do not hold, so a following check has nothing left among the drifts. `stack sync`, `syncRepo` in `packages/stack/src/check.ts`.
_Avoid_: update, apply, fix

**Peer baseline update**:
The only writer of the **Peer baseline**: `--init` records every current issue in a new file, no flag drops fixed records and refuses new ones, `--allow-grow` records the current set; `stack sync-pr` runs it as `drop-fixed`, which only drops fixed records and stays silent otherwise. A baseline that does not parse is never overwritten. `stack peers-baseline`, `peersBaseline` in `packages/stack/src/peers-baseline.ts`.
_Avoid_: regenerate, refresh

### Releasing

**Lockstep version**:
The single version number shared by the four packages (`@alxwlw/stack`, `@alxwlw/oxlint-config`, `@alxwlw/tsconfig`, `@alxwlw/repo-rules`) and by the `@alxwlw/*` entries of the dev catalog; a dependency of one package on another carries the same exact version. `setVersion` in `scripts/release.ts`.
_Avoid_: unified version, monorepo version

**Floating major tag**:
The git tag `v1`, moved to the latest `v1.x.y` release so consumers can pin the reusable workflows, actions and Renovate preset to a major. Referenced as `@v1` by `.github/workflows/check.yml` and `sync.yml`, and as `#v1` by the Renovate preset.
_Avoid_: latest tag, alias tag

**Rollout**:
The push of a release out to consumers: after publish, the sync workflow is dispatched in each consumer, which runs `stack sync` and opens a PR. The consumer half ships in the package as `stack sync-pr` and closes the sync-PRs of older versions (`packages/stack/src/sync-pr.ts`); the sync workflow only waits for that package version and calls it. `scripts/rollout.ts`, `.github/workflows/rollout.yml`.
_Avoid_: deploy, propagation

### Tests of the canon

**Fixture**:
A minimal consumer under `fixtures/<profile>/` holding only its seed, which contains no canon file at all, seed-strategy ones included (typically `.stack.jsonc`, a `package.json` and a workspace file without catalogs). Tests copy it and run `syncRepo` to obtain what a real consumer would have (`syncedFixture` in `packages/stack/src/selftest.test.ts`).
_Avoid_: snapshot, example repo

**Dogfood test**:
A test asserting that this repository's own root files stay equal to the canon's, because the repo does not run `stack sync` on itself. `packages/stack/src/dogfood.test.ts`.
_Avoid_: self-check
