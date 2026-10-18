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

The `diffci-mcp` binary exposes the same local analysis through MCP. Install the
public Codex, Claude Code, or Cursor plugin metadata from the
[DiffCI Core repository](https://github.com/DiffCI/core/tree/main/integrations/agent-plugin).

## Source and license

This package is AGPL-3.0-only. Its current source lives in
[`DiffCI/core`](https://github.com/DiffCI/core/tree/main/packages/diffci-cli).
The corresponding source for the previously published `0.3.10` package is
preserved at [tagged Core commit `4c76be14`](https://github.com/DiffCI/core/tree/4c76be14cec37d94eb7df93922f3c29d202f4e65/packages/diffci-cli)
(`cli-v0.3.10-source`).
