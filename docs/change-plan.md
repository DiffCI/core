# The change plan (`diffci.gate-plan.v1`)

A change plan is DiffCI's decision for one commit range, written down before anything runs: which of the repository's gate checks run as written, are narrowed to the changed files or are skipped, and which tests are selected, each with a reason. It is the contract between the step that analyses a change and the step that enforces it, and it's open so other tools can produce or consume it.

- Schema: [`schemas/diffci.gate-plan.v1.schema.json`](schemas/diffci.gate-plan.v1.schema.json) (JSON Schema 2020-12)
- Written by `diffci gate --plan-out <file>`, read by `diffci gate --plan <file> --expect-head <sha>`

```json
{
  "schema": "diffci.gate-plan.v1",
  "diffci_version": "0.3.24",
  "range": { "base_sha": "4f1c…", "head_sha": "9a2e…", "source": "push-event" },
  "analysis": { "status": "OBSERVED", "mode": "SELECTIVE", "fallback_reasons": [], "duration_ms": 812 },
  "checks": [
    { "id": "lint", "kind": "lint", "decision": "NARROWED", "command": "npx --no-install eslint src/a.ts", "reason": "…" },
    { "id": "check[2]", "kind": "script", "decision": "SKIP", "command": "node scripts/docs.mjs", "reason": "…" }
  ],
  "tests": {
    "selection": "selected", "reason": "…", "tests_selected": 1, "tests_available": 4,
    "selected_commands": ["node --test src/a.test.js"]
  }
}
```

## Rules for consumers

A consumer that follows these rules never runs less than the repository's own gate would without a recorded reason.

1. **Check the identity.** Use a plan only if `schema` is `diffci.gate-plan.v1` and `range.head_sha` is the commit being gated. Otherwise ignore the plan and run the full gate.
2. **Unknown means run.** If `analysis.status` isn't `OBSERVED`, or `tests.selection` is `unavailable`, run the full test command. Never read a missing or failed analysis as "nothing affected".
3. **Respect the decision, keep the reason.** Run `RUN` checks as written and `NARROWED` checks with their `command`; don't run `SKIP` checks. Record each `reason` wherever you report the result, so every skip can be explained afterwards.
4. **Selected tests replace the full suite only when `selection` is `selected`.** Run `selected_commands` in order. `full` means run the full test command.
5. **Ignore what you don't understand.** Producers may add fields within v1; consumers must ignore unknown fields. Removing or renaming a field, or changing what a value means, requires a new schema name (`diffci.gate-plan.v2`).

## Status

v1 is what DiffCI 0.3.21 and later write. Before Core 1.0 the field set may grow; anything that would break a consumer following the rules above gets a new schema name. Planned additions are an explanation trace (which graph edges selected each test) and build, deploy and promotion decisions.

Other DiffCI receipts, such as `diffci.verification.v1` from `diffci verify` and `diffci.gate.v1` from `diffci gate`, record what ran. They aren't specified here yet.
