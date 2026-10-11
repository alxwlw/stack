# @alxwlw/repo-rules

Whole-repository checks that came out of a defect corpus: each one is a class of defect that already cost a review round. They run in CI and locally, on Node ≥ 20, with no dependencies.

```bash
pnpm add -D @alxwlw/repo-rules
pnpm exec repo-rules baseline --init   # once: record what is already there
pnpm exec repo-rules check             # every run: nothing new, nothing stale
pnpm exec repo-rules diff --base origin/main
```

## Rules

| Rule                          | Flags                                                                                                                                                                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `max-lines`                   | a tracked text file over 800 lines (plans, lockfiles, JSON, snapshots, generated and vendored files excluded)                                                                                                                                                                              |
| `suppression-reason`          | `eslint-disable*` / `oxlint-disable*` / `solhint-disable*` without ` -- reason`; `@ts-expect-error` / `@ts-ignore` without trailing text; `biome-ignore` without text after `:`; Python `# noqa` / `# type: ignore` without ` -- reason`                                                   |
| `focused-skipped-tests`       | in JS/TS test files: `.only(` on any line (the scan is line-based, see Limits); `.skip(` / `.todo(` / `xit(` / `xdescribe(` / `xtest(` without a ` -- reason` comment on the line or the comment line above. `.skipIf` / `.runIf` and Playwright's `test.skip(condition, reason)` are fine |
| `number-or-default`           | `Number(…)`, `parseInt(…)`, `parseFloat(…)` followed by `\|\| <non-zero literal>`: a real 0 silently becomes the default                                                                                                                                                                   |
| `removed-assertions` (`diff`) | a test file whose diff removes more `expect(` / `assert…` than it adds. A `Tests-Removed: <reason>` commit trailer in the range accepts it                                                                                                                                                 |

A reason is at least three non-space characters.

## Baseline

`.repo-rules-baseline.json` records the violations that already exist: line count per long file, hit count per file for the other rules. `check` fails when a file goes over its entry, and also when an entry is higher than reality (stale), so a fixed place cannot be reused by a new one. `baseline` only lowers entries; raising one takes `--allow-grow`, which shows in the PR diff.

## Configuration

Optional `.repo-rules.json`:

```json
{
	"maxLines": 800,
	"exclude": { "*": ["public/vendor/**"], "max-lines": ["docs/*.html"] },
	"testGlobs": [
		"**/*.{test,spec}.*",
		"**/__tests__/**",
		"**/test/**",
		"**/tests/**",
		"**/*.t.sol",
		"**/test_*.py",
		"**/*_test.py"
	]
}
```

`testGlobs` replaces the default list, shown in full above; it does not add to it.

## Limits

- Comments are found by a line heuristic, not a parser: a quote inside a regex literal or JSX text can hide a directive later on that line.
- `<!-- -->` comments in `.vue` and `.svelte` files are not read.
- `number-or-default` misses `|| .5`, and a `||=` default applied to a variable that holds a `Number(…)` result.
- `removed-assertions` does not see a test disabled by a rename with no content change (for example `a.test.ts` → `a.test.ts.off`).
- Assertions moved into a helper count as removed; the `Tests-Removed` trailer is the way out.
- The scan is line-based and does not know whether a line sits inside a string or a template literal, so `.only(` or `.skip(` inside a fixture string is flagged.

## CI

```yaml
- uses: actions/checkout@v5
  with:
    fetch-depth: 0 # diff needs the merge-base
- run: pnpm exec repo-rules check
- run: pnpm exec repo-rules diff # base = origin/$GITHUB_BASE_REF in a pull_request job, skipped otherwise
```

Exit codes: 0 clean, 1 violations or stale baseline, 2 error (never read as clean).
