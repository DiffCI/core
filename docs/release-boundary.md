# Initial public release boundary

The initial extraction includes these engine directories:

- `src/git`: change analysis and repository inventory.
- `src/repo`: discovery, dependency graph and impact/safety analysis.
- `src/repo/adapters`: supported Vue component, root Go module, Maven module and Python (pytest) analysis. Incomplete adapter evidence forces conservative fallback.
- `src/planner`: task registry, test command synthesis and advisory planning.
- `src/ci-inference`: local evidence and GitHub Actions graph inference.
- `src/cache`: local graph cache.
- `src/research/baseline`: portable workflow parsing and baseline task registry.

Standalone additions are `src/analyze.ts`, `src/cli.ts`, `src/index.ts`, `src/measurement.ts`, the synthetic benchmark, release documentation and boundary checks. Tests use synthetic inputs and temporary repositories. Cloud-dependent integration tests and the original product-specific task-registry fixture are excluded.

The following are outside this release: authentication, billing, organizations, dashboard, databases, Shadow enrollment/reconciliation/storage, hosted runners, deployment configurations, operational scripts, website, research datasets and proprietary enterprise code. No Git history from the private repository is copied. The MIT license applies to the files in this public repository, not to every file in the original private repository.

## Limitations

The engine is oriented toward JavaScript/TypeScript, supported Vue components, root Go modules, Maven modules, Python projects tested with pytest, and static GitHub Actions analysis. Dynamic imports/configuration, external actions, conditional behavior and other languages can exceed its coverage. Full-run fallback is conservative but is not a correctness guarantee. Selection and command availability are distinct; a selective plan with `commandSynthesis.status = UNAVAILABLE` cannot be executed as a subset. A task's command text may be a descriptive workflow label rather than a shell command.

Root Yarn Classic v1 lockfile edits can be narrowed for the supported registry format. Classic omits peer relationships and the installed hoisting layout, so a meaningful edit treats every old/new root dependency as potentially affected. This is broader than npm's installed-tree attribution. Exact manifest requests and dependency edges must resolve; undeclared external imports and untraceable tooling retain full validation. Tests that read the lockfile itself are also considered, including for comment-only edits. _Yarn Classic support was contributed by [Emmanuel Mawulolo Tagbor (@KingEmma7)](https://github.com/KingEmma7) in [#63](https://github.com/DiffCI/core/pull/63), [#67](https://github.com/DiffCI/core/pull/67) and [#70](https://github.com/DiffCI/core/pull/70)._

Root pnpm lockfile edits in format 9.0 (pnpm 9 and 10) can be narrowed for single-project repositories. pnpm records each package's resolved edges, peers included, so attribution follows the changed snapshots to the direct dependencies that reach them, as for npm. A change to any top-level lockfile field (`settings`, `overrides`, `patchedDependencies`, catalogs), `link:` or `file:` dependencies, a simultaneous `.npmrc`, `pnpm-workspace.yaml` or `.pnpmfile.cjs` change, and undeclared external imports retain full validation. Tests that read the lockfile itself are also considered.

When a modeled lockfile change accounts for a root `package.json` edit that only changes the requests of existing dependencies, finding no reader of `package.json` itself is accepted; a configuration file tooling loads that names `package.json` still forces full validation. Adding, removing or moving a dependency between fields, or changing any other field alongside, still requires every reader of `package.json` to resolve.

Berry, pnpm lockfile formats before 9.0, workspaces, alternate install layouts, mixed package managers, unsupported requests or fields, malformed lockfiles and incomplete attribution retain full fallback. The engine does not install packages or fetch registry metadata to fill gaps. Existing static import and file-reference limits still apply; required CI remains authoritative.

Go selection models package sources and `go:embed` inputs reported by `go list`. Every changed path outside that metadata requires full validation, regardless of extension or directory, including deleted paths and rename origins. Older cached profiles without this ownership evidence also require full validation. Modeled embeds retain dependency-based selection; other discovery-excluded paths retain full validation, except a plain `<dir>/testdata/` path of a package reported with `_test.go` files, which selects that package's tests - unless code outside the owning package (another reported package's test or ordinary source files, or a test or source module outside the reported Go packages) names the path or its `testdata` directory by reference, a `_`-prefixed or `.`-prefixed directory lies on the way or below `testdata`, or the cached profile predates the package-test evidence. Embedded testdata is a production runtime input and retains full validation. A declared `inputs` entry still adds its tests on top. Arbitrary runtime reads are not inferred from source text. Additional runtime reads of already modeled files by unrelated packages, and external or dynamically supplied inputs, remain outside this model.

Python selection reads file-level imports with Python's own `ast` module, resolved against flat and `src/` layouts, pytest's `pythonpath` and `pyproject` packages, and discovers tests with pytest's `python_files` setting. A changed `conftest.py` selects every test under its directory. Computed imports, unresolved first-party or relative imports, unparseable files, pytest configuration DiffCI cannot read, and changed project files such as `pyproject.toml` or `requirements.txt` retain full validation. Coverage-based and plugin-defined test relationships are not modeled.

The high-level API requires a clean checkout at the requested head. Lower-level APIs expose analysis primitives and leave checkout validation to the caller. Ignored build artifacts and installed dependencies may affect resolution. Analyze only repositories you are authorized to read, preferably in a disposable workspace. Output can contain target file paths and command text; review it before sharing.

`measure` observes the current process, excluding child-process CPU, and reports ending RSS rather than peak memory. `estimateImpact` returns assumptions and explicitly estimated energy/carbon/cost. It does not establish an avoided-compute counterfactual or environmental savings.

The private product may retain its existing engine snapshot while package integration is migrated separately. Separate repositories alone do not determine obligations for combined works. Future externally contributed code must retain its license and cannot automatically be used under proprietary terms.

## Published CLI source archive

The hash-bound corresponding source for the already-published
`@diffci.com/diffci@0.3.10` executable is retained at
[tagged Core commit `4c76be14`](https://github.com/DiffCI/core/tree/4c76be14cec37d94eb7df93922f3c29d202f4e65/packages/diffci-cli)
(`cli-v0.3.10-source`). It contains only the public client/MCP source closure, its build metadata,
and the public Core dependency; it intentionally excludes product services and
operations. See [published CLI source archives](source-archives.md) for the
historical lockfile's HTTPS-only build instructions.

The live `packages/diffci-cli/` directory is the separately reviewed,
Core-native successor package. It is not a rewrite of the historical archive.
