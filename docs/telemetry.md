# Usage counting

The `diffci` CLI (`@diffci.com/diffci`) counts its runs so the project can see how many repositories
use DiffCI. It is on by default. The Core engine on its own (`node dist/cli.js plan`, `@diffci.com/core`)
sends nothing.

## What is sent

One small HTTPS request to `https://app.diffci.com/v1/usage-events` after each `plan`, `check`,
`observe` and `verify` run (including runs from the GitHub Action, the GitLab component and the MCP
server). It contains:

| Field | Example | Notes |
| --- | --- | --- |
| `command` | `plan` | `plan`, `check`, `observe` or `verify` |
| `outcome` | `selective` | for example `selective`, `full`, `passed`, `failed`, `observed`, `error` |
| `version` | `0.3.30` | CLI version |
| `surface` | `github-action` | `cli`, `local-mcp`, `github-action` or `gitlab-component` |
| `ci` | `true` | whether the run happened in CI |
| `activity` | `external` | `internal` when labelled with `--internal-usage` or `DIFFCI_USAGE_INTERNAL=1` |
| `installation_id` | random UUID | created locally in `~/.diffci/telemetry.json`; not tied to a person |
| `repository` | `github.com/acme/widgets` | host/owner/repo, from `GITHUB_REPOSITORY`, GitLab CI variables or the `origin` remote, with credentials removed |

It never contains source code, file paths, commit SHAs, branch names, test names, reports, IP-based
location, user names, email addresses or machine details. The request has a 3-second timeout, and a
failed or blocked request never changes the outcome or exit code of a run.

The first run on a machine prints a one-line notice to stderr. In CI, where the home directory is
usually fresh, the notice appears on each run.

## Choices

- **Count without the repository name:** `diffci telemetry --mode count-only`. This also deletes the
  local installation ID. `diffci telemetry --mode repo` restores the default.
- **Stop counting entirely:** set `DO_NOT_TRACK=1` (or `DIFFCI_NO_SEND=1`, or `DIFFCI_SHARE_USAGE=0`) in
  the environment. Air-gapped and policy-restricted environments should set one of these.
- `--no-send` stops report uploads to DiffCI Cloud only; it does not stop the count.

Earlier saved choices carry over: `off` and `anonymous` become `count-only` (they never shared a name),
and `installations` becomes `repo`.

## How the data is used

Counts and repository names are stored by DiffCI to measure adoption: how many repositories use
DiffCI, through which surface, and how often plans are selective. They are not sold or shared. To
have a repository's records deleted, open an issue at https://github.com/DiffCI/core/issues.
