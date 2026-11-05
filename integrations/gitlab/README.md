# DiffCI Core observer for GitLab CI/CD

The GitLab CI/CD component version of the [DiffCI Core observer Action](https://github.com/DiffCI/core/blob/main/docs/github-action-observer.md).
It analyses each merge request and default-branch push and writes a JSON report saying which tests
the change affects and why. It is observation only: it runs no tests, skips or cancels no jobs,
does not comment on merge requests, does not change the checkout, and sends nothing anywhere.

```yaml
include:
  - component: $CI_SERVER_FQDN/diffci/diffci/observe@0.3.28
```

Keep every existing test, build, lint and security job unchanged. The observer adds one job beside
them.

## What the job does

- Runs on merge request pipelines and on pushes to the default branch, where a commit range exists.
- Starts at once (`needs: []`) and uses `allow_failure: true`, so a DiffCI problem never fails the
  pipeline.
- Clones with `GIT_DEPTH: "0"`, because GitLab's default 20-commit clone can drop a merge request's
  base commit.
- Installs the pinned CLI outside the checkout with `--ignore-scripts`, and writes the report outside
  the checkout while observing.
- Uploads `.diffci/diffci-observation.json` as an artifact, linked from the merge request as
  "DiffCI observation", and exposes `DIFFCI_STATUS` (`OBSERVED`, `REFUSED` or `ERROR`) to jobs that
  `needs` it.

In a merged-results pipeline the observer diffs the source branch head, not the merge commit GitLab
creates.

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `stage` | `test` | Stage of the observer job |
| `job-name` | `diffci-observe` | Job name; redefine the job to override `rules` or `allow_failure` |
| `image` | `node:22` | Needs Node 22+, git and bash. Alpine images lack bash. Pin by digest in production |
| `cli-version` | `0.3.28` | Exact published `@diffci.com/diffci` version |
| `redact-paths` | `false` | Replace every path in the report with a stable 12-character digest |
| `artifact-expire-in` | `7 days` | How long the report artifact is kept |

## Not yet

- Sending reports to DiffCI Cloud. Cloud accepts GitHub repositories only today, so this component
  sends nothing.
- Reading `.gitlab-ci.yml` to plan which jobs a change affects. Changes to GitLab pipeline files,
  and to files they `include`, already make the observer report a full run.

Source: [DiffCI/core](https://github.com/DiffCI/core/tree/main/integrations/gitlab), MIT.
