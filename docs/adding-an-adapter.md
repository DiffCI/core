# Add a repository adapter

Begin with `src/repo/adapters/types.ts`, then read `vue.ts`, `go.ts`, or `maven.ts` and their cases in `tests/repo/language-adapters.test.ts`. Propose the supported configuration in an issue before building a large adapter.

1. Add `src/repo/adapters/<name>.ts` implementing `RepositoryAdapter`: stable `id` and `version`, `kind`, `detect(context)`, and `analyze(context)`.
2. Start the result with `contribution(adapter)`. Return original source identities, test files, dependency edges, and virtual sources only where the existing TS resolver can understand them. Use `testPackages` for package ownership. Do not invent an empty successful graph when parsing or resolution fails.
3. Record unresolved or unsupported configurations in `blockers` (global) or `fileBlockers` only where the uncertainty is confined to a known file. Missing edges cannot be dismissed by reachability.
4. Register the adapter in `REPOSITORY_ADAPTERS` in `src/repo/adapters/index.ts`. Verify detection does not claim unrelated repositories.
5. Add synthetic fixtures for a direct dependency, transitive dependency, unrelated change, and unsupported syntax. Assert affected tests and fallback behavior. Follow the existing `fixture()` helper and `try/finally` cleanup in `tests/repo/language-adapters.test.ts`.
6. Check command synthesis in `src/planner/test-command.ts`. An advisory graph without a runnable command must remain advisory. Add command coverage tests for the runner options you support.

Run the checks in `CONTRIBUTING.md`. Include exact support boundaries and fallback cases in the PR. A new language is usually larger than a first contribution; one regression fixture is a better starting point.
