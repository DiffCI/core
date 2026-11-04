# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Don't open a public issue, pull request or discussion for a suspected vulnerability.

Include the affected version (`diffci --version`), the command or Action input that triggers it, and a minimal reproduction. A synthetic repository is enough; don't send customer source, credentials or private logs.

## What to expect

- An acknowledgement within 3 working days.
- An assessment and a plan within 10 working days.
- A fixed release within 30 days for confirmed high or critical issues, sooner when it is actively exploited. You're credited in the advisory unless you ask not to be.

DiffCI Core is maintained by one person, so these are targets, not a contractual SLA.

## Supported versions

Only the latest published release of `@diffci.com/diffci` and the matching `DiffCI/core` Action tag receive security fixes. Upgrade to the latest release before reporting.

## Scope

In scope: the CLI, the MCP server, the GitHub Action, the agent plugins and the engine in this repository. Of particular interest:

- a plan or verification that skips work without saying so (Core must fall back to the full suite when evidence is missing);
- command injection through repository contents, file names, workflow files or Action inputs;
- the CLI or MCP server sending data anywhere without an explicit opt-in;
- integrity of published packages and release artifacts.

Out of scope: DiffCI Cloud and diffci.com (report those to the same channel; they're handled separately), and vulnerabilities in a repository that DiffCI merely runs the tests of.

## How releases are protected

Packages are published from GitHub Actions with npm provenance. Third-party Actions in this repository's workflows are pinned to full commit SHAs.
