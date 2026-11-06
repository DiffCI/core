# Use DiffCI in your repository

The published [`@diffci.com/diffci` CLI](https://www.npmjs.com/package/@diffci.com/diffci) bundles this Core engine. Run it from the root of an existing Git checkout with Git and Node.js 22.5 or later installed. Both the head commit and its first parent must be available locally.

## Check selection and runtime

```sh
npx @diffci.com/diffci@latest check
```

On Windows PowerShell, quote the package name:

```powershell
npx '@diffci.com/diffci@latest' check
```

`check` analyzes the checkout, infers the repository's full test command, and runs the full and proposed selected commands when safe to compare. It reports measured paired runtime only when both commands pass. Test commands may write generated files into your checkout. DiffCI writes its reports outside the repository and sends nothing by default. Keep existing required CI checks in place.

## Analyze without running tests

```sh
npx @diffci.com/diffci@latest observe --no-send
```

`observe --no-send` reports selected tests, fallback reasons, and command availability without executing the repository's tests or sending a report. It does not establish runtime savings.

## The outcome log, result reuse and test order

Each `verify` run is appended to `.git/diffci/outcomes.jsonl`: the selection and why, the checks, the result, each test file's result and duration, and the failing tests. The file sits inside `.git`, so it is never committed and never sent. `diffci outcomes` summarises it. `--no-log` or `DIFFCI_OUTCOME_LOG=0` skips writing it.

When the log already holds a pass of the exact same tree that covers the current run, `verify` reuses it and runs nothing. The receipt then carries `reused_from`. A pass covers the run when it was made with the same DiffCI and Node.js versions and either ran the full test command or selected every test selected now, and when every gate check the run would execute passed in it with the identical command. Failures are never reused. The tree includes the lockfile but not `node_modules`, so after reinstalling dependencies without changing the lockfile, pass `--no-reuse` (or set `DIFFCI_REUSE=0`) to run everything again. Reuse is off under `--policy enforce`.

The log also orders the selection. Selected test files that failed in earlier runs (recent failures count more) and tests the change itself edited run first, so a failure shows up sooner. Ordering never drops a test, and it applies only when the selected command ends in the selected file paths; `--no-rank` keeps the selection's own order. `--fail-fast` runs those likely failures as a first batch and stops there if one fails, reporting how much of the selection did not run. `diffci outcomes --curve` replays the failing runs in the log, ranking each one only by the runs before it, and shows how much of the test time passes before the first failure, ranked against path order. With fewer than ten failing runs, read it as an early signal.

## Tests the dependency graph cannot see

Some tests reach a file without importing it: a fixture read by name, a directory listed, a module loaded through a framework or a computed path. `diffci coverage` runs your full test command once, with every `node --test` process under a probe and V8 coverage, and keeps, per test file, the files it loaded or read and the directories it listed in `.git/diffci/coverage-map.json`. It never leaves the machine. Rerun it when tests change; an old map only adds tests, it never drops one.

`verify` then also runs the tests that map connects to a changed file when the dependency graph did not select them, with the reason `COVERAGE`, and lists them in the receipt's `coverage_added`. If the selected command cannot take an extra file safely, it runs the full suite instead. The map does not yet replace a full-suite fallback; that waits for a replay showing it misses nothing. Only `node --test` is supported, because Vitest and Jest run many files in one worker. `--no-coverage` or `DIFFCI_COVERAGE=0` ignores the map.

## End-to-end specs and the routes they visit

A Playwright spec reaches your application through a URL, not an import, so the dependency graph alone never connects `page.goto("/blog/hello")` to `app/blog/[slug]/page.tsx`. In a Next.js App Router project, DiffCI reads the literal URLs each spec visits (`page.goto(...)` and `request.get/post/...(...)` in files that import `@playwright/test`) and selects the specs that visit a route an affected page, route handler, layout or middleware serves, with the reason `ROUTE_VISIT`. Dynamic, catch-all and optional catch-all segments match as Next matches them, and route groups and parallel slots are ignored. A spec that visits a URL built at run time, such as `` `/blog/${slug}` ``, is selected whenever any route is affected, and so is every spec when an affected file's route cannot be derived. The Pages Router, intercepting routes and other frameworks' file routes are not modelled yet; their specs are still selected through any imports they have.

## Split a selection across CI jobs

`verify --shard i/N` runs job `i`'s share of the selection in an `N`-job matrix. Every job computes the same selection from the same commits and splits it the same way, so each selected test file runs in exactly one job:

```yaml
jobs:
  verify:
    strategy:
      matrix:
        shard: [1, 2, 3]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - run: npm ci
      - run: npx @diffci.com/diffci@latest verify --base ${{ github.event.pull_request.base.sha }} --head ${{ github.sha }} --shard ${{ matrix.shard }}/3 --timings .diffci/timings.json
```

Without `--timings`, files are split by count. With it, they are split by time: `diffci outcomes --timings > .diffci/timings.json` writes each test file's typical duration from your local outcome log, and every job must read the same copy, for example a committed file. The jobs' own outcome logs are never used for the split, because they differ between jobs. When the change needs the full suite, or the selected command cannot be split, shard 1 runs everything and the other shards pass without running anything. Test-script phases and affected tests outside the full suite also run in shard 1.

## Recover a missing base in a shallow checkout

DiffCI must be able to read both revisions, and the checkout must still be at the requested head. In CI, set `BASE` and `HEAD` to the full commit IDs supplied by the pull-request or merge-request event, then verify them before asking DiffCI for a plan:

```sh
BASE=0123456789abcdef0123456789abcdef01234567
HEAD=89abcdef0123456789abcdef0123456789abcdef

git rev-parse --is-shallow-repository
git rev-parse --verify HEAD

if ! git cat-file -e "$BASE^{commit}" 2>/dev/null; then
  git fetch --no-tags --deepen=100 origin
fi

if ! git cat-file -e "$BASE^{commit}" 2>/dev/null; then
  echo "DiffCI base is still unavailable; run the repository's full CI." >&2
  exit 1
fi

if [ "$(git rev-parse HEAD)" != "$HEAD" ]; then
  echo "The requested head is not checked out; run the repository's full CI." >&2
  exit 1
fi
```

Increase the deepen count or use `git fetch --no-tags --unshallow origin` when the base is farther back. Do not interpret a missing base, a fetch failure, or a head mismatch as an empty or safe selection.

For a built checkout of this Core repository, request the advisory plan with both verified revisions:

```sh
node /path/to/core/dist/cli.js plan \
  --repo "$PWD" \
  --base "$BASE" \
  --head "$HEAD"
```

For the published CLI, pass the same revisions to `check`:

```sh
npx --yes @diffci.com/diffci@latest check \
  --base "$BASE" \
  --head "$HEAD"
```

`plan` is advisory; `check` may execute repository test commands. If either command refuses or errors, run the repository's normal full validation.

## Reproduce a full fallback

This synthetic project has one unsupported dependency shape: `loader.js` chooses an import at runtime, so static analysis cannot enumerate every module the changed loader may reach. The tree is:

```text
package.json
tsconfig.json
src/loader.js
src/value.js
test/loader.test.js
```

Create its base revision in a disposable directory:

```sh
git init -b main diffci-fallback-example
cd diffci-fallback-example
git config user.name "DiffCI Docs"
git config user.email "docs@diffci.com"
mkdir -p src test
cat > package.json <<'JSON'
{
  "name": "diffci-fallback-example",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
JSON
cat > tsconfig.json <<'JSON'
{
  "compilerOptions": {
    "allowJs": true,
    "checkJs": true,
    "noEmit": true
  },
  "include": ["src/**/*.js", "test/**/*.js"]
}
JSON
cat > src/loader.js <<'JS'
export async function load(name) {
  return import(`./${name}.js`);
}
JS
printf 'export const value = 1;\n' > src/value.js
cat > test/loader.test.js <<'JS'
import assert from "node:assert/strict";
import { test } from "node:test";
import { load } from "../src/loader.js";

test("loads a named module", async () => {
  assert.equal((await load("value")).value, 1);
});
JS
git add .
GIT_AUTHOR_DATE=2026-10-04T00:00:00Z GIT_COMMITTER_DATE=2026-10-04T00:00:00Z git commit -m "base fixture"
```

Then make and commit the analyzed change:

```sh
cat > src/loader.js <<'JS'
export async function load(name) {
  const normalized = name.trim();
  return import(`./${normalized}.js`);
}
JS
git add src/loader.js
GIT_AUTHOR_DATE=2026-10-04T00:01:00Z GIT_COMMITTER_DATE=2026-10-04T00:01:00Z git commit -m "normalize module names"
npx --yes @diffci.com/diffci@0.3.2 observe --no-send \
  --base c82c935ca9761a76cc9849d1e3ce3c08cfa99509 \
  --head e1de15d114174f99098beba785e389268ff7e8dc \
  --json
```

The pinned reproduction reports `mode: "FULL"`, `analysisStatus: "FALLBACK"`, no proposed commands, and:

```text
Dependency graph confidence is UNSAFE; full validation required
```

Run `npm test` for this revision. Even though the report lists one selected test out of one discovered test, that count is not a runtime measurement or a savings claim. The computed import could reach modules static analysis did not discover, so only the repository's normal full validation remains authoritative. CLI behavior may evolve after version 0.3.2; keep the pinned version when reproducing this exact output.

## Declare inputs the graph can't see

Some files reach tests without an import: fixtures loaded by name, `.env.test`, a Prisma schema that generates the client, a migration a test applies. DiffCI looks for tests that name such a file and runs the full suite when it finds none. Declare the edge in `diffci.json` (or the `diffci` key in `package.json`) instead:

```json
{
  "inputs": [
    { "files": ["prisma/schema.prisma", "migrations/**"], "tests": ["src/db/**/*.test.ts"] },
    { "files": ["fixtures/**", ".env.test"], "tests": ["tests/integration/**"] }
  ]
}
```

When a changed file matches `files`, every test matching `tests` is selected, with the reason `DECLARED_INPUT`. Declared tests are always added to what the dependency graph selects. For an unknown file, an unread asset or fixture, code under `ops/` outside the graph, a deleted file, and a database or infrastructure definition, a declaration that selects at least one test also replaces the full-suite fallback.

Some changes still run the full suite whatever `inputs` says, because they change how every test runs: test-runner and tool configuration, `package.json` and workspace manifests, lockfiles and CI workflows. So does a declaration whose `tests` match no test file, and so does any edit to `diffci.json` itself, so a change cannot narrow its own selection.

## Interpret the result

- A full-validation fallback means DiffCI could not justify a smaller selection for that change. Run the repository's normal tests.
- A selected command is evidence about the analyzed revision. It does not authorize skipping required CI tests.
- `REFUSED` and `ERROR` mean analysis did not succeed. Use the normal test commands and inspect the reported reason.
- One paired timing is preliminary. Repeat measurements and account for cache and setup costs before claiming savings.

## Fallback reasons

Each reason below is a message `check`, `observe` and `plan` can print when they fall back to the full suite. `…` stands for the part that changes per run, usually a path, package name or count. A reason that comes from a test-runner config or a workspace package starts with that file or package path. **Narrow** says whether a `diffci.json` (or `diffci` key in `package.json`) setting can avoid the fallback. "Fix" means the fallback comes from an invalid setting, and correcting it removes the fallback.

### Repository-wide changes

| Reason | Example change | Narrow |
| --- | --- | --- |
| `Configuration file(s) changed; full validation required` | Edit `vitest.config.ts` or `.babelrc` | No |
| `Dependency manifest changed; full validation required` | Add `peerDependencies` or `engines` to `package.json` | No |
| `Workspace package manifest changed dependencies, scripts or resolution fields: …; full validation required` | Bump a dependency or edit `scripts` or `exports` in `packages/a/package.json` (a `version` bump is narrowed) | No |
| `Lockfile changed; full validation required` | Regenerate `pnpm-lock.yaml` after changing its `settings` | No |
| `CI workflow definition(s) changed; full validation required` | Change a step in `.github/workflows/ci.yml` that runs `npm test` | No |
| `Infrastructure definition(s) changed; full validation required` | Edit a `Dockerfile` or `terraform/main.tf` | Yes: declare it in `inputs` |
| `Database definition(s) changed; full validation required` | Add a file under `migrations/` | Yes: declare it in `inputs` |
| `Language/framework configuration changed: …` | Edit `go.mod` or `pom.xml` | No |
| `Unknown changed file: …` | Change a file type no adapter models, such as `data.bin` read at runtime | Yes: declare it in `inputs` |
| `Infrastructure code … is outside the dependency graph; full validation required` | Edit a script under `ops/` that no test imports | Yes: declare it in `inputs` |
| `Lockfile readers could not be resolved: …; full validation required` | Change `yarn.lock` while repository code reads it in a way DiffCI cannot trace | No |

### Dependencies

| Reason | Example change | Narrow |
| --- | --- | --- |
| `… (…) cannot be traced without repository contents; full validation required` | Bump a dependency when DiffCI is run without access to the checkout's files | No |
| `Yarn lockfile changed and repository imports undeclared dependencies (…); full validation required` | Bump `yarn.lock` while `src/a.js` imports a package not listed in `package.json` | No |
| `pnpm lockfile changed and repository imports undeclared dependencies (…); full validation required` | Bump `pnpm-lock.yaml` while `src/a.js` imports a hoisted package not listed in `package.json` | No |
| `… and no repository source imports it; full validation required` | Bump a devDependency such as `eslint` that only tools load | No |
| `… and the test script runs it; full validation required` | Bump `vitest` when the `test` script runs `vitest` | No |
| `… and … loads it; full validation required` | Bump a Babel plugin that `babel.config.js` loads | No |
| `… and …, which loads it, is outside the dependency graph; full validation required` | Bump a package that a config file outside the graph loads | No |
| `package.json test script now lists …, which does not exist; full validation required` | Add `tests/missing.test.js` to the `test` script without creating it | No |

### Tests and the dependency graph

| Reason | Example change | Narrow |
| --- | --- | --- |
| `Dependency graph confidence is UNSAFE; full validation required` | Any change in a repository that uses `require(name)` with a computed `name` | No |
| `Computed module load in … is outside the dependency graph; full validation required` | `import(\`./locales/${lang}.js\`)` in a changed file's importer | No |
| `Repository declares … but no test files were discovered; full validation required` | `jest` is a dependency but every test lives under a directory DiffCI does not search | No |
| `Changed test selection invariant violated: … directly changed test(s) not selected (…)` | Edit a test file DiffCI could not attach to the suite (an internal error) | No |
| `Deleted test …; legacy coverage/dependents cannot be established safely` | Delete `src/a.test.ts` | No |
| `Deleted source/asset … not present in HEAD dependency graph; legacy dependents cannot be determined` | Delete `src/legacy.ts` | Yes: declare it in `inputs` |
| `Declared input … selects no tests; full validation required` | `inputs` names the changed file, but its `tests` globs match no test file | Fix: point `tests` at existing tests |
| `Invalid inputs: each entry needs non-empty files and tests glob lists` | `"inputs": [{ "files": ["fixtures/**"] }]` | Fix: give every entry `files` and `tests` |
| `Invalid importer TypeScript configuration: …` | Break the JSON in `tsconfig.json` | No |
| `Unsupported … …; root-relative test discovery requires full validation` | Set `root: "./src"` in `vitest.config.ts` or `rootDir` in `jest.config.js` | No |
| `Multiple runner configurations require completely understood explicit test includes; full validation required` | Keep both `vitest.config.ts` and `jest.config.js` without explicit `include`/`testMatch` | No |
| `Unmodeled languages alongside an adapter require full validation` | Add Python files to a Go repository | No |
| `Mixed Go/JavaScript repositories require explicit cross-language dependencies; full validation required` | A repository with both `go.mod` and `package.json` tests | No |

### Go

| Reason | Example change | Narrow |
| --- | --- | --- |
| `Go support requires one root go.mod; workspaces and nested modules require full validation` | Add `tools/go.mod` | Yes: `"go": { "scope": "root-module" }` |
| `Go root-module scope with local replacements requires full validation` | `replace example.com/x => ./x` with `go.scope` set | No |
| `Changes in a Go module outside the declared root-module scope require full validation` | Edit `tools/main.go` with `go.scope` set | No |
| `Go metadata unavailable: install Go and repository dependencies before analysis (go list must succeed offline)` | Run without Go installed or without downloaded modules | No |
| `Go custom build flags or incomplete build context require full validation` | Set `GOFLAGS=-tags=integration` | No |
| `Go local module replacement lies outside the repository` | `replace example.com/x => ../x` | No |
| `Go package metadata contains errors` | A package that does not compile | No |
| `Go package contains files outside the repository` | A symlinked package directory | No |
| `Go embedded file escapes repository` | `//go:embed` of a symlink to a file outside the checkout | No |
| `Go analysis found no local packages` | A `go.mod` with no `.go` files | No |
| `Go files outside the active build context require full validation: …` | Edit `x_windows.go` while analysing on Linux | No |
| `Go …: cgo dependencies require full validation` | `import "C"` in a package | No |
| `Go …: native assembly/object dependencies require full validation` | Add `x_amd64.s` | No |
| `Go …: runtime plugins require full validation` | `import "plugin"` | No |
| `Go …: generated or linked dependencies require full validation` | A `//go:generate` or `//go:linkname` directive | No |
| `Go runtime inputs outside source/embed metadata require full validation: …` | Edit `config.yaml` beside a Go package that a test opens | No |
| `Changes in Go discovery-excluded paths require full validation, including runtime test data` | Edit `testdata/input.json` or a file under a `_`-prefixed directory | No |

### Maven

| Reason | Example change | Narrow |
| --- | --- | --- |
| `Invalid Maven lifecycle goal or profiles` | `"maven": { "goal": "install" }` | Fix: use `test` or `verify` |
| `Maven analysis found no pom.xml` | A Java repository built with another tool | No |
| `Maven reactor contains no Java sources` | A `pom.xml` with only resources | No |
| `Maven …: custom source roots require full validation` | Set `<sourceDirectory>` in `pom.xml` | No |
| `Maven …: parent dependency inheritance requires full validation` | Inherit dependencies from an external parent POM | No |
| `Maven …: unresolved dependency coordinates require full validation` | Use a `${property}` version DiffCI cannot resolve | No |

### Vue

These appear only for Vue and Nuxt repositories, most of them only after `vue` is set in `diffci.json`.

| Reason | Example change | Narrow |
| --- | --- | --- |
| `Invalid Vue package/suite scope` | `"vue": { "packageRoot": "../web" }` | Fix: a package-relative path and `vitest.config.*` |
| `Nuxt implicit routes and auto-imports require a dedicated framework adapter` | Any change in a Nuxt app | No |
| `Changes outside the declared Vue package require full validation` | Edit `server/` when `vue.packageRoot` is `web` | No |
| `Vue suite configuration or shared setup dependency changed; full validation required` | Edit `web/vitest.setup.ts` | No |
| `Vue dependency crosses the declared package boundary: … -> …` | `web/` imports `../shared/x.ts` | No |
| `Vue asset or macro dependency crosses the declared package boundary` | A component loads an asset from outside `web/` | No |
| `Resolved implementation cannot be included in the scoped source inventory: …` | An alias resolves to a file DiffCI cannot read | No |
| `Unresolved Vue dependencies require full validation` | `import X from "@/missing.vue"` | No |
| `Unresolved dependencies in the declared Vue suite require full validation` | The same, with `vue` set | No |
| `Triple-slash file references in the scoped suite require full validation: …` | `/// <reference path="./globals.d.ts" />` in the suite | No |
| `Vue …: component parse failed` | A `.vue` file with invalid markup | No |
| `Vue …: custom blocks require a framework plugin` | An `<i18n>` block | No |
| `Vue …: external SFC blocks are not yet modeled` | `<script src="./x.ts">` | No |
| `Vue …: glob imports require bundler dependency expansion` | `import.meta.glob("./pages/*.vue")` | No |
| `Vue …: template compilation failed` | A template the compiler rejects | No |
| `Vue …: runtime component/directive resolution requires full validation` | A globally registered component used without an import | No |
| `Vue …: external or preprocessed template requires full validation` | `<template lang="pug">` | No |
| `Vue …: style imports or URLs require full validation` | `@import "./theme.css"` in `<style>` | No |
| `Vue scope requires a literal default Vitest configuration` | `export default defineConfig(async () => …)` | No |
| `Vue scoped config contains unmodeled configuration composition` | `mergeConfig(base, …)` in the suite's config | No |
| `Vue scoped Vitest config has an unsupported plugin or config helper` | Add a plugin other than `@vitejs/plugin-vue` | No |
| `Vue scope supports only the default Vue compiler plugin` | Pass options to `vue()` | No |
| `Vue scoped Vitest config overrides its package boundary` | Set `root` or `dir` in the suite's config | No |
| `Vue scoped setup paths must be literal package-local files` | `setupFiles: [process.env.SETUP]` | No |
| `Vue scoped setup path escapes or is missing from the package` | `setupFiles: ["../setup.ts"]` | No |
| `Vue typecheck configuration must be literal` | `typecheck: options` | No |
| `Vue typecheck configuration is not fully modeled` | Set `typecheck.checker` | No |
| `Vue typecheck enabled flag must be literal` | `typecheck: { enabled: isCI }` | No |
| `Custom Vue type-test discovery requires full validation` | Set `typecheck.include` | No |
| `Enabled Vue type checking has no discovered type suites` | `typecheck: { enabled: true }` with no `*.test-d.ts` files | No |

### Path-baseline comparison

Core's path-rule baseline planners (`src/planner/path-baseline.ts` and `src/research/baseline/`) are used to compare DiffCI against simple path rules. Their reasons describe that comparison, not DiffCI's own plan.

| Reason | Example change | Narrow |
| --- | --- | --- |
| `config/dependency change triggers full fallback` | Edit `package.json` | No |
| `workflow change triggers full fallback` | Edit `.github/workflows/ci.yml` | No |
| `database change triggers full fallback` | Add a migration | No |
| `infrastructure change triggers full fallback` | Edit a `Dockerfile` | No |
| `unscopable changed paths` | Edit a file at the repository root | No |
| `scoping produced an empty selection` | Edit `src/x/a.ts` when no test lives under `src/x` | No |
| `config/dependency/workflow/infrastructure/database change triggers full fallback` | Any of the above (research baseline) | No |
| `no matching path rules` | A change no path rule covers (research baseline) | No |

`npm test` checks that every reason in `src/` is listed here (`node scripts/fallback-reasons.mjs` prints them).

For supported languages and setup limits, see [What is included](../README.md#what-is-included). For the published CLI and source boundary, see [the release boundary](release-boundary.md#published-cli-source-archive).
