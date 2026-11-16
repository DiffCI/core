# How many red builds could a check before the push have prevented?

```sh
npx @diffci.com/diffci@latest red-builds owner/repo
```

`diffci red-builds` reads a repository's recent pull request runs on GitHub Actions and sorts every red one by
what made it red. It runs nothing and needs no checkout: only a GitHub token (`GITHUB_TOKEN`, `GH_TOKEN`, or a
signed-in `gh` CLI), because unauthenticated access allows 60 calls an hour.

## What it reads

1. The most recent pull request runs (`--runs`, default 200) of one workflow: by default the one that looks like the main
   pull request CI (most wall-clock time in a sample of 100 runs, favouring generic CI names like "PR Checks" or
   "Unit Tests" and discounting scanners, previews, benchmarks, E2E, performance, cleanup, link-check, review and
   bot workflows, and GitHub Agentic Workflows (`*.lock.yml`), which run AI agents rather than tests; time a
   run spent waiting for approval doesn't count). The report names it. If nothing in the sample looks like CI, it
   stops and suggests likely workflows instead of guessing. Pass `--workflow <id or file name>` to choose another.
   Many large projects run their main CI outside GitHub Actions (Azure Pipelines, for example); for those the
   result describes a side workflow, so check the workflow it names.
2. The job list of the latest attempt of each red run.
3. The failure annotations of each failing check job: the file and message your linter, type checker or test
   reporter attached.
4. For the runs it judges preventable, the head commit message, to spot coding-agent co-author trailers
   (`Co-Authored-By: Claude …`, Codex, Cursor, Copilot, Devin and others) or agent branch prefixes.

Calls are made one at a time, at least 1.2 seconds apart. It stops on `Retry-After` or when fewer than 1,000
calls remain in your hour, and reports what it read so far. A dropped connection or a GitHub 5xx is retried four
times over about three and a half minutes; if it persists, the command stops the same way instead of losing the run. A 200-run report usually takes 100 to 300 calls.

## How a red run is judged

Each failing job is one of:

| Job | Meaning |
| --- | --- |
| **check** | Lint, formatting, typecheck, build, unit or integration tests: something you can run before pushing |
| **CI-only** | E2E, browser, deploy, release, lockfile, size, security and similar jobs, and any job whose name matches neither list |
| **infra** | Only setup, install, cache or checkout steps failed, or no step failed at all (cancelled, timed out) |

A failing check job is the PR's **own** failure when none of its annotation signatures also failed on a different
pull request in the window. A signature is the annotated file plus the first message line, with numbers and hashes
blurred. A failure seen on several PRs is **shared**: a broken base branch, or a test failing for everyone. A
check job that leaves no annotations but fails on at least half of the window's pull requests (and at least five)
is shared too: it is broken for everyone, whatever each change did.

| Verdict | Meaning |
| --- | --- |
| **Preventable** | Every failing job is the PR's own check failure |
| **Partly** | An own check failure, next to a CI-only or shared failure |
| **Likely** | Check jobs failed but left no annotations, so whose failure it was is unconfirmed |
| **Shared** | The check failures also failed on other PRs |
| **CI-only** | Only jobs a local check doesn't run failed |
| **Flaky** | The same head commit later passed in the same workflow |
| **Infra** | Nothing but setup or cancellation |

A run GitHub marks failed although no job started (zero jobs, or every job skipped) is not counted as red at
all: the workflow failed to start, often on a fork's pull request, so nothing about the change was checked. The
report counts these runs separately as never started.

Job names decide the first table. A job named only by its matrix ("JavaScript (Node.js 24) 1/4") takes its
workflow's kind when the workflow is plainly a local check (unit tests, lint, typecheck, static analysis); in a
workflow called "CI" it stays CI-only. Gate jobs that only report other jobs' results ("all checks passed",
"Unit Tests - Status Check", "require-all-checks-to-pass") are ignored when another job failed. If your repository names its jobs differently, override the lists with
`--check-jobs '<regex>'` and `--ci-only-jobs '<regex>'` (case-insensitive, matched against the job name).

## Reading the result

- **Every number is an upper bound.** It assumes the author ran the check before pushing and that the check
  covered the failing test. CI history can't show either.
- **It is a sample, not a trend.** Busy repositories cover a few hours with 200 runs; quiet ones cover weeks.
- **Most red builds are not preventable this way.** In the two studies this command is built from, 15% of
  Paperclip's red PR runs and 5% of Sentry's were. Broken base branches, E2E jobs and flaky tests make up much of
  the rest; a check before the push can't fix those.

`--json <file>` writes the full report: every red run's verdict, failing jobs and runner-minutes. It contains no
branch names, user names or commit messages.

## Coding-agent branches

When any pull request branch in the window starts with a coding agent's name (`copilot/`, `claude/`, `codex/`,
`cursor/`, `devin/`, `jules/`, or the same followed by `-`), the report adds a table that splits pull request
runs, red runs and preventable runs by that agent, with every other branch under "other branches". The JSON has
the same split in `byBranchAgent` and names the agent on each red run as `branchAgent`. It records the agent,
never the branch name.

Red rates are a share of the runs that ran. Runs waiting for a maintainer's approval (`action_required`),
skipped, still running, or failed before any job started are left out of the denominator. This matters for
agents: on one sample page of dotnet/efcore, 9 of 12 Copilot runs were waiting for approval, which would
otherwise have made Copilot's red rate look far lower.

Every run in the window still feeds the shared-failure check, so a Copilot failure that also broke other pull
requests counts as shared, not preventable. To get more agent runs, raise `--runs` (up to 1,000) rather than
filtering the window down to one agent. Agents that push to ordinary branch names count under "other branches",
so the agent figures are a lower bound on agent activity.

## Where DiffCI comes in

DiffCI runs the affected tests and checks of a change inside your coding agent's loop, before it pushes:
`npx @diffci.com/diffci@latest init` sets up the pre-push hook, agent stop hooks and MCP server. This command
measures how often that would have mattered for your repository.
