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
104 pushes then failed the repository's gates in CI. One command sets up
everything below:

```sh
npx "@diffci.com/diffci@latest" init
```

Besides the instruction files, it registers the DiffCI MCP server in `.mcp.json`
(Claude Code) and `.cursor/mcp.json` (Cursor), keeping any other servers there,
writes the `diffci-verify` skill to `.claude/skills/diffci-verify/SKILL.md`,
adds agent stop hooks, and installs the pre-push hook. Commit the config, hook and
skill files so every agent session in the repository finds them. `--no-mcp`,
`--no-skill`, `--no-agent-hooks` and `--no-hook` leave each part out. Four things
make DiffCI the default:

1. **Verify when the agent finishes a turn.** `init` adds a stop hook that runs
   `diffci agent-stop` to `.claude/settings.json` (Claude Code), `.codex/hooks.json`
   (Codex) and `.cursor/hooks.json` (Cursor), keeping every other hook there. When
   the agent ends a turn, DiffCI verifies the uncommitted changes. If tests or
   checks fail, the agent is asked to keep working with the failures as the
   reason, at most `DIFFCI_AGENT_HOOK_MAX` times a session (default 3), after which
   the decision is yours. A pass, no changes, or a change DiffCI cannot verify lets
   the agent stop; the last is reported to you, not turned into work for the agent.
   `DIFFCI_AGENT_HOOK=0` turns the hook off. Claude Code runs project hooks only in
   a folder you have trusted, and Codex asks you to review new hooks with `/hooks`
   before they run.

2. **A pre-push hook**, so every push verifies the commits being pushed whoever
   runs it. It writes `pre-push` into Git's hooks directory (honouring `core.hooksPath`,
   such as `.husky`), never over a hook DiffCI did not write unless you pass
   `--force`. Failing verification blocks the push. If DiffCI cannot verify, for
   example with uncommitted changes, it explains and lets the push through, because
   required CI still runs. `DIFFCI_HOOK_STRICT=1` blocks in that case too, and
   `git push --no-verify` skips the hook once. If your CI cannot run DiffCI (for example when GitHub
   Actions minutes run out and builds move elsewhere), set `DIFFCI_API_URL` and `DIFFCI_TOKEN` in the
   environment you push from: the hook then also sends the observation report for each pushed range.
   Sending never blocks the push.

3. **One exact command from the MCP server.** `diffci_select_tests` now starts with a
   plain line such as `DiffCI selected 3 of 580 test files. Run exactly: <command>`
   before the JSON plan, so the agent runs that command and does not improvise.

4. **Directive instruction files.** `diffci init` writes these lines into a managed
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

### Short snippet

If you only want the essentials, paste these lines instead:

```md
## Testing
Before pushing, run `npx "@diffci.com/diffci@latest" verify --changed --json` and run the checks it lists.
Do not pick test files yourself or run the full suite "to be safe"; DiffCI falls back to the full suite when it must.
Do not commit or push while `safe_to_continue` is false.
```

Where it goes for each agent:

- **Claude Code:** `CLAUDE.md` at the repository root.
- **Codex:** `AGENTS.md` at the repository root.
- **Cursor:** `AGENTS.md`, or a project rule at `.cursor/rules/diffci.mdc` that starts with
  `---`, `description: Run DiffCI before pushing`, `alwaysApply: true`, `---`.
- **GitHub Copilot:** `.github/copilot-instructions.md`.
- **Kiro:** `AGENTS.md` at the repository root, or a steering file (see [Kiro](#kiro)).
- **Antigravity CLI:** `AGENTS.md` at the repository root. **Gemini CLI:** `GEMINI.md`.

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

## GitHub Copilot

Copilot reads project skills from `.github/skills` and from `.claude/skills`, so
the `diffci-verify` skill that `diffci init` writes already reaches Copilot's
cloud agent, Copilot CLI and agent mode in VS Code. Paste the
[short snippet](#short-snippet) into `.github/copilot-instructions.md`.

**VS Code agent mode.** VS Code reads the workspace-root `.mcp.json` that `init`
writes (the `mcpServers` format) when the `chat.mcp.workspaceRootConfig.enabled`
setting is on. Without that setting, add the same server through
**MCP: Add Server**. `.vscode/mcp.json` is the older editor-managed format.

**Copilot cloud agent.** The cloud agent takes its MCP servers from the repository
settings, not from a file. In **Settings > Copilot > MCP servers**, save:

```json
{
  "mcpServers": {
    "diffci": {
      "type": "local",
      "command": "npx",
      "args": ["--yes", "--package", "@diffci.com/diffci@0.3.43", "diffci-mcp"],
      "tools": [
        "diffci_changed_files",
        "diffci_select_tests",
        "diffci_explain_selection",
        "diffci_run_affected_tests",
        "diffci_verify"
      ]
    }
  }
}
```

The agent's runner already has Node.js and `npx`. DiffCI runs the repository's
own tests, so install whatever those tests need in `copilot-setup-steps.yml`,
as you would without DiffCI. The tool list above leaves out `diffci_init` and
`diffci_check` so that the agent cannot rewrite the repository's DiffCI setup.

Copilot has no DiffCI stop hook yet. The instructions and skill are what make
the agent verify.

## Kiro

Kiro reads `AGENTS.md` at the workspace root as steering, so the instructions
that `diffci init` writes already apply. Add the MCP server in
`.kiro/settings/mcp.json`:

```json
{
  "mcpServers": {
    "diffci": {
      "command": "npx",
      "args": ["--yes", "--package", "@diffci.com/diffci@0.3.43", "diffci-mcp"],
      "autoApprove": [
        "diffci_changed_files",
        "diffci_select_tests",
        "diffci_explain_selection"
      ]
    }
  }
}
```

The auto-approved tools only read the checkout. Kiro still asks before
`diffci_run_affected_tests` runs tests; add it to `autoApprove` if you are happy
for the agent to run them unprompted.

Copy the skill into Kiro's workspace skills folder:

```sh
mkdir -p .kiro/skills
cp -r .claude/skills/diffci-verify .kiro/skills/
```

If the repository has no `AGENTS.md`, put the [short snippet](#short-snippet) in
`.kiro/steering/diffci.md` instead, starting with:

```md
---
inclusion: always
---
```

Kiro's custom agents do not load steering on their own. Give them
`"resources": ["file://.kiro/steering/**/*.md", "file://AGENTS.md", "skill://.kiro/skills/*/SKILL.md"]`.
Kiro has Agent Stop hooks, but `diffci agent-stop` does not support Kiro yet.

## Antigravity CLI and Gemini CLI

Antigravity CLI replaced Gemini CLI for free-tier and Google One accounts on
18 June 2026. Gemini CLI still serves the remaining accounts.

**Antigravity CLI** (and the Antigravity IDE) reads workspace MCP servers from
`.agents/mcp_config.json`:

```json
{
  "mcpServers": {
    "diffci": {
      "command": "npx",
      "args": ["--yes", "--package", "@diffci.com/diffci@0.3.43", "diffci-mcp"]
    }
  }
}
```

It reads workspace skills from `.agents/skills`, a folder Codex reads as well:

```sh
mkdir -p .agents/skills
cp -r .claude/skills/diffci-verify .agents/skills/
```

The `AGENTS.md` instructions that `init` writes are read as they are. Restart
the session after you change `mcp_config.json` or a skill.

**Gemini CLI** reads project MCP servers from `.gemini/settings.json`. Use the
same `mcpServers` entry as above, and put the [short snippet](#short-snippet) in
`GEMINI.md`.

On Windows, if a host cannot start `npx` directly, use the launcher from
[`integrations/agent-plugin/mcp.json`](../integrations/agent-plugin/mcp.json)
as the `command` and `args`.

## Grok Build and Grok Connectors

Grok Build reads Claude Code marketplaces, plugins, skills, and MCP
configuration, so the Claude Code installation above is the preferred local
path. A direct local MCP setup is also available:

```sh
grok mcp add diffci -- npx --yes --package @diffci.com/diffci@0.3.43 diffci-mcp
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
args: ["--yes", "--package", "@diffci.com/diffci@0.3.43", "diffci-mcp"]
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
