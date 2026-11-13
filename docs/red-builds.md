# How many red builds could a check before the push have prevented?

```sh
npx @diffci.com/diffci@latest red-builds owner/repo
```

`diffci red-builds` reads a repository's recent pull request runs on GitHub Actions and sorts every red one by
what made it red. It runs nothing and needs no checkout: only a GitHub token (`GITHUB_TOKEN`, `GH_TOKEN`, or a
signed-in `gh` CLI), because unauthenticated access allows 60 calls an hour.

## What it reads

1. The most recent pull request runs (`--runs`, default 200) of one workflow: by default the heaviest one run on
   pull requests (most wall-clock time in a sample of 100 runs), which is the main CI in practice. Pass
   `--workflow <id or file name>` to choose another.
2. The job list of the latest attempt of each red run.
3. The failure annotations of each failing check job: the file and message your linter, type checker or test
   reporter attached.
4. For the runs it judges preventable, the head commit message, to spot coding-agent co-author trailers
   (`Co-Authored-By: Claude …`, Codex, Cursor, Copilot, Devin and others) or agent branch prefixes.

Calls are made one at a time, at least 1.2 seconds apart. It stops on `Retry-After` or when fewer than 1,000
calls remain in your hour, and reports what it read so far. A 200-run report usually takes 100 to 300 calls.

## How a red run is judged

Each failing job is one of:

| Job | Meaning |
| --- | --- |
| **check** | Lint, formatting, typecheck, build, unit or integration tests: something you can run before pushing |
| **CI-only** | E2E, browser, deploy, release, lockfile, size, security and similar jobs, and any job whose name matches neither list |
| **infra** | Only setup, install, cache or checkout steps failed, or no step failed at all (cancelled, timed out) |

A failing check job is the PR's **own** failure when none of its annotation signatures also failed on a different
pull request in the window. A signature is the annotated file plus the first message line, with numbers and hashes
blurred. A failure seen on several PRs is **shared**: a broken base branch, or a test failing for everyone.

| Verdict | Meaning |
| --- | --- |
| **Preventable** | Every failing job is the PR's own check failure |
| **Partly** | An own check failure, next to a CI-only or shared failure |
| **Likely** | Check jobs failed but left no annotations, so whose failure it was is unconfirmed |
| **Shared** | The check failures also failed on other PRs |
| **CI-only** | Only jobs a local check doesn't run failed |
| **Flaky** | The same head commit later passed in the same workflow |
| **Infra** | Nothing but setup or cancellation |

Job names decide the first table. If your repository names its jobs differently, override the lists with
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

## Where DiffCI comes in

DiffCI runs the affected tests and checks of a change inside your coding agent's loop, before it pushes:
`npx @diffci.com/diffci@latest init` sets up the pre-push hook, agent stop hooks and MCP server. This command
measures how often that would have mattered for your repository.
