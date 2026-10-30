# Design: narrowing config-only changes

Status: candidate (2026-10-30). Not implemented. Today every edit to a file in `CONFIG_PATTERNS`
(`src/git/git-diff.ts`) sets `configChanged`, raises `CONFIG_GLOBAL` and forces the full suite.

## Why

On a replay of one production app's history, DiffCI fell back to the full suite on 58% of commits,
mostly because a config, `package.json`, workflow or lockfile change forced it to (issue #53).
Narrowing those safely is the main open problem.

## Candidate: Vitest reporter or timeout edits

A common agent edit to `vitest.config.*` only adds a reporter or changes `testTimeout`. Neither
changes which test files Vitest collects, so in principle the selection for the rest of the diff
could stand.

`tests/repo/vitest-config-fallback.test.ts` records today's behaviour for both edits on a synthetic
repository: `configChanged=true`, `CONFIG_GLOBAL`, `fallbackRequired=true`. A narrowing change must
update that test deliberately, not by accident.

## Safety rules

Narrow only when all of these hold; otherwise keep the full fallback:

- Both the old and the new config are statically recognizable (a literal `defineConfig({...})` or
  plain object export). Computed, imported or conditional configs keep the fallback.
- The only changed field is on a short allowlist of fields known not to affect selection.
- Test inclusion is provably identical before and after: `include`, `exclude`, `dir`, `root`,
  `projects`/workspace files, `setupFiles`, `globalSetup` and the CI invocation of the runner.
- Any field not on the allowlist, or not understood, keeps the fallback.

Even allowlisted fields are not free:

- A custom reporter is code and can have side effects or fail the run. Only built-in reporter names
  qualify.
- A shorter `testTimeout` can turn a passing test into a failing one in tests DiffCI did not select.
  Lowering it should keep the fallback; raising it is the safer direction.

The fixture does not execute Vitest, and passing it does not show that any config change is safe.

Thanks to robertwmccarty-caelum for the fixture and the narrowing conditions
([issue comment](https://github.com/DiffCI/core/issues/53#issuecomment-6514436312)).
