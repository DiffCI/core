# Usage counting

The `diffci` CLI (`@diffci.com/diffci`) counts its runs so the project can see how many repositories
use DiffCI. It is on by default. The Core engine on its own (`node dist/cli.js plan`, `@diffci.com/core`)
sends nothing.

## What is sent

One small HTTPS request to `https://app.diffci.com/v1/usage-events` after each `plan`, `check`,
`observe` and `verify` run (including runs from the GitHub Action, the GitLab component, the Azure DevOps task and the MCP
server), and one when an agent client starts and initializes the local MCP server (CLI 0.3.65+). It contains:

| Field | Example | Notes |
| --- | --- | --- |
| `command` | `plan` | `plan`, `check`, `observe`, `verify`, or `mcp` for an MCP server start |
| `outcome` | `selective` | for example `selective`, `full`, `passed`, `failed`, `observed`, `error`; `started` for `mcp` |
| `version` | `0.3.30` | CLI version |
| `surface` | `github-action` | `cli`, `local-mcp`, `github-action`, `gitlab-component` or `azure-devops-task` |
| `ci` | `true` | whether the run happened in CI |
| `activity` | `external` | `internal` when labelled with `--internal-usage` or `DIFFCI_USAGE_INTERNAL=1` |
| `installation_id` | random UUID | sent only after `diffci telemetry --mode repo` creates and saves one in `~/.diffci/telemetry.json`; a default, never-configured installation sends none; not tied to a person |
| `repository` | `github.com/acme/widgets` | host/owner/repo, from `GITHUB_REPOSITORY`, GitLab CI variables or the `origin` remote, with credentials removed |
| `mode` | `selective` | `selective` or `full`: whether the run chose a subset of the tests; sent only when tests were found |
| `tests_selected` | `3` | number of test files the run chose (0 when the change needed none) |
| `tests_total` | `40` | number of test files the full test command runs |
| `baseline_tests_selected` | `12` | `observe` and `check` only: number of test files a simple path-rule CI would have run, the comparator DiffCI's savings are measured against |
| `failed_before` | `2` | local `verify` only, outside CI: how many earlier `verify` runs on the same base commit failed since it last passed (within a day), read from the outcome log in `.git/diffci/`; sent on a failed run, and on a passed run that followed failures |
| `client` | `claude-code` | `mcp` only: the agent application's self-reported MCP client name (`clientInfo.name`), lower-cased and at most 48 characters; it names the application, not a person or machine |
| `fix_seconds` | `420` | local `verify` only, on a pass that followed failures: seconds from the first of those failures to the pass (at most one day) |

The MCP server counts its own in-process `diffci_select_tests` and `diffci_explain_selection` plans as `plan` runs (surface
`local-mcp`, CLI 0.3.65+); its other tools start the CLI, which counts them as before.

The test fields are counts only (added in CLI 0.3.61); they let the project see whether DiffCI would have
saved work in a repository that only runs `observe`. The streak fields are counts only too (added in CLI 0.3.62): a failed
`verify` followed by a passing one on the same base is a broken change fixed before push, and these two
numbers let the project count those without sending the base commit or anything that identifies the change. It never contains source code, file paths, commit SHAs,
branch names, test names, reports, IP-based
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
- Runs under Node's test runner (`NODE_TEST_CONTEXT` set, as in DiffCI's own test suite and the CLIs it starts)
  are never counted.

Earlier saved choices carry over: `off` and `anonymous` become `count-only` (they never shared a name),
and `installations` becomes `repo`.

## How the data is used

Counts and repository names are stored by DiffCI to measure adoption: how many repositories use
DiffCI, through which surface, how often plans are selective and how many tests they would skip. They are not sold or shared. To
have a repository's records deleted, open an issue at https://github.com/DiffCI/core/issues.
