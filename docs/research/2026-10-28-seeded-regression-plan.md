# Plan: measuring how many regressions DiffCI catches (seeded-regression experiment)

Status: plan only (2026-10-28). Not run.

## The question

The DentalPresence paired experiment (40 pairs, 2026-10-02 to 10-12) measured speed: where DiffCI
selected a subset it cut test time by 93%. None of those 17 selective pairs had a failing test in the
full suite, so "0 misses" meant there was nothing to miss. We do not know DiffCI's **recall**: of the
regressions that the full suite catches, what share does the selected subset also catch?

## Design

Take real commits, inject a known-bad change that the full suite detects, and check whether DiffCI's
selection for that commit (with the seed applied) still detects it.

### Inputs

- Repository: a read-only clone of DentalPresence at a fixed tip. Never push or modify the origin.
- Commits: the most recent 100 first-parent commits that DiffCI analyses without error. Record each
  commit's selection mode (selective/full); fallback commits catch every regression by construction
  and are reported separately, not counted as wins.

### Seeds (mutants)

For each commit, pick 3 seed sites at random from the **source files the commit changed** (seeding
where the agent edited is the realistic case), using a fixed RNG seed so the set is reproducible.
Apply one mutation per run, from these operators:

| Operator | Example |
|---|---|
| Negate a condition | `if (x)` → `if (!x)` |
| Off-by-one in a comparison | `<` → `<=` |
| Return a constant | `return value` → `return undefined` |
| Delete a statement | drop a call statement |
| Swap an exported string | `"D1"` → `"D2"` in an exported constant |
| Break an import chain | export a renamed symbol (catches transitive-import gaps) |

Plus two seed classes aimed at DiffCI's known blind spots:

- **Non-code reads:** edit a JSON/HTML/SQL file that a test reads from disk.
- **Cross-file contract:** change a function's behaviour in a module that only a *transitive*
  importer's test covers.

### Per run

1. Check out the commit, apply the seed, commit it on a scratch branch (so DiffCI sees one diff:
   parent → commit+seed).
2. Run the **full suite**. If it passes, the mutant is *equivalent or untested*: discard it from the
   denominator and record it (it measures test-suite weakness, not DiffCI).
3. Run DiffCI selection (`diffci verify --changed` equivalent, or the replay harness) and run only
   the selected tests.
4. Record: killed by full (yes), killed by selected (yes/no), selection mode, selected test count,
   runtime of each.

### Metrics

- **Recall** = mutants killed by selected / mutants killed by full, on selective commits only.
  Report with a 95% Wilson interval.
- **Misses**: every miss gets a written root cause (graph edge missing, non-code read, dynamic
  import, test outside the full suite, etc.) and a regression fixture in `tests/`.
- Speed for context: selected vs full runtime on the same seeded commits.
- Repeat for checks once affected-check selection exists (seed a lint violation, a type error, an
  architecture-boundary violation).

### Size and cost

100 commits × 3 seeds = 300 runs. Full suite ~80 s and analysis ~20 s on this repo, so about
300 × (80 + 20 + selected) ≈ 9–10 hours of machine time. Run it locally or on a self-hosted runner,
not on GitHub-hosted minutes (DentalPresence exhausted those in September).

A pilot of 10 commits × 3 seeds (≈1 hour) first, to check the harness and the equivalent-mutant
rate.

### Pass bar

Publish the number whatever it is. As an internal bar: recall ≥ 99% on selective commits with every
miss explained and fixed. Below 95%, selective mode should not be offered as a pre-push default.

### Threats to validity

- Seeding only in changed files over-represents easy cases; also seed 1 site per commit in an
  *unchanged* file the commit's changes import (the transitive case).
- Flaky tests: run the full suite twice on the unseeded commit and drop tests that disagree.
- One repository. Repeat on two open-source repos from the benchmark cohort before quoting recall
  externally.
