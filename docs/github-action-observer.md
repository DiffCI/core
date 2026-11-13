# DiffCI change impact Action

The public `DiffCI/core` Action ("DiffCI change impact", formerly "DiffCI Core
observer") is a wrapper around the pinned published DiffCI CLI. By default it
only observes; the opt-in [fast check](#fast-check) also runs the affected
tests. Its job summary leads with what the change affects: how many test files
are affected and why each was selected, or that the full suite is needed and
why, with the full text report collapsed below. It analyzes a checkout and
writes a JSON report;
without `verify` it never runs tests, and it never skips tests, cancels jobs or
edits the checkout. It changes a check result only when `fail-on-error` is
enabled for installation debugging, or when the fast check's tests fail. It comments on pull requests only when you set `comment: "true"`.

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
      - uses: DiffCI/core@<reviewed-core-release-or-commit>
```

DiffCI compares the change against its base commit. A default
`actions/checkout` clones only one commit, so from v0.3.36 the Action fetches
the missing history itself when the checkout is shallow: it adds git objects
only and leaves the working tree, HEAD and branches unchanged. `fetch-depth: 0`
still works and skips that fetch, and versions before v0.3.36 need it. If the
fetch fails, for example with `persist-credentials: false` on a private
repository, the step warns and the observation refuses with what to add.
From v0.3.37 the CLI does the same in GitHub Actions and GitLab CI, so a
`diffci observe` or `diffci verify` step needs neither `fetch-depth: 0` nor
`GIT_DEPTH: "0"`; it never fetches into a local clone. By default, the report remains as a seven-day workflow artifact and
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
      - uses: DiffCI/core@<reviewed-core-release-or-commit>
        with:
          comment: "true"
```

The comment needs `pull-requests: write`. Pull requests from forks get a
read-only token on the `pull_request` event, so they get a warning in the log
instead of a comment; do not switch to `pull_request_target` for this. A failed
comment never fails the step. The comment shows test and file paths, which the
pull request diff already shows; with `redact-paths` it shows digests instead.

## Fast check

Set `verify: "true"` to also run what the change affects, as a fast first job
next to your normal CI. DiffCI runs `diffci verify --fail-fast` on the pull
request's range: the repository's check script leaves (lint, typecheck) first,
then the affected test files with the ones most likely to fail first, and the
step fails as soon as one of them fails. A breakage shows up in a few minutes
instead of at the end of the full suite.

It adds a job and skips nothing. Keep your full test job and required checks
unchanged; the fast check is a signal, not a replacement, so you can try it
without trusting DiffCI to skip anything.

```yaml
jobs:
  diffci-fast-check:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 22
      - run: npm ci
      - uses: DiffCI/core@<reviewed-core-release-or-commit>
        with:
          node-version: "22"
          verify: "true"
```

- **It runs your code.** Unlike observation, the fast check runs the
  repository's own test and check commands in the checkout, so install
  dependencies before the step, as your test job does. The Action sets up Node
  `node-version` for the rest of the job; set it to the version you test on.
- **It runs nothing when DiffCI is unsure.** When `full-suite-required` is
  `"true"`, the step runs nothing, passes with a notice and leaves the change to
  your full test job, instead of running the whole suite twice.
- **Only real failures fail it.** Failing tests or checks fail the step. A
  DiffCI problem (it could not verify, timed out after
  `verify-timeout-minutes`, or did not start) only warns.
- **It tests the change as it would merge.** On a pull request, a default
  `actions/checkout` checks out GitHub's merge commit, so the fast check
  verifies that commit against the base branch tip it was merged into. If you
  check out the pull request head instead (`ref:
  ${{ github.event.pull_request.head.sha }}`), it verifies the pull request's
  own range. Neither changes the checkout.
- **`verify-checks: "false"`** skips lint and typecheck when other jobs already
  run them first.
- Nothing is sent anywhere and no outcome log is kept on the runner. The
  verification receipt is uploaded with the observation report, and the
  verification output is in the job summary.

The `verify-status` output is `passed`, `failed`, `blocked` or `skipped`. See
the [fast check example](../examples/github-actions-fast-check.yml).

## Merge gate

Set `check-run: "true"` next to `verify: "true"` to also post one check run,
**DiffCI merge gate**, on the pull request's head commit. Branch protection
(or a ruleset) can then require it by that name, whatever your jobs are called.
It is meant for pull requests written by AI coding agents: the change cannot
merge until the tests it affects have passed, and the check says which agent
wrote it and what ran.

| Fast check | Check run conclusion |
| --- | --- |
| `passed` | `success`: every affected test (and lint/typecheck) passed, on GitHub's merge commit with a default checkout |
| `failed` | `failure` |
| `skipped`, `blocked`, did not run, or `verify` off | `neutral`: DiffCI could not narrow or verify the change, so your full test job decides |

GitHub treats `neutral` as passing for a required check, so DiffCI never
blocks a merge on its own uncertainty, and it never replaces your full test job:
keep that required too.

The check's summary lists the agent, how many test files ran out of how many,
the checks that ran, the DiffCI version and a link to the run. With
`upload-artifact` on (the default), the run's artifact holds the observation
report and, when the fast check ran, the verification receipt. The agent comes
from the `Co-authored-by` trailers and "Generated with" lines of the pull
request's commits and from an agent-prefixed head branch (`claude/`, `codex/`,
`copilot/`, `cursor/`, `devin/`, `jules/`, `openhands/`). Only a fixed label
such as `claude` is written, never a name, email or branch; with no marker it
says "none detected", which does not mean a person wrote it.

```yaml
    permissions:
      contents: read
      checks: write
    steps:
      # ... checkout, setup-node and npm ci as in the fast check above
      - uses: DiffCI/core@<reviewed-core-release-or-commit>
        with:
          node-version: "22"
          verify: "true"
          check-run: "true"
```

The check run needs `checks: write`. Pull requests from forks get a read-only
token on the `pull_request` event, so they get a warning instead of a check run;
do not switch to `pull_request_target` for this. A failed post never fails the
step. `check-run-name` renames the check; the `gate-conclusion` and `agent`
outputs carry the same answer for later steps.

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
| `verify-status` | With `verify`: `passed`, `failed`, `blocked` or `skipped`. |
| `gate-conclusion` | With `check-run`: `success`, `failure` or `neutral`. |
| `agent` | With `check-run`: the detected agents, such as `claude` or `claude+codex`, or `none detected`. |

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
