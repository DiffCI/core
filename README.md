# DiffCI Core

**An open-source engine for understanding changes and planning less CI work conservatively.** Licensed under AGPL-3.0-only.

This is the standalone Core engine. It analyzes local JavaScript/TypeScript repositories, supported Vue components and root Go modules, traces dependency impact, infers GitHub Actions structure and proposes test selections with evidence and full-run fallbacks. It works without a DiffCI account, hosted service or API key. See [the release boundary](docs/release-boundary.md) for support limits.

## Run locally

Requires Git and Node.js 22.5 or later.

```sh
git clone https://github.com/DiffCI/core.git
cd core
npm ci
npm run build
npm test
node dist/cli.js plan --repo /path/to/clean-checkout --base HEAD~1 --head HEAD
```

The target must be a clean Git repository root checked out at `--head`. Fetch the base commit beforehand if using a shallow clone. JSON goes to stdout; analysis errors exit nonzero and recommend full CI. Core does not execute repository scripts, contact a DiffCI backend or send telemetry. Installation requires the npm registry.

**Plans are advisory.** This release does not execute, skip or cancel CI jobs. `SKIP_CANDIDATE` is a candidate, not permission to bypass a check. Keep full CI authoritative while evaluating Core. Missing command synthesis, unsupported configuration and incomplete evidence must not be treated as an empty test suite. Static analysis is not proof that a test can safely be omitted.

## What is included

| Area | Implementation |
| --- | --- |
| Changes and dependencies | Git deltas, repository inventory, JS/TS dependency graph, impact traversal |
| Safety and planning | Risk signals, conservative fallback, always-run policy, test selection and command synthesis |
| CI analysis | GitHub Actions evidence, job/reference graphs, conditions and matrix inference |
| Reproducible evaluation | Synthetic benchmark and portable regression tests |
| Measurement | Current-process wall time, CPU time and ending RSS; explicit-input cost/energy/carbon estimates |

The library entry point exports `analyzeCheckout`, `buildDependencyGraph`, `ImpactAnalyzer`, `DefaultCIPlanner`, `collectEvidence`, `inferPipeline`, `measure` and `estimateImpact`. Lower-level modules are available as package subpaths. The package is published as [`@diffci.com/core`](https://www.npmjs.com/package/@diffci.com/core). DiffCI also publishes [the separate `@diffci.com/diffci` CLI](https://www.npmjs.com/package/@diffci.com/diffci) from [DiffCI/DiffCI.com](https://github.com/DiffCI/DiffCI.com). See [the package relationship](https://github.com/DiffCI/DiffCI.com/blob/main/docs/package-relationship.md) for the CLI migration path.

```sh
npm run typecheck
npm run audit:boundary
npm run benchmark
```

The benchmark constructs 100 modules and 100 tests locally, then measures three graph builds. It does not measure CI savings. Carbon and energy outputs are modeled estimates using caller-supplied assumptions, not physical measurements or verified avoided emissions.

## Core and Cloud

| Component | Availability | License |
| --- | --- | --- |
| This Core repository | Public source | AGPL-3.0-only |
| DiffCI Cloud: hosting, billing, organization management, dashboard, managed services | Private source | Proprietary; not included here |
| Optional enterprise modules | Not released here | A separate source-available license would apply if offered |

Only the explicitly extracted Core files and standalone tooling are in this repository. There is no private monorepo history, customer data, deployment configuration or Cloud implementation here. Core is usable independently; it is not a promise that the private product has already migrated to consume this package.

## License and contributions

See [LICENSE](LICENSE), [NOTICE](NOTICE) and [CONTRIBUTING.md](CONTRIBUTING.md). AGPL permits commercial use; it is not a non-commercial license. Its obligations, including those applicable to modified versions used over a network, are defined by the license. Grant eligibility depends on the particular grant agreement. No eligibility or legal separation is guaranteed by this repository layout.

See [the release boundary](docs/release-boundary.md) for scope and current limitations.
