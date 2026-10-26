# Fixtures hold only seeds

Status: accepted

## Context

Each `fixtures/<profile>/` is a stand-in consumer for the tests. It used to hold a full copy of what a consumer gets after a sync: 61 of its 70 files were byte-for-byte copies of `packages/stack/canon/files/*`, plus the pnpm catalogs. So every change to a canon file had to be repeated by hand in the fixtures. Before the cleanup of 2026-10-10 that happened 34 times in 7 commits (files under `fixtures/` touched per commit: `bf7ff95` 6, `8a4e6a5` 8, `65effe5` 4, `56a343e` 6, `8a8a4bf` 6, `be11a18` 3, `91fc3c3` 1), and afterwards once more (`14bb474`, the pnpm pin in three `.prototools`). Releases refreshed the catalogs in the fixtures through a script, `resyncFixtures`, which applied only the catalog plan with its own loop and so ignored the exceptions a fixture declares: it could write what a real `stack sync` would hold back. Renovate moved the pins in `fixtures/**` itself, through the `canon pins` group.

## Decision

A fixture is a seed: only what a consumer writes itself (typically `.stack.jsonc`, a `package.json` and a workspace file without catalogs; `fixtures/infra` has only `.stack.jsonc` and a `README.md`). A test that needs the full consumer copies the seed and runs `syncRepo`, the code `stack sync` runs (`syncedFixture` in `packages/stack/src/selftest.test.ts`). `resyncFixtures` is deleted and Renovate ignores `fixtures/**`.

A separate snapshot of "what a consumer receives" is not kept: the diff of a pull request that changes `packages/stack/canon/files/*` or `canon/catalogs.json` already is that snapshot.

## Consequences

- Changing a canon file touches nothing outside `packages/stack/canon/`.
- Two guards in `selftest.test.ts` keep the seeds seeds: no fixture file may equal any canon file in content (a copy under another name is caught too) and no fixture may carry catalogs; and every canon group that is not deprecated must be enabled by at least one fixture, so a new group cannot ship untested.
- The fixtures no longer show a consumer's final state on their own; reading it takes running the sync, which is what the tests do.
