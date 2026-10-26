# Releasing the canon

How a release of `@alxwlw/*` goes out, step by step. The workflows named here are the source of truth;
this page explains the order and the reasons behind it. For what consumers see, read
[README.md](../README.md), «Releases».

## Versioning

All packages under `packages/*` share one version, and so do the `@alxwlw/*` entries of
`packages/stack/canon/catalogs.json`. A release is a tag `vX.Y.Z` on the commit that carries that
version. Prerelease tags (`vX.Y.Z-rc.N`) are not supported. `publish.yml` runs `npm publish` without
`--tag`, and npm 11 refuses a prerelease version without one, so the `publish` job fails at its first
package and nothing is published; and `rollout.yml` would dispatch any successful release to every consumer.

- Bump the minor when a consumer's `check` can turn red after the update, or when the canon gained an
  input or a group. Anything else is a patch.
- Nobody edits a version by hand: `scripts/release.ts` writes it, and the publish workflow refuses a tag
  that disagrees with any package.

## Cut a release

1. Branch from a fresh `main`.
2. Run `bun scripts/release.ts version X.Y.Z`. It writes `version` into every `packages/*/package.json`
   and the same version into each `@alxwlw/*` entry of `canon/catalogs.json`. `release.ts` finds every
   `packages/*` directory with a `package.json` by itself, but two lists name packages explicitly: the
   publish loop in `.github/workflows/publish.yml` and the package list of the wait step in
   `.github/workflows/sync.yml`. A new package is added to both in the same PR. Until it is, the tests
   `scripts/release.test.ts` (publish.yml publishes every package from packageDirs) and
   `packages/stack/src/dogfood.test.ts` (the wait step waits for every published package in `packages/`)
   fail.
3. Run the repository gates: `bun test`, `pnpm exec oxlint --type-aware`, `pnpm exec oxfmt --check .`,
   `pnpm exec tsc --build`, `proto run actionlint -- -color`.
4. Open a PR titled `chore(release): X.Y.Z` and merge it.

## Tag and publish

1. On the merge commit, create an annotated tag and push it:

   ```bash
   git tag -a vX.Y.Z -m vX.Y.Z <merge commit>
   git push origin vX.Y.Z
   ```

2. `publish.yml` runs on tags matching `v[0-9]*.[0-9]*.[0-9]*` only. The floating `v1` tag does not
   match, so moving it never starts a second publish.
3. Job `selftest` runs the test, lint, format and typecheck gates, then
   `bun scripts/release.ts check-tag "$GITHUB_REF_NAME"`, which fails when the version of any package
   differs from the tag.
4. Job `publish` publishes each package named in its loop, from its own directory, with `--provenance`,
   through npm trusted publishing (OIDC, no npm token). It does not publish every directory under
   `packages/`: a new package is included only after it is added to that loop (see step 2 of
   «Cut a release»). A version that is already in the registry is skipped, so a re-run
   after a partial publish finishes the rest.

## Rollout

When `publish` succeeds, `rollout.yml` runs `bun scripts/rollout.ts`. It signs a JWT for the GitHub App,
takes the App's installation token for each consumer's owner, and dispatches the `stack-sync` workflow on the
consumer's `main` with the version as input. The consumers are the lines of the `STACK_CONSUMERS`
secret (`owner/repo`, one per line); the App credentials are `STACK_BOT_APP_ID` and
`STACK_BOT_PRIVATE_KEY`. An empty list is not an error: the run logs that there is nothing to roll out.

This repository is public, so the log carries counters only: `dispatched: N, failed: M`. A failed
dispatch is counted and its message is dropped, because it can name the consumer.

On the consumer side the reusable `sync.yml` waits until every package named in its wait step is visible in the
npm registry, and only then runs `bunx @alxwlw/stack@X.Y.Z sync` and opens the PR.

### VERSION arrives with the tag prefix

For a tag push, `github.event.workflow_run.head_branch` is the tag name (`v1.2.3`), not the bare
version. `rollout.yml` passes it as `VERSION`, and `stripTagPrefix` in `scripts/release.ts` removes the
leading `v` and throws on anything that is not a semver version. Without that, the branch of the sync PR
would be `stack/vv1.2.3`, and a stray ref such as `main` would be fanned out to every consumer.

### Why the rollout job skips install

`rollout.yml` calls the setup action with `install: false`. The job holds the App private key, so it must
not run third-party code from `node_modules`; it also starts faster. That is why `scripts/rollout.ts`
imports only `node:*` modules and `scripts/release.ts`, and `release.ts` imports only `node:*`. A test
(`scripts/release.test.ts`) keeps that import graph closed.

## Move the floating v1 tag

Consumers pin `v1`: the reusable workflows `check.yml` and `sync.yml` (`@v1`), the setup action, and the
Renovate preset (`#v1`). After a release within major 1 the tag has to move to it.

Do it only when `publish` is green and `npm view @alxwlw/<package>@X.Y.Z version` answers for **every**
package under `packages/*`. Consumers resolve `v1` at once, so moving it earlier points them at a release they
cannot install yet.

```bash
old="$(git ls-remote --tags origin refs/tags/v1 | awk '$2 == "refs/tags/v1" { print $1 }')"
test -n "$old"
git tag -f -a v1 -m v1 'vX.Y.Z^{commit}'
git push --force-with-lease="refs/tags/v1:$old" origin refs/tags/v1
git ls-remote origin 'refs/tags/v1^{}' 'refs/tags/vX.Y.Z^{}'
```

The last command must print the same SHA twice. The lease makes the push fail if someone moved `v1`
since you read it.

Sync PRs dispatched before the move run the previous `sync.yml` with an explicit version. That is
intended: the version comes from the dispatch input, not from the tag.

## A new major

A new major gets its own floating tag (`v2`) and a new literal wherever `v1` is written. Find the places
with `git grep -n '@v1\|#v1'`: the Renovate preset constant in the CLI, the canon workflow files,
`check.yml` and `sync.yml`, the Renovate seed, the tests that pin the literal, and the README. Move the
literal and the tag in the same release.

## After a release

- Compare `dispatched` and `failed` in the rollout run with the previous rollout. A rise in `failed`
  means a consumer without an App installation, or a typo in the `STACK_CONSUMERS` secret.
- Check the `stack-sync` run of each consumer.
- Re-run one consumer by hand:

  ```bash
  gh workflow run stack-sync.yml -R acme/app -f version=X.Y.Z
  ```
