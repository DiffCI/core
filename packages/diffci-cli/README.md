# DiffCI CLI

`@diffci.com/diffci` provides change-aware CI observation and verification for
coding agents. It analyzes a local Git checkout, conservatively selects affected
tests when evidence is complete, and falls back to a full run when it is not.

```sh
npx --yes @diffci.com/diffci@latest observe --no-send
```

The command writes reports locally and sends nothing unless an explicit
destination is configured. Keep required project CI authoritative.

## MCP for coding agents

The `diffci-mcp` binary exposes the same local analysis through MCP. Install
the public Codex, Claude Code, Cursor, Grok, or Meta Muse Code integration from
the [cross-agent installation guide](https://github.com/DiffCI/core/blob/main/docs/agent-installation.md).

## Compare a selection with full-suite results

```sh
diffci check-plan --plan plan.json --results junit.xml
```

This local command compares a saved Core execution plan with a full-suite JUnit
report from the same revision. Without `--base-results base.xml`, skipped failures
are `possibleMisses`. With a base report, unique matching failures are
`preExisting`; a skipped failure is `missed` only if its matching base testcase
passed. Absent, skipped or ambiguous base identities remain `possibleMisses`. Selected and unattributed failures are also reported. Missed, possible
misses or unattributed failures exit 1; invalid inputs exit 2. Use `--root packages/web`
for a nested reporter root and `--repo /checkout` for absolute paths. Use
`--base-repo /base/checkout` if the base report came from another checkout. Exit 0
describes the comparison, not whether the full suite passed. The command
runs no tests, writes no files and sends nothing.

See the [reporter configuration and scheduled-job example](https://github.com/DiffCI/core/blob/main/docs/using-diffci.md#compare-a-plan-with-a-full-suite-junit-report)
for Vitest and Jest. Use a CLI build containing this command.

## Source and license

This package is MIT-licensed. Its current source lives in
[`DiffCI/core`](https://github.com/DiffCI/core/tree/main/packages/diffci-cli).
The corresponding source for the previously published `0.3.10` package is
preserved at [tagged Core commit `4c76be14`](https://github.com/DiffCI/core/tree/4c76be14cec37d94eb7df93922f3c29d202f4e65/packages/diffci-cli)
(`cli-v0.3.10-source`).
