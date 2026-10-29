# Stack canon

The vocabulary of the toolchain canon and its `stack` CLI: what a repo adopts, what drifts, and how the canon travels out to repos.

## Language

### Canon and consumers

**Canon**:
The one shared set of toolchain files and pinned dependency versions, shipped inside `@alxwlw/stack`. Loaded per repo as a value by `loadCanon` (`packages/stack/src/canon.ts`); its sources are `packages/stack/canon/`.
_Avoid_: template, boilerplate, preset

**Consumer**:
A repository that adopts the canon and is kept in line with it by `stack sync` and `stack check` (for example `acme/app`). It states how in its `.stack.jsonc` (`readStackConfig`, `packages/stack/src/config.ts`). Loaded once per command as a value by `loadRepo` (`packages/stack/src/repo.ts`): the content of the files it could read, and which paths exist. An unreadable or unparsable `package.json` (root or nested), `pnpm-workspace.yaml`, Renovate config or moon's toolchain config becomes exactly one `unreadable-file` finding; the rules are pure functions of that value and the canon.
_Avoid_: client, downstream, target repo

**Profile**:
The kind of repository a consumer declares, `node`, `contracts` or `infra`; it decides which canon files apply. `PROFILES` in `packages/stack/src/config.ts`, `appliesTo` in `canon/manifest.json`.
_Avoid_: preset, flavour, template

**Group**:
A named opt-in slice of the canon, switched on through `with` in `.stack.jsonc`. There are three kinds: a **file group** (the `group` field of a manifest entry), a **catalog group** (a key of `canon/catalogs.json` other than `dev`, which every consumer gets) and a **deprecated group** (accepted for old configs, enables nothing). Names come from `canonGroups` and `DEPRECATED_GROUPS` in `packages/stack/src/canon.ts`.
_Avoid_: feature, module, flag

### What the canon holds

**Canon file**:
A file the canon places at a path (`dest`) in a consumer, listed in `canon/manifest.json` and stored under `canon/files/`. Its strategy is either **verbatim** (the consumer's copy must equal the canon's byte for byte) or **seed** (`create-if-absent`: written once, then owned by the consumer, and only its absence is drift; not the seed of a **Fixture**, which holds no canon file). A seed may name `satisfiedBy` paths, other legitimate names that already close the seeding. `CanonFile`, `SyncStrategy` in `packages/stack/src/canon.ts`; `planFiles` in `packages/stack/src/files.ts`.
_Avoid_: template (for a verbatim file), config file

**Catalog**:
A set of pinned dependency versions that lands in a consumer's `pnpm-workspace.yaml#catalogs`, one catalog for `dev` (every consumer) and one per catalog group enabled in `with`. `CanonCatalogs` in `packages/stack/src/canon.ts`, `planCatalogs` in `packages/stack/src/catalogs.ts`.
_Avoid_: version list, lockfile

**Catalog entry**:
One package name with its pinned version inside a catalog; the unit that drifts or is held by an exception.
_Avoid_: dependency line

**Pin**:
A tool version fixed in the consumer's `.prototools` (node, pnpm and the other proto-managed tools); the canon's own pins are in `canon/files/prototools`, and `loadCanon` reads them as `Canon.pins` (`node` and `pnpm` are required).
_Avoid_: lock, freeze

### Verdicts

**Finding**:
One statement that a consumer departs from the canon, with a `code` (`FindingCode`, such as `file-drift` or `inline-version`) and a `target` (the file, or the catalog entry, it is about). `Finding` in `packages/stack/src/findings.ts`.
_Avoid_: violation, error, issue

**Drift**:
A finding that `stack sync` can close, because it carries a `Change` (an edit of one file as data) that `applyChanges` writes, one write per file. A finding without a change, such as `engines-node`, is only reported. `Drift`, `Change`, `isDrift` in `packages/stack/src/findings.ts`; `applyChanges` in `packages/stack/src/apply.ts`.
_Avoid_: diff, mismatch

**Exception**:
A recorded reason, in `.stack.jsonc`, why a consumer deliberately differs from the canon. It names an **address** (a `file`, or a `catalog` plus `name`) and covers the findings at that address; a covered finding is **held** (reported as suppressed, and left unapplied by `sync`). An exception that covers nothing any more is itself a `stale-exception` finding. An exception on a `catalog` plus `name` also holds the `inline-version` finding of the same package in any `package.json` (the knip case in `fixtures/node`). `Exception`, `EXCEPTION_SHAPES`, `exceptionProblem`, `covers`, `resolve`, `allowedLine` in `packages/stack/src/exceptions.ts`; `held` in `SyncResult`, `packages/stack/src/check.ts`.
_Avoid_: ignore, override, waiver

### Commands

**Check**:
Reports every finding of a consumer and fails when any is not held by an exception. `stack check`, `checkRepo` in `packages/stack/src/check.ts`.
_Avoid_: lint, audit, verify

**Sync**:
Applies every drift the exceptions do not hold, so a following check has nothing left among the drifts. `stack sync`, `syncRepo` in `packages/stack/src/check.ts`.
_Avoid_: update, apply, fix

### Releasing

**Lockstep version**:
The single version number shared by the four packages (`@alxwlw/stack`, `@alxwlw/oxlint-config`, `@alxwlw/tsconfig`, `@alxwlw/repo-rules`) and by the `@alxwlw/*` entries of the dev catalog. `setVersion` in `scripts/release.ts`.
_Avoid_: unified version, monorepo version

**Floating major tag**:
The git tag `v1`, moved to the latest `v1.x.y` release so consumers can pin the reusable workflows, actions and Renovate preset to a major. Referenced as `@v1` by `.github/workflows/check.yml` and `sync.yml`, and as `#v1` by the Renovate preset.
_Avoid_: latest tag, alias tag

**Rollout**:
The push of a release out to consumers: after publish, `stack-sync.yml` is dispatched in each consumer, which runs `stack sync` and opens a PR. `scripts/rollout.ts`, `.github/workflows/rollout.yml`.
_Avoid_: deploy, propagation

### Tests of the canon

**Fixture**:
A minimal consumer under `fixtures/<profile>/` holding only its seed, which contains no canon file at all, seed-strategy ones included (typically `.stack.jsonc`, a `package.json` and a workspace file without catalogs). Tests copy it and run `syncRepo` to obtain what a real consumer would have (`syncedFixture` in `packages/stack/src/selftest.test.ts`).
_Avoid_: snapshot, example repo

**Dogfood test**:
A test asserting that this repository's own root files stay equal to the canon's, because the repo does not run `stack sync` on itself. `packages/stack/src/dogfood.test.ts`.
_Avoid_: self-check
