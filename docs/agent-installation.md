# Install DiffCI in coding agents

DiffCI's public distribution source is [DiffCI/core](https://github.com/DiffCI/core).
The separate DiffCI Cloud product source remains private. Every integration below
uses the public CLI package and does not require a DiffCI account or API key.

## Choose the right connection

Use the local stdio MCP server when an agent must inspect a checkout or run
affected tests. It launches the pinned `@diffci.com/diffci` package on the
developer's machine.

`https://diffci.com/mcp/v1` is a hosted, read-only MCP endpoint. It is useful
for cloud clients and discovery, but cannot access a developer's files or run
their tests.

## Make DiffCI the default path

Installing the MCP server makes DiffCI available; it does not make agents use it.
On one dogfood repository, agents ran DiffCI in 24 of over 1,500 test commands.
They picked their own test files 928 times and ran the full suite 282 times, and
104 pushes then failed the repository's gates in CI. Three things change that:

1. **A pre-push hook**, so every push verifies the commits being pushed whoever
   runs it:

   ```sh
   npx "@diffci.com/diffci@latest" init --hook
   ```

   It writes `pre-push` into Git's hooks directory (honouring `core.hooksPath`,
   such as `.husky`), never over a hook DiffCI did not write unless you pass
   `--force`. Failing verification blocks the push. If DiffCI cannot verify, for
   example with uncommitted changes, it explains and lets the push through, because
   required CI still runs. `DIFFCI_HOOK_STRICT=1` blocks in that case too, and
   `git push --no-verify` skips the hook once. If your CI cannot run DiffCI (for example when GitHub
   Actions minutes run out and builds move elsewhere), set `DIFFCI_API_URL` and `DIFFCI_TOKEN` in the
   environment you push from: the hook then also sends the observation report for each pushed range.
   Sending never blocks the push.

2. **One exact command from the MCP server.** `diffci_select_tests` now starts with a
   plain line such as `DiffCI selected 3 of 580 test files. Run exactly: <command>`
   before the JSON plan, so the agent runs that command and does not improvise.

3. **Directive instruction files.** `diffci init` writes these lines into a managed
   section of `AGENTS.md` and `CLAUDE.md`. To add them by hand:

   ```md
   Before every commit, verify with DiffCI instead of choosing tests yourself:

       npx "@diffci.com/diffci@latest" verify --changed --json

   - Do not pick individual test files to run instead; a hand-picked set misses tests
     that depend on your change through imports, fixtures and scripts.
   - Do not run the full test suite to be safe. DiffCI falls back to the full suite
     when it cannot prove a smaller set is enough, and says why in `reason`.
   - When the DiffCI MCP server is available, run the exact `command` that
     `diffci_select_tests` returns.
   - Do not commit or push when `safe_to_continue` is false, and do not bypass the
     pre-push hook with `--no-verify` unless the user asks.
   ```

## Codex

```sh
codex plugin marketplace add DiffCI/core
codex plugin add diffci@diffci-local
```

The package includes the local MCP server and the `diffci-verify` skill. Public
directory discovery is a separate OpenAI plugin-directory submission; the
GitHub marketplace works without it.

## Claude Code

```sh
claude plugin marketplace add DiffCI/core
claude plugin install diffci@diffci-marketplace
```

This installs the same local MCP launcher and skill. The Anthropic directory is
an additional discovery channel; the public Core marketplace is sufficient for
direct installation.

## Cursor

The public marketplace package lives at
[`.cursor-plugin/marketplace.json`](../.cursor-plugin/marketplace.json). While
the Cursor listing is under review, use the local server definition from
[`integrations/agent-plugin/mcp.json`](../integrations/agent-plugin/mcp.json)
in a project `.cursor/mcp.json` or Cursor's global MCP settings.

## Grok Build and Grok Connectors

Grok Build reads Claude Code marketplaces, plugins, skills, and MCP
configuration, so the Claude Code installation above is the preferred local
path. A direct local MCP setup is also available:

```sh
grok mcp add diffci -- npx --yes --package @diffci.com/diffci@0.3.20 diffci-mcp
```

For Grok's cloud connector, add `https://diffci.com/mcp/v1` as a custom HTTP
MCP server. That hosted connection is read-only; use the local server for test
selection or execution.

## Meta Muse Code

Muse receives a native package because its import of the portable Agent Plugin
format does not activate that format's MCP declaration. Install and approve the
local server once:

```sh
muse plugins marketplace add diffci DiffCI/core
muse plugins install diffci@diffci
muse plugins inspect diffci
muse plugins approve diffci
```

Start a new Muse session after approval. Muse starts the local server in the
session workspace, so DiffCI can inspect that checkout. Node.js and `npx` must
be available on `PATH`.

## Other MCP-capable agents

For a local agent, use this stdio command and arguments (or the Windows-safe
launcher in `integrations/agent-plugin/mcp.json`):

```text
command: npx
args: ["--yes", "--package", "@diffci.com/diffci@0.3.20", "diffci-mcp"]
```

For a remote-only client, configure a Streamable HTTP MCP server at
`https://diffci.com/mcp/v1` and keep the read-only limitation in mind.

## Release checklist

For every CLI release, update the native Muse plugin version and its pinned npm
version with the other release metadata. Regenerate the Muse marketplace digest
from the actual package tree rather than constructing a hash yourself. The
release workflow independently verifies that digest before it publishes anything.
With a Muse CLI binary available, run:

```sh
muse skills validate integrations/muse-plugin/skills/diffci-verify
muse plugins validate integrations/muse-plugin --json
MUSE_BIN="$(command -v muse)" npm run agent:muse:sync
npm run agent:muse:check
```

`agent:muse:sync` uses a disposable Muse store, copies the canonical
`installed.package_sha256` into the root
[`marketplace.json`](../marketplace.json), and does not activate the plugin.
Then validate the Git marketplace install in a clean Muse plugin store.
