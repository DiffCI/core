# DiffCI change impact Action

The public `DiffCI/core` Action ("DiffCI change impact", formerly "DiffCI Core
observer") is an observation-only wrapper around the pinned published DiffCI
CLI. Its job summary leads with what the change affects: how many test files
are affected and why each was selected, or that the full suite is needed and
why, with the full text report collapsed below. It analyzes a checkout and
writes a JSON report;
it never runs tests, skips tests, cancels jobs, edits the checkout, comments on
pull requests, or changes a check result unless `fail-on-error` is explicitly
enabled for installation debugging.

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
