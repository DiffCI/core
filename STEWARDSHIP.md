# Stewardship

DiffCI Core is MIT-licensed open source, and DiffCI Cloud is a paid hosted product built around it. These are the commitments that keep Core worth depending on. They apply to this repository and to the published `@diffci.com/diffci` package.

1. **Nothing moves out of Core.** A feature released in Core is never removed and re-released as a paid feature.
2. **Correctness stays open.** Everything that decides what a change affects, what is safe to skip and when to fall back to the full suite is in Core. Cloud never has a more accurate engine than the one you can run yourself.
3. **Core works on its own.** The CLI, MCP server, pre-push hook and GitHub Action need no account, API key, hosted endpoint or sales process.
4. **Nothing is sent without opt-in.** Core runs locally and sends nothing by default. Hosted submission is an explicit choice, per run or per workflow.
5. **Safe by default.** Core falls back to the full suite when evidence is missing and says why. The GitHub Action observes by default and has no input that turns skipping on; enforcement is a separate, explicit entry point.
6. **The licence stays permissive.** Core is MIT, and contributions are accepted under MIT with a DCO sign-off, not a CLA. Released versions stay available under the licence they were released with.

## What Cloud sells

Cloud sells what a team or organisation needs and a single developer doesn't: shared history and graph cache, analytics across repositories and agents, merge-gate policy, audit trails, SSO and hosted infrastructure. The rule for placing a feature: if one developer needs it, it belongs in Core.

## When a feature's place is unclear

Open an issue. If a proposed Cloud feature would make Core less correct, less safe or less useful on its own, it goes in Core instead.
