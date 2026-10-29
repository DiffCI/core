# Full-suite fallback rate, replayed on a dogfood repository (2026-10-28)

## Method

Static replay, no tests executed. For each of the last 150 first-parent commits of DentalPresence
(tip `a092232a`, a read-only clone), DiffCI analysed `commit^..commit` with `analyzeGitDelta`,
`buildDependencyGraph` and `ImpactAnalyzer`, as the CLI does. A commit "falls back" when
`fallbackRequired` is true. Three runs over the same commits:

- **before**: the engine at `330a1d5` (CLI v0.3.15);
- **after**: this branch, with `selectTestPhases` off (what the current CLI would get);
- **after + phases**: this branch with `selectTestPhases` on.

## Result

| | Full-suite fallback | Median tests selected (selective commits, of 580) |
|---|---|---|
| before | 75/150 (50.0%) | 28 |
| after | 71/150 (47.3%) | 32 |
| after + phases | **33/150 (22.0%)** | 65 |

With phases: 42 commits move from full to selective, none move the other way. Commits newly made
selective select a median of 244 of 580 tests, because the phase that covers them
(`node scripts/test-security.js`) reads whole directories, so many tests read the same files.

Four selective commits select fewer tests than before (274 to 69). All four change a workflow file.
The tests no longer selected were reached only through a basename collision: a test importing
`ops/cloudflare-d1/gateway/worker.mjs` was treated as reading `ops/cloudflare-d1/staging-sync/worker.mjs`.
The workflow's actual readers are still selected.

Without phases, nearly every remaining fallback in this repository ends at that one test-script
phase, which is why the rate barely moves. `diffci verify` and the MCP selection request phases and
run them after the selected test files; `check`, `observe` and enforce do not request them and keep
the fallback. Checked end to end on `43231ce1` with this branch's engine overlaid on the CLI: 45 of
579 test files plus `node scripts/test-security.js`, where v0.3.15 ran the full suite. The CLI picks
this up once its bundled `@diffci.com/core` is bumped to a commit containing the engine change.

## Fallback reasons, by commit

| Reason | before | after + phases |
|---|---|---|
| Unknown changed file | 46 | 12 |
| Configuration file(s) changed | 28 | 10 |
| Infrastructure code outside the dependency graph | 23 | 3 |
| Dependency manifest changed | 22 | 2 (+2 named unimported packages) |
| Infrastructure definition(s) changed | 13 | 13 |
| Deleted file not in HEAD graph | 13 | 13 |
| Deleted test, legacy dependents unknown | 11 | 11 |
| Dependency graph confidence UNSAFE | 7 | 7 |
| GitHub workflow that runs tests changed | 5 | 5 |
| Lockfile changed | 1 | 0 |

A commit can carry several reasons.

## What is left

- Deployment definitions (`wrangler.gateway.*.json`, `Dockerfile`) stay global by design.
- Deleted files: 24 commits fall back because the deleted file's former dependents cannot be
  read from the HEAD graph. Building the base commit's graph for deleted paths would address this.
- Selection size on phase-covered commits is large; it shrinks only if the phase script's reads
  can be modelled per file.
- Static replay measures selection, not correctness: no selective commit was run against the
  full suite here. `2026-10-28-seeded-regression-plan.md` covers that.
