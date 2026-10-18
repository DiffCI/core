---
name: diffci-verify
description: Select and verify affected tests after editing code in a local Git repository, using DiffCI MCP tools or the DiffCI CLI before reporting the change ready.
---

Pass the absolute path of the edited repository as `repo` on every tool call.

Use `diffci_changed_files` to inspect staged, unstaged, and non-ignored untracked
changes. Use `diffci_select_tests` or `diffci_explain_selection` when you need the
affected-test plan, command, or reasons for full fallback. These tools run no tests;
their counts describe test files, not passing test cases. A plan is not verification.

Before reporting an edited change ready, call `diffci_run_affected_tests`. It
recomputes the selection and verifies the current snapshot. Accept a passing result
only when `safe_to_continue` is true and `snapshot.unchanged` is true. After further
edits, rerun verification. For a clean committed change, use `diffci_verify` with the
intended base/head range instead; no uncommitted changes does not mean the commit
has been tested.

If MCP is unavailable, use the installed CLI:

```bash
diffci verify --changed --repo /absolute/path/to/repository --json
```

If DiffCI is not installed, use `npx "@diffci.com/diffci@latest" verify --changed`
with the same repo and JSON flags. On blocked analysis or installation failure,
run the repository's normal verification and report the limitation. On a test
failure, fix the cause and rerun. On snapshot changes from generated files, inspect
the files and rerun for that snapshot.

Report executed command, selection scope (affected or full fallback), test-file
counts, outcome, and any outstanding required checks. Never infer passed suites,
test cases, skipped CI jobs, or measured savings from selection counts. Required
project CI stays authoritative.
