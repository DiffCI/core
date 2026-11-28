# Examples

## Skip or narrow whole jobs

[`github-actions-step-plan.yml`](github-actions-step-plan.yml) runs `diffci plan --steps` in a first job and makes the lint and test jobs depend on its outputs. In observe mode, the default, every job still runs and the plan job's log says which jobs DiffCI would have skipped or narrowed. Switch the plan step to `--mode enforce` only after comparing those decisions with how the jobs ended. Jobs run unless DiffCI's output is exactly `'false'`, so a failed plan runs everything. See [Skip or narrow whole CI jobs](../docs/using-diffci.md#skip-or-narrow-whole-ci-jobs).

## Advisory GitHub Actions plan

Copy [`github-actions-core-plan.yml`](github-actions-core-plan.yml) to `.github/workflows/diffci-core-plan.yml` in the repository you want to evaluate. Keep every existing required test, build, lint, and security job unchanged. The example adds a separate advisory job; no other job reads its output.

The workflow runs for pull requests and:

1. checks out the exact pull-request head with full history so the base commit is available;
2. checks out and builds DiffCI Core in a separate directory, leaving the target checkout clean;
3. verifies the explicit base, head, and clean-worktree requirements;
4. runs `node dist/cli.js plan` with those revisions; and
5. uploads the JSON output and any JSON error as a 14-day artifact.

Only `contents: read` is granted. Plan generation is `continue-on-error` because an analysis refusal must recommend full CI, not block or replace it. The revision and cleanliness checks still fail the job when its inputs are invalid.

The example follows Core's `main` branch so copied workflows receive current behavior. For a repeatable evaluation, replace `ref: main` with a reviewed Core release tag or full commit ID. You can also pin the referenced GitHub Actions to reviewed commit IDs under your repository's dependency policy.

The resulting plan is advisory. `SKIP_CANDIDATE` is not permission to omit a required check, and an empty, refused, or failed plan must not be interpreted as safe selection. See [Use DiffCI in your repository](../docs/using-diffci.md) for the CLI contract and shallow-checkout recovery guidance.
