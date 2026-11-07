# DiffCI change impact Action

The public `DiffCI/core` Action ("DiffCI change impact", formerly "DiffCI Core
observer") is an observation-only wrapper around the pinned published DiffCI
CLI. Its job summary leads with what the change affects: how many test files
are affected and why each was selected, or that the full suite is needed and
why, with the full text report collapsed below. It analyzes a checkout and
writes a JSON report;
it never runs tests, skips tests, cancels jobs, edits the checkout, or changes
a check result unless `fail-on-error` is explicitly enabled for installation
debugging. It comments on pull requests only when you set `comment: "true"`.

Use it as its own advisory job and retain every required test, build, lint, and
security job unchanged. Pin `uses:` to a reviewed Core release tag or full
commit SHA; the example uses a placeholder deliberately.

```yaml
jobs:
  diffci-observer:
    runs-on: ubuntu-24.04
    continue-on-error: true
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
      - uses: DiffCI/core@<reviewed-core-release-or-commit>
```

Full history is required because the base commit must be available in the
checkout. By default, the report remains as a seven-day workflow artifact and
nothing is sent to a DiffCI endpoint. Set both `api-url` and `api-token` only
when the repository has deliberately configured ingest; pass the token through
a repository secret, never as a literal.

The wrapper installs the pinned CLI in `RUNNER_TEMP`, not the observed
checkout, so it does not modify the checkout's lockfile or `node_modules`.

## Pull request comment

The job summary is only visible to people who open the run. Set
`comment: "true"` to also keep one comment on the pull request up to date with
the same answer: how many test files are affected and why, or that the full
suite is needed and why, with a link to the job summary. Reruns and new pushes
update that comment in place instead of adding new ones.

```yaml
jobs:
  diffci-observer:
    runs-on: ubuntu-24.04
    continue-on-error: true
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
      - uses: DiffCI/core@<reviewed-core-release-or-commit>
        with:
          comment: "true"
```

The comment needs `pull-requests: write`. Pull requests from forks get a
read-only token on the `pull_request` event, so they get a warning in the log
instead of a comment; do not switch to `pull_request_target` for this. A failed
comment never fails the step. The comment shows test and file paths, which the
pull request diff already shows; with `redact-paths` it shows digests instead.

## Outputs

Besides `report-path` and `status`, the Action exposes the answer as step
outputs:

| Output | Value |
| --- | --- |
| `full-suite-required` | `"false"` only for a clean narrowed observation. `"true"` on any fallback, refusal, error or missing report. |
| `affected-tests` | JSON array of affected test files when `full-suite-required` is `"false"`. Empty otherwise, and always empty with `redact-paths`. |
| `affected-test-count` | Number of affected test files. |
| `total-test-count` | Number of test files the full suite runs. |
| `reason` | One line on why the full suite is required. |

The Action itself still runs and skips nothing. If you choose to narrow a test
job on these outputs, branch on `full-suite-required` and run the full suite
whenever it is `"true"`. `affected-tests` is deliberately empty, not `[]`, when
the full suite is required, so `fromJSON` fails instead of running nothing:

```yaml
  diffci:
    runs-on: ubuntu-24.04
    outputs:
      full: ${{ steps.diffci.outputs.full-suite-required }}
      tests: ${{ steps.diffci.outputs.affected-tests }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
      - id: diffci
        uses: DiffCI/core@<reviewed-core-release-or-commit>

  test:
    needs: diffci
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - if: ${{ needs.diffci.outputs.full != 'false' }}
        run: npm test
      - if: ${{ needs.diffci.outputs.full == 'false' }}
        env:
          TESTS: ${{ join(fromJSON(needs.diffci.outputs.tests), ' ') }}
        run: npx vitest run $TESTS
```

Keep the full suite on your default branch and in required checks until you
have compared DiffCI's selections with full runs on your own repository
(`diffci verify-savings`).
