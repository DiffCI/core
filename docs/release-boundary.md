# Initial public release boundary

The initial extraction includes these engine directories:

- `src/git`: change analysis and repository inventory.
- `src/repo`: discovery, dependency graph and impact/safety analysis.
- `src/repo/adapters`: supported Vue component and root Go module analysis. Incomplete adapter evidence forces conservative fallback.
- `src/planner`: task registry, test command synthesis and advisory planning.
- `src/ci-inference`: local evidence and GitHub Actions graph inference.
- `src/cache`: local graph cache.
- `src/research/baseline`: portable workflow parsing and baseline task registry.

Standalone additions are `src/analyze.ts`, `src/cli.ts`, `src/index.ts`, `src/measurement.ts`, the synthetic benchmark, release documentation and boundary checks. Tests use synthetic inputs and temporary repositories. Cloud-dependent integration tests and the original product-specific task-registry fixture are excluded.

The following are outside this release: authentication, billing, organizations, dashboard, databases, Shadow enrollment/reconciliation/storage, hosted runners, deployment configurations, operational scripts, website, research datasets and proprietary enterprise code. No Git history from the private repository is copied. The AGPL license applies to the files in this public repository, not to every file in the original private repository.

## Limitations

The engine is oriented toward JavaScript/TypeScript, supported Vue components, root Go modules, and static GitHub Actions analysis. Dynamic imports/configuration, external actions, conditional behavior and other languages can exceed its coverage. Full-run fallback is conservative but is not a correctness guarantee. Selection and command availability are distinct; a selective plan with `commandSynthesis.status = UNAVAILABLE` cannot be executed as a subset. A task's command text may be a descriptive workflow label rather than a shell command.

The high-level API requires a clean checkout at the requested head. Lower-level APIs expose analysis primitives and leave checkout validation to the caller. Ignored build artifacts and installed dependencies may affect resolution. Analyze only repositories you are authorized to read, preferably in a disposable workspace. Output can contain target file paths and command text; review it before sharing.

`measure` observes the current process, excluding child-process CPU, and reports ending RSS rather than peak memory. `estimateImpact` returns assumptions and explicitly estimated energy/carbon/cost. It does not establish an avoided-compute counterfactual or environmental savings.

The private product may retain its existing engine snapshot while package integration is migrated separately. Separate repositories alone do not determine obligations for combined works. Future externally contributed code must retain its license and cannot automatically be used under proprietary terms.
