# Seeded-regression pilot: does DiffCI's selection catch what the full suite catches? (2026-10-30)

Pilot of [the seeded-regression plan](2026-10-28-seeded-regression-plan.md) on one dogfood repository
(DentalPresence). Small sample; read it as a first measurement, not a recall claim.

## Method

- **Commits:** the 10 most recent first-parent commits that DiffCI analyses selectively and that change at
  least three mutable lines in non-test source files.
- **Seeds:** 3 per commit (30 in total), each a single-line mutation in a source file the commit changed,
  preferring lines the commit added. Operators: `===`/`!==` flip, `&&`/`||` swap, `return true`/`false` swap,
  comparison off-by-one. Generated deterministically from the commit SHA.
- **Per commit, in one Cloudflare Container** (`docker.io/cloudflare/sandbox:0.12.5`, `standard-3`, Node
  24.16.0): `npm ci`, then the full suite (`npm test`) on the clean commit. Then for each seed applied alone and
  committed: the full suite, and `diffci verify --no-checks` from CLI 0.3.18 on parent..seeded commit.
  `--no-checks` isolates test selection from gate checks.
- **Counted:** a seed enters the denominator only when the clean full suite passed and the seeded full suite
  failed. DiffCI catches it when `verify` fails with the same failing tests.

## Result

| | Seeds |
|---|---|
| Applied (on commits whose clean suite passed: 10 of 10) | 30 |
| Detected by the full suite (`npm test`) | **5** |
| ...also caught by DiffCI's selection | **5 of 5** (95% Wilson interval 57–100%) |
| Not detected by the full suite (excluded) | 25 |

In all 5, DiffCI's failing tests were exactly the full suite's failing tests. DiffCI selected 3, 277 and 271 of 580
test files on those commits; the last two include the `node scripts/test-security.js` phase.

**DiffCI also caught 3 seeds that `npm test` did not.** All three are in `ops/cloudflare-d1/gateway/*.mjs`;
the failing tests (`tenant operations reject open or out-of-range input before reading`, `writer captures care and
featured placement…`) exercise the mutated file directly. DiffCI runs them as affected tests outside the full
suite: they belong to the repository's separate D1 suite, which `npm test` does not run.

## Limits

- **5 detected seeds is too few for a recall claim.** The interval spans 57–100%. A run of about 100 commits is
  needed before quoting a number.
- **The full suite detected only 5 of 30 seeds.** Most mutations sat in code that `npm test` does not cover,
  mainly D1 gateway modules tested by a separate suite. This measures the test suite as much as DiffCI.
- **Six DiffCI runs failed for an unrelated reason:** an out-of-suite ZIP-reader test fails in the container
  whatever the seed. They are not counted as catches. A future run should also run DiffCI on the clean commit
  and subtract its failures.
- One repository, seeds only in changed files, and no flaky-test control (each suite ran once).

## Reproduce

The harness is `gen_mutants.py` (manifest), `recall.sh` (container script), a `diffci-recall-replay` Worker that
starts one container per commit, and `run_recall.py` (driver), kept with the raw results outside this repository.
