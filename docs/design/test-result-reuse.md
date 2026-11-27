# Design: reusing test results across trees

Status: proposal (2026-11-27). Nothing below is implemented.

## Why

Local `verify` runs on DiffCI.com since 2026-11-18 (33 runs in `.git/diffci/outcomes.jsonl`): tests are 79%
of verify time and DiffCI's analysis 21% (median 11s). On Core, tests are 99%. Of the test-file time in runs
that followed a passing run, 29% went to test files that had passed in that previous run. That is the ceiling
for this feature; the real saving is lower, because some of those files depended on code that changed.

Today `verify` reuses a pass only when the tree is byte-identical (`reusablePass` in
`packages/diffci-cli/src/client/outcome-log.ts`, 2026-11-06). An agent that edits one file at 10pm, passes,
edits another at 11pm and verifies again re-runs every selected test, including ones the 11pm edit cannot reach.

## The rule

A test T selected at tree **S2** may be skipped when an earlier run at tree **S1** passed with T in it, and
**DiffCI's own selection for the change S1 → S2 does not select T**.

That reuses the model `verify` already trusts. Selecting T for base..S2 says "the change since base can
affect T". Not selecting T for S1..S2 says "nothing changed since T last passed can affect T". If the second
claim were wrong, the same miss would already occur in an ordinary selective run of S1..S2, so reuse adds no
new kind of miss, only more chances for an existing one.

Concretely, for the run at S2:

1. Find the source: the newest run in the outcome log with `verification: "passed"` that actually executed
   tests (not itself a reused run), with the same Node version, DiffCI version and test command for T.
2. Compute the delta S1 → S2 with `git diff --name-status <S1 tree> <S2 tree>`. Tree objects written by
   `git write-tree` can be pruned by `git gc`; a missing tree means no reuse.
3. Run the selection for that delta on the S2 graph (already built for this run, so it costs an impact pass,
   not a graph build), plus coverage-map additions for the same delta.
4. Reusable = tests selected for base..S2 ∩ tests that ran and passed at S1 − tests selected for S1..S2.
5. Run the rest. If everything is reusable, nothing runs, as with today's same-tree reuse.

No reuse at all when any of these hold:

- the S1..S2 selection falls back to the full suite (lockfile, config, unknown file, unmodelled language);
- the run is under `--policy enforce` or in CI (the receipt must show what ran);
- `--no-reuse` or `DIFFCI_REUSE=0`.

A single test is never reused when:

- its selection reason is `ALWAYS_RUN_POLICY`;
- it failed in any logged run after S1 (the newest result for that test wins, not the newest pass);
- the source pass is older than a cap (proposal: 24 hours), to bound drift in what the log cannot see.

## What the log cannot see

Same limits as same-tree reuse, now spread over more runs:

- `node_modules` changed without a lockfile change;
- environment variables, network services, the clock, and other runtime inputs the graph does not model;
- flaky tests: a pass at S1 is one sample, and reuse stops re-sampling it.

The age cap and the "newest result wins" rule limit the last two. A full run with `--no-reuse` clears all of
them.

## Receipt and log

- The report gets `reused_tests: [{ test, from_tree, from_produced_at }]` next to `selected_tests`, and the
  reason line says how many tests ran and how many were reused.
- The outcome log records only tests that ran as sources. A reused test keeps pointing at the tree where it
  last ran, so reuse never chains through a run that did not execute it.
- Usage counting adds one number: tests reused.

## Pre-push hook

The hook already accepts a same-tree pass. Whether it should accept a partly reused pass is open (see
Decisions). If not, the hook runs with reuse off and only the agent loop (`verify --changed`, `watch`,
`agent-stop`) benefits.

## Measure before building

Replay the existing outcome logs offline before writing the feature:

- for each run that followed a pass on the same repository, rebuild the selection for S1 → S2 at S2 (trees
  are still in the object store for recent runs) and count the time of tests that would have been reused;
- report the real saving next to the 29% ceiling, per repository.

This replay runs locally against `.git/diffci/outcomes.jsonl`. It runs no tests and no CI replay containers.
If the real saving is under about 10% of local test time, stop here.

## Decisions

1. Does the pre-push hook accept a partly reused pass, or always run with reuse off?
2. Age cap for a source pass: 24 hours, or tied to the base (`merge-base` unchanged)?
3. Default on or opt-in (`--reuse-across-trees`) for the first release?

## First slice

1. The offline replay above, as a script under `scripts/`, with its result in this document.
2. If it clears the bar: the rule behind a flag, local `verify` only, with the receipt fields.
3. Default on after one release with no possible misses in `diffci outcomes`.
