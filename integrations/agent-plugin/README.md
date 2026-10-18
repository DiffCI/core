# DiffCI coding-agent plugin

This public package makes DiffCI available to Codex, Claude Code, Cursor, and
other Agent Plugin-compatible clients. It launches the published DiffCI CLI as
a local stdio MCP server, so the agent can inspect the checkout selected by the
client and run conservative affected-test or full-fallback verification.

The package intentionally contains only public plugin metadata, skills, and a
pinned launcher. The CLI itself is installed from npm at the exact version in
`mcp.json`. The launcher handles the Windows `npx.cmd` shim as well as POSIX
shells, so it can be started directly by native MCP hosts.

## Install from this marketplace

Codex:

```bash
codex plugin marketplace add DiffCI/core
codex plugin add diffci@diffci-local
```

Claude Code:

```bash
claude plugin marketplace add DiffCI/core
claude plugin install diffci@diffci-marketplace
```

Cursor uses the repository-root `.cursor-plugin/marketplace.json` for public
Marketplace review. Before that listing is approved, add the local server in
[`mcp.json`](mcp.json) to the repository you want to verify. Setup guidance is
available at https://diffci.com/mcp-server.

The hosted DiffCI MCP endpoint is intentionally read-only. Use this local
plugin whenever a coding agent must inspect a checkout or execute tests.
