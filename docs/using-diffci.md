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

`check` analyzes the checkout, infers the repository's full test command, and runs the full and proposed selected commands when safe to compare. It reports measured paired runtime only when both commands pass. Test commands may write generated files into your checkout. DiffCI writes its reports outside the repository and uploads none of them by default. It does send a usage count with the repository name ([usage counting](telemetry.md)); `DO_NOT_TRACK=1` stops it. Keep existing required CI checks in place.

## Analyze without running tests

```sh
npx @diffci.com/diffci@latest observe --no-send
```

`observe --no-send` reports selected tests, fallback reasons, and command availability without executing the repository's tests or sending a report. It does not establish runtime savings.

## Watch your changes

```sh
npx @diffci.com/diffci@latest watch
```

`watch` verifies the uncommitted changes after each save, the way `verify --changed` does, so the selection, result reuse, test order and coverage map all apply. A pass prints one line; anything else prints the full summary, failing tests included. It runs tests only; `--checks` adds lint, typecheck and the other checks. Saves made during a run start one more run after it, and files a run writes do not start another. Each run analyses the repository afresh, so it takes as long as `verify --changed`. Agents get the same answer without watching: `diffci init` installs a stop hook that verifies when the agent finishes a turn (see `docs/agent-installation.md`).

## Verify only what you will commit

```sh
git add -- src/lib/auth/identity-errors.ts src/lib/auth/identity-errors.test.ts
npx @diffci.com/diffci@latest verify --staged --json
npx @diffci.com/diffci@latest verify --json --paths src/lib/auth/identity-errors.ts src/lib/auth/identity-errors.test.ts
git diff --name-only | npx @diffci.com/diffci@latest verify --json --paths-from -
```

`verify --changed` verifies every uncommitted file in the checkout. When several people or agent sessions share one checkout and each commits only its own files, that verifies everyone's work in progress, and another session's failing test blocks a correct commit. `verify --staged` verifies HEAD plus the index only; `verify --paths` (or `--paths-from <file|->`, one path per line) verifies HEAD plus only the named working-tree files. Paths are literal, so `app/[slug]/page.tsx` is a file name, not a pattern.

Both check the scoped tree out in a temporary detached worktree of HEAD, link the checkout's `node_modules` directories into it (a junction on Windows), and run the same analysis, gate checks and tests `verify --changed` runs, there. Every other uncommitted file is at its HEAD version for the analysis and at runtime, so it can neither fail nor rescue the result. The receipt has `scope: "staged"` or `"paths"` and a `scoped` section: `verified_files`, `excluded_dirty_files` (a count) and `excluded_dirty_paths` (the first 50; digests under `--redact-paths`). When a verified file imports an excluded file, `scoped.head_version_imports` names both and the reason says the import was verified at its HEAD version. When a root lockfile in the scoped tree differs from the checkout's, the installed dependencies do not match it and verification is blocked (exit 2). The worktree and its links are removed on success, failure, timeout and interruption. If HEAD, the index (for `--staged`) or the named files change during the run, the verdict is blocked.

A pass of `--staged` is recorded for the tree a commit of the index has, so the pre-push hook reuses it when the pushed commit has that tree and nothing runs twice. `verify --changed` prints a hint to stderr when it finds files that are not staged.

## The outcome log, result reuse and test order

Each `verify` run is appended to `.git/diffci/outcomes.jsonl`: the selection and why, the checks, the result, each test file's result and duration, and the failing tests. The file sits inside `.git`, so it is never committed and never sent. `diffci outcomes` summarises it. `--no-log` or `DIFFCI_OUTCOME_LOG=0` skips writing it.

When the log already holds a pass of the exact same tree that covers the current run, `verify` reuses it and runs nothing. The receipt then carries `reused_from`. A pass covers the run when it was made with the same DiffCI and Node.js versions and either ran the full test command or selected every test selected now, and when every gate check the run would execute passed in it with the identical command. Failures are never reused. The tree includes the lockfile but not `node_modules`, so after reinstalling dependencies without changing the lockfile, pass `--no-reuse` (or set `DIFFCI_REUSE=0`) to run everything again. Reuse is off under `--policy enforce`.

One `verify` runs at a time per repository. When several agent sessions share a checkout, a second run waits for the first (it prints whose run it is waiting for), then starts; on the same tree it finds the first run's pass and reuses it, so nothing runs twice. The lock is `.git/diffci/verify.lock`, shared by every worktree; a lock left by a process that is no longer running is removed. After `--queue-timeout-ms` (15 minutes by default) the run goes ahead in parallel. The wait is in the receipt as `queue` and in the log as `queued_ms`, apart from the test time. `--no-queue` or `DIFFCI_QUEUE=0` runs without waiting.

A selected run can cost more than the full suite, for example when it selects slow integration files the test script leaves to another job. When the log has per-file durations, the receipt's `cost` compares the selected files' test time (including affected files outside the full test command, which run in addition to it) with the newest full run's, and this run's wall time with the median full run's. The summary says so plainly when the selection cost more.

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
      - run: npm ci
      - run: npx @diffci.com/diffci@latest verify --base ${{ github.event.pull_request.base.sha }} --head ${{ github.sha }} --shard ${{ matrix.shard }}/3 --timings .diffci/timings.json
```

Without `--timings`, files are split by count. With it, they are split by time: `diffci outcomes --timings > .diffci/timings.json` writes each test file's typical duration from your local outcome log, and every job must read the same copy, for example a committed file. The jobs' own outcome logs are never used for the split, because they differ between jobs. When the change needs the full suite, or the selected command cannot be split, shard 1 runs everything and the other shards pass without running anything. Test-script phases and affected tests outside the full suite also run in shard 1.

## Recover a missing base in a shallow checkout

From v0.3.37, `diffci observe`, `verify` and `check` do this themselves in GitHub Actions and GitLab CI: when the range cannot be resolved and the clone is shallow, they run `git fetch --no-tags --unshallow origin` once, which adds commits and moves no ref, HEAD or file. They never fetch into a local clone. If that fetch fails (for example, a checkout with `persist-credentials: false` on a private repository), the refusal says why and still names `fetch-depth: 0` or `GIT_DEPTH: "0"`. The steps below are for the Core `plan` command and older CLI versions.

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

The published CLI prints the same plan with `diffci plan`:

```sh
npx --yes @diffci.com/diffci@latest plan \
  --repo "$PWD" \
  --base "$BASE" \
  --head "$HEAD"
```

To also measure the selection, pass the same revisions to `check`:

```sh
npx --yes @diffci.com/diffci@latest check \
  --base "$BASE" \
  --head "$HEAD"
```

`plan` is advisory; `check` may execute repository test commands. If either command refuses or errors, run the repository's normal full validation.

## Compare a plan with a full-suite JUnit report

_Contributed by [Emmanuel Mawulolo Tagbor (@KingEmma7)](https://github.com/KingEmma7) in [#74](https://github.com/DiffCI/core/pull/74)._

`check-plan` checks whether a saved selection would have skipped failures in one
supplied full-suite report. It does not run tests, read Git state, write files or
send data. Use a CLI build containing this command; when working from source,
build `packages/diffci-cli` and invoke its `dist-client/src/client/cli.js` with Node.
`diffci plan` and `check-plan` ship in the same package.

Save the advisory Core plan before running the full suite, using the verified
revisions described above:

```sh
RESULTS_DIR=$(mktemp -d)
diffci plan --repo "$PWD" --base "$BASE" --head "$HEAD" > "$RESULTS_DIR/plan.json"
# Configure test:junit to run the normal full suite with a reporter below.
DIFFCI_JUNIT_FILE="$RESULTS_DIR/junit.xml" npm run test:junit
diffci check-plan --plan "$RESULTS_DIR/plan.json" --results "$RESULTS_DIR/junit.xml"
```

The command accepts the JSON output of `diffci plan` or Core's own `plan` command or its nested
`ExecutionPlan` (version `5.0.0`). It requires `mode`, `selectedTests`, `skippedTests`
and `safety.fallbackRequired`; the mode and fallback flag must agree, paths must
be canonical repository-relative paths, and the two lists must not overlap.
Observation reports and verification receipts are different formats.

The JSON result has `schemaVersion: 1`, `mode`, `fullFallback`, a `summary`, and
five arrays of failures, plus `baselineProvided`:

| Group | Meaning |
| --- | --- |
| `missed` | A skipped failure whose unique matching testcase passed in the supplied base report. |
| `possibleMisses` | A skipped failure with no matching base pass, including absent, skipped or ambiguous base identities. |
| `preExisting` | The same testcase failed in the supplied base report. |
| `selected` | The failure maps to a file in `selectedTests`. |
| `unattributed` | The file is missing, unknown or ambiguous; `reason` explains why. |

Exit **1** means at least one missed, possible-miss or unattributed failure. Exit **2** means
invalid arguments, unreadable inputs, an invalid plan or an invalid report; a JSON
error goes to stderr and no comparison goes to stdout. Exit **0** means all three
groups are empty. Selected tests may still have failed: retain the full
test runner's exit status as the authority on suite success.

A `FULL` plan must have no skipped tests. Its result explicitly sets
`fullFallback: true` and has no missed failures. Known failures are selected or pre-existing;
unattributed failures still exit 1, and invalid XML still exits 2.

### Reporter configuration

Run the command from the repository root, or supply `--repo /absolute/checkout`.
Set `--root packages/web` when the reporter writes paths relative to that nested
runner root. Leading `./`, trailing slashes and Windows separators are accepted.
The default is `--root .`; neither root is guessed from report paths.
For example:

```sh
diffci check-plan --plan plan.json --results junit.xml --repo /checkout --root packages/web
```

Testcase `file` takes precedence over inherited suite files. Without it, suite
files are checked, then JS/TS paths in classname or suite names. Conflicting
metadata stays unattributed. Windows separators and leading `./` are normalized;
absolute paths inside the explicit checkout root map to repository-relative paths.
Paths outside it, parent traversal, unknown files, test titles and stack traces
are never matched by suffix. Reports from multiple runner roots must be compared
separately with their corresponding roots.

To distinguish old failures from new ones, pass `--base-results base-junit.xml`:

```sh
diffci check-plan --plan plan.json --results head-junit.xml --base-results base-junit.xml
```

Produce the base report from the plan's base revision using the same full-suite
scope and reporter configuration. If it ran in a separate checkout, supply
`--base-repo /base/checkout`; otherwise its absolute paths use `--repo` too.
Relative file metadata uses the same `--root` for both reports. Base failures
match by mapped file, enclosing suite names, classname and testcase name, only
when that identity occurs once in each report. JS/TS path-valued suite names and
classnames are normalized against their respective checkout roots.

A skipped failure is `missed` only when its unique matching base testcase passed.
Missing, skipped, duplicate or unnamed base identities stay `possibleMisses`.
Unknown files and suite-level errors remain unattributed even if they appear at
base. Renamed tests or changed reporter labels cannot establish a match. The
command cannot verify report provenance, completeness or whether a failure is
flaky; a base pass does not prove that the change caused the head failure.
Without a base report, skipped failures are always `possibleMisses`.

Both `--flag value` and `--flag=value` work. `check-plan --help` prints usage and
exits 0 without reading inputs.

Vitest's default JUnit classname and suite-name conventions normally identify the
file. Explicit file attributes also work with custom labels. For example, merge
this reporter into the project's Vitest configuration:

```js
test: {
  reporters: ['default', ['junit', {
    outputFile: process.env.DIFFCI_JUNIT_FILE ?? 'junit.xml',
    addFileAttribute: true,
  }]],
}
```

For Jest, install and configure `jest-junit`. Its default description labels often
do not identify a file, and its default report can omit test-suite load errors.
Both options below are strings:

```js
reporters: ['default', ['jest-junit', {
  outputFile: process.env.DIFFCI_JUNIT_FILE ?? 'junit.xml',
  addFileAttribute: 'true',
  reportTestSuiteErrors: 'true',
}]],
```

Node's built-in test runner (`node --test`, also through `tsx --test`) needs no
configuration file: its `junit` reporter writes each testcase's absolute `file`, so
supply the checkout with `--repo`. Add the reporters on the command line, or through
`NODE_OPTIONS` to keep the test script unchanged:

```sh
NODE_OPTIONS="--test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=$RESULTS_DIR/junit.xml" npm test
diffci check-plan --plan "$RESULTS_DIR/plan.json" --results "$RESULTS_DIR/junit.xml" --repo "$PWD"
```

- Pass test files or globs. `node --test tests/` runs `tests` as one module rather
  than the files in it, and reports a single failing case that names no test file.
- `NODE_OPTIONS` is split on spaces, so the destination path must not contain any.
- It reaches every Node process the script starts. When the script runs the test
  runner more than once (`a && b`), each run overwrites the same destination: give
  each run its own report and compare each one separately.
- When a root-level hook (`before`/`after` outside any `describe`) fails, Node writes
  the rest of the report inside an `<undefined name="root">` element. `check-plan`
  reads that element directly under `<testsuites>` as a plain container.

Keep generated reports outside the checkout so they do not affect Core's
clean-checkout check. These conventions are covered by reports generated with Vitest 5.1.0, Jest
30.5.2 plus jest-junit 17.0.0, and `node --test` on Node 24.16.0. Custom reporters may need different configuration.
The [synthetic fixture notes](../packages/diffci-cli/tests/client/fixtures/check-plan/README.md)
record their sources and reproduction steps. Go and Maven attribution are outside
this first implementation.

### Scheduled full-suite check

The [scheduled-job example](../examples/github-actions-check-plan.yml) installs
the pinned published CLI outside the checkout, saves a plan for the scheduled checkout, and runs `npm run
test:junit` in full at both the plan's base and head revisions. The base runs in
a separate Git worktree with its own dependencies. Configure `test:junit` to run
the project's normal complete suite with one of the reporters above. Bump
`DIFFCI_CLI_VERSION` only after reviewing a new CLI release.

The comparison receives both reports and their checkout roots, so matching old
failures do not become possible-miss alarms. A failing base suite is valid
comparison evidence. Head full-suite failures remain visible, and the head full
suite also runs when plan creation fails. Missing or invalid reports fail the
comparison; do not substitute an unrelated green run. Both reports, the plan and
the comparison are retained as artifacts.

The plan and head report must describe the same head revision and complete test
scope; the optional base report must describe the plan's base revision. Standard
JUnit does not prove either condition; a passing comparison cannot establish
report completeness or the absence of missed failures beyond the supplied report.
In particular, an error omitted by a reporter cannot be recovered. Each UTF-8 input
is limited to 16 MiB. XML must contain a testcase or a suite-level failure. Suite-level failures/errors
are retained as unattributed evidence alongside ordinary testcase failures. Both
`check-plan` and `enforce-misses` use the same strict XML reader and file mapping.
Enforcement keeps its existing v1 testcase IDs for stored baselines, separately
from file attribution. A suite crash or missing file identity cannot create an
unsafe-miss entry against a pull request. Invalid full-suite reports return exit
2 without writing a miss report; invalid rerun reports leave the original
failures in place and are treated as an unavailable rerun.
Malformed XML, DOCTYPE declarations, namespaced elements, unsupported qualified
metadata, excessive nesting/tags, more than 16 MiB of
accumulated failure metadata and headers claiming
more evidence than the report contains are rejected. Namespace declarations,
`xml:` attributes and schema-location hints
are ignored; they do not provide file identity. Duplicate failed testcases
remain distinct, while multiple failure/error elements within one testcase count
as one failed testcase.

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

## Imports from barrels

A test that imports `{ x }` from a package's `index.ts` depends on every file that barrel re-exports, if you
count files. When the package's `package.json` declares `"sideEffects": false` (or lists only stylesheets), DiffCI
follows the re-exports by name instead and selects only the tests whose imported names reach a changed file.
This is the contract bundlers use to drop unused re-exports. Without it, imports stay whole files.

Some cases stay at file level or broaden the selection:

- A changed barrel, or a changed `export *` source DiffCI had to search for a name, selects every test that imports
  through it.
- Namespace imports (`import * as x`), CommonJS modules and names DiffCI can't find count as the whole module.
- A barrel still loads every module it re-exports, so an error thrown while a changed file loads would fail tests
  that never use it. When no selected test reaches the changed file by name, one of its importers is kept to load it.
- A computed `import(name)` inside a function selects only the tests whose imports reach its module, since only
  those can call it. One that runs when its module loads (at the top level, or in a function invoked at once)
  selects every test that loads the module.
- Type tests are never dropped: `*.test-d.ts`, `*.tst.ts`, and the files tstyche's `testFileMatch` names. Where
  every test may be type-checked as it runs (Jest, ts-jest, `--typecheck`), a type import counts as the whole
  module.

The result's evidence says how many tests each changed file skipped this way.

## Code loaded by a path string

A string that names a code file by path, such as `test.suite('Posts', { config: './config.ts' })`, is a
dependency: DiffCI follows it from the file that holds it, so a change to that config or anything it imports
selects the test.

A computed `import(name)` can load any file, so by default every test that runs it is selected for every code
change. When a repository's computed loads only ever reach files named by such path strings, it can say so:

```json
{ "computedImports": "follow-path-literals" }
```

in `diffci.json`. Those loads then select nothing beyond the path-string dependencies. It is an assumption about
your code, the same one `vitest --changed` makes for every computed import: a load whose path is built at run
time from something else (a directory listing, an environment variable, the working directory) would be missed.

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

The same works for pytest. A test that opens `tests/data/prices.csv` by name has no import edge to it, so a change to the CSV runs the full suite until it is declared:

```json
{
  "inputs": [
    { "files": ["tests/data/**"], "tests": ["tests/test_prices.py"] }
  ]
}
```

When a changed file matches `files`, every test matching `tests` is selected, with the reason `DECLARED_INPUT`. Declared tests are always added to what the dependency graph selects. For an unknown file, an unread asset or fixture, code under `ops/` outside the graph, a deleted file, and a database or infrastructure definition, a declaration that selects at least one test also replaces the full-suite fallback.

Some changes still run the full suite whatever `inputs` says, because they change how every test runs: test-runner and tool configuration, `package.json` and workspace manifests, lockfiles and CI workflows. So does a declaration whose `tests` match no test file, and so does any edit to `diffci.json` itself, so a change cannot narrow its own selection.

## More commands

`diffci --help` lists every command. This section covers four that aren't explained elsewhere: [`verify-workflow`](#verify-workflow-check-how-the-diffci-job-could-affect-ci), [`pilot-packet`](#pilot-packet-a-shareable-compatibility-packet), [`validate-specs`](#validate-specs-block-specifications-that-change-the-same-target) and [`telemetry`](#telemetry-choose-what-usage-counting-sends).

### verify-workflow: check how the DiffCI job could affect CI

```sh
npx @diffci.com/diffci@latest verify-workflow --repo .
```

_The pytest example and the test behind it were contributed by [@sarankumar1325](https://github.com/sarankumar1325) in [#319](https://github.com/DiffCI/core/pull/319)._

`verify-workflow` reads the YAML files in `.github/workflows` and finds the jobs that run the DiffCI action as an observer. It then looks for the ways those jobs could change what the rest of CI does. Each finding has a stable code and is marked `[BLOCKING]` or `[WARNING]`; only blocking findings fail the command, so a pass means no blocking interference was found, not that the warnings are harmless. For example:

- `JOB_IS_A_DEPENDENCY` (blocking): another job `needs:` it.
- `JOB_NOT_CONTINUE_ON_ERROR` (blocking): it doesn't have `continue-on-error: true`, so a DiffCI failure fails the workflow run.
- `JOB_NOT_DEDICATED` (blocking): it shares a job with build or test steps.
- `JOB_HAS_WRITE_PERMISSIONS` (warning): it has a `write` permission.
- `JOB_SHARES_CONCURRENCY_GROUP` (warning): it shares a concurrency group with another job, so one can cancel the other.
- `ACTION_NOT_PINNED` (warning): the action isn't pinned to a 40-character commit SHA.

`check` prints `run diffci verify-workflow for details` when it finds a blocking problem.

```text
Scanned 1 workflow file(s).
DiffCI runs in: .github/workflows/diffci.yml#diffci-observe
  [BLOCKING] JOB_NOT_CONTINUE_ON_ERROR (.github/workflows/diffci.yml#diffci-observe)
      job "diffci-observe" is missing continue-on-error: true - without it a DiffCI failure fails the whole workflow run, which a required status check or merge queue will read as a failed build.

Blocking findings above: as written, this installation CAN change what the rest of CI does.
```

It exits 0 when there are no blocking findings; warnings alone still exit 0. It exits 1 in three cases: there's a blocking finding, there are no workflow files, or no job runs DiffCI as an observer. Jobs that run DiffCI as a gate (`verify`, `check-run` or `fail-on-error`) may fail on purpose, so they aren't counted as observers.

`verify-workflow --enforce [--default-branch main] [--full-command "<cmd>"]` checks the opposite for enforce mode. It confirms three things:

- a job runs `diffci verify --policy enforce` as a gate (a `continue-on-error` dry run doesn't count);
- that job's `DIFFCI_ENFORCE` environment variable is set from `${{ vars.DIFFCI_ENFORCE }}`, so turning the repository variable off stops enforcement (it doesn't check a job-level `if:`, so with the variable off the job may still run, but without enforcing);
- the full test command still runs on every push to the default branch.

It exits 1 if any of these is missing.

Without `--repo` it reads `$GITHUB_WORKSPACE` or the current directory. It only reads the workflow files: it writes nothing and sends nothing.

### pilot-packet: a shareable compatibility packet

```sh
npx @diffci.com/diffci@latest pilot-packet --repo . --base HEAD~1 --head HEAD
```

`pilot-packet` runs the same analysis as `observe` on the range: the CI event range by default, or `--base`/`--head` when given. It runs no tests. It writes three files to `--out-dir`, which defaults to `../diffci-output` next to the checkout:

- `pilot-packet.md`: a Markdown summary to share. It covers the revision, the result and proposed commands, the safety evidence, the workflow findings and a recommended next step.
- `diffci-observe.json`: the raw observation report.
- `diffci-observe.yml`: a non-blocking observation workflow for you to review. It isn't installed.

`--label` names the repository in the packet (default: the checkout's folder name). `--repository-url` adds a link and must be `https://`. `--redact-paths` hashes the file paths in the analysis result. Workflow findings and some fallback details can still name files (such as `.github/workflows/ci.yml`), so read the packet before you share it.

It exits 0 when the observation is `OBSERVED`. It exits 1 when the observation was refused (for example, no supported project was found). It exits 2 when `--out-dir` is inside the checkout or `--repository-url` isn't https. It changes no file in the checkout and sends nothing.

### validate-specs: block specifications that change the same target

```sh
npx @diffci.com/diffci@latest validate-specs --file specs.json
```

`validate-specs` reads a list of change specifications and blocks the list when two of them change the same logical target. For example, two agent tasks in one turn that both edit `/cart`. The file is a JSON array, or an object with a `specifications` array. Each entry needs a non-empty `id` and a `logicalTarget`, which is a string or a list of strings. Targets are compared after trimming whitespace.

```json
{"specifications": [
  {"id": "checkout-coupon", "logicalTarget": ["/checkout", "/cart"]},
  {"id": "cart-redesign", "logicalTarget": "/cart"},
  {"id": "profile-avatar", "logicalTarget": "/settings/profile"}
]}
```

```text
DiffCI specification validation: BLOCKED (1 logical-target conflict)
  logical target "/cart" is changed by specifications cart-redesign, checkout-coupon
```

`--json` prints the `diffci.specConflicts.v1` report instead. The report has `valid`, the counts, `conflicts` and `blockers`.

It exits 0 when there are no conflicts. It exits 1 in two cases: there's a conflict, or the input is invalid (missing `--file`, a file that's neither shape, an entry without an `id` or target, or a duplicate `id`). It only reads the file: it doesn't look at the repository, and it writes and sends nothing.

### telemetry: choose what usage counting sends

```sh
npx @diffci.com/diffci@latest telemetry                     # show the current choice
npx @diffci.com/diffci@latest telemetry --mode count-only   # count runs without the repository name
```

Usage counting is **on by default**. After each `plan`, `check`, `observe` and `verify` run, DiffCI sends a small count. It includes the command, the outcome, the version, where it ran and the repository name (host/owner/repo), plus a random installation ID once one has been saved by `diffci telemetry --mode repo`. It never sends code, paths, commits, test names or reports. [Usage counting](telemetry.md) has the full field list.

- `--mode repo` (default): the count includes the repository name. Running `diffci telemetry --mode repo` also saves a random installation ID, which is sent from then on; the default, never configured, sends none.
- `--mode count-only`: drops the name and deletes the saved installation ID.
- `--internal-usage`: labels your runs as internal (tests, development).

The choice is saved in `~/.diffci/telemetry.json` (or under `$DIFFCI_TELEMETRY_HOME`). Older saved choices carry over: `off` and `anonymous` become `count-only`, and `installations` becomes `repo`. On the command line, `--mode` takes `repo` or `count-only`; the older names are still accepted and mapped the same way, and any other value exits 1.

To stop counting entirely, set `DO_NOT_TRACK=1`, `DIFFCI_NO_SEND=1` or `DIFFCI_SHARE_USAGE=0` in the environment. No flag can stop it. `--no-send` stops only report uploads to DiffCI Cloud, not the count. `diffci telemetry` itself sends nothing and exits 0.

## Interpret the result

- A full-validation fallback means DiffCI could not justify a smaller selection for that change. Run the repository's normal tests.
- A selected command is evidence about the analyzed revision. It does not authorize skipping required CI tests.
- `REFUSED` and `ERROR` mean analysis did not succeed. Use the normal test commands and inspect the reported reason.
- One paired timing is preliminary. Repeat measurements and account for cache and setup costs before claiming savings.

## Fallback reasons

Each reason below is a message `check`, `observe` and `plan` can print when they fall back to the full suite. `…` stands for the part that changes per run, usually a path, package name or count. A reason that comes from a test-runner config or a workspace package starts with that file or package path. **Narrow** says whether a `diffci.json` (or `diffci` key in `package.json`) setting can avoid the fallback. "Fix" means the fallback comes from an invalid setting, and correcting it removes the fallback.

For `Unknown changed file` and `Deleted source/asset`, `observe --json` also returns `fallbackDetails`: for each such file, every reader DiffCI could not resolve, with the files that lead to it (`.github/actions/a/action.yml names scripts/load.sh (via scripts/load.sh)` means the action runs a script that reads the changed file). The human report prints them under `why … is unknown`.

### Repository-wide changes

| Reason | Example change | Narrow |
| --- | --- | --- |
| `Configuration file(s) changed; full validation required` | Edit `vitest.config.ts`, `vitest.workspace.ts`, `babel.config.js` or `.babelrc`, or a package's `packages/web/jest.config.js` | No |
| `Test setup file or a module it imports changed: … (setup from …); full validation required` | Edit a file a Jest or Vitest configuration lists in `setupFiles`, `setupFilesAfterEnv`, `globalSetup`, `globalTeardown`, `testEnvironment` or a similar key, or a module that file imports | No |
| `Test setup files in … could not be read statically, so … may be one; full validation required` | Edit any source file while a runner configuration builds a setup value without a string literal (`setupFiles: files`) | Fix: list setup files as string literals |
| `Dependency manifest changed; full validation required` | Add `peerDependencies` or `engines` to `package.json` | No |
| `Workspace package manifest changed dependencies, scripts or resolution fields: …; full validation required` | Bump a dependency in `packages/a/package.json` while a lockfile governs it, edit its `scripts`, or change `exports` to a `*` pattern (a `version` bump, a dependency bump in a repository that commits no lockfile, and an `exports` remap between files are narrowed) | No |
| `… remaps an export to …, which is outside the dependency graph; full validation required` | Point an `exports` subpath at a file DiffCI does not analyse, such as a `.d.ts` outside every tsconfig | No |
| `Lockfile changed; full validation required` | Regenerate `pnpm-lock.yaml` after changing its `settings` | No |
| `CI workflow definition(s) changed; full validation required` | Change a step in `.github/workflows/ci.yml` that runs `npm test` | No |
| `Infrastructure definition(s) changed; full validation required` | Edit a `Dockerfile` or `terraform/main.tf` | Yes: declare it in `inputs` |
| `Database definition(s) changed; full validation required` | Add a file under `migrations/` | Yes: declare it in `inputs` |
| `Language/framework configuration changed: …` | Edit `go.mod` or `pom.xml` | No |
| `Tool configuration changed: … (…); full validation required` | Change `.nvmrc`, `.node-version`, `.npmrc`, `.mocharc.*`, `tsconfig.base.json`, `tsconfig.test.json`, `.tool-versions`, `mise.toml`, `.mise.toml`, `mise.local.toml`, `.mise.local.toml`, `.bun-version` or a Yarn binary or plugin under `.yarn/releases/` or `.yarn/plugins/` | No |
| `Code that no file imports changed: …; a tool may load it by name, so full validation required` | Edit `karma.conf.js`, `.c8rc.js` or a root-level script that nothing imports | Yes: declare it in `inputs` |
| `The test script runs …; full validation required` | Edit `scripts/check.mjs` when `package.json` has `"test": "node scripts/check.mjs && node --test"` | Yes: `verify` and the agent tools run that phase instead when it runs the program alone (`node scripts/check.mjs`) |
| `The test script runs …, which imports …; full validation required` | Edit a module that `scripts/check.mjs` imports, with the same test script | Same as above |
| `Unknown changed file: …` | Change a file type no adapter models, such as `data.bin` read at runtime | Yes: declare it in `inputs` |
| `Infrastructure code … is outside the dependency graph; full validation required` | Edit a script under `ops/` that no test imports | Yes: declare it in `inputs` |
| `Lockfile readers could not be resolved: …; full validation required` | Change `yarn.lock` while repository code reads it in a way DiffCI cannot trace | No |

_The named `Tool configuration changed` reasons, including the Mocha fallback, were contributed by [@tyza66](https://github.com/tyza66) in [#144](https://github.com/DiffCI/core/pull/144), [#155](https://github.com/DiffCI/core/pull/155) and [#156](https://github.com/DiffCI/core/pull/156)._

### Dependencies

| Reason | Example change | Narrow |
| --- | --- | --- |
| `… (…) cannot be traced without repository contents; full validation required` | Bump a dependency when DiffCI is run without access to the checkout's files | No |
| `Yarn lockfile changed and repository imports undeclared dependencies (…); full validation required` | Bump `yarn.lock` while `src/a.js` imports a package not listed in `package.json` | No |
| `npm lockfile changed and repository imports undeclared dependencies (…); full validation required` | Bump `package-lock.json` while `src/a.js` imports a hoisted package not listed in `package.json` | No |
| `pnpm lockfile changed and repository imports undeclared dependencies (…); full validation required` | Bump `pnpm-lock.yaml` while `src/a.js` imports a hoisted package not listed in `package.json`, or, in a workspace, while `packages/web/src/a.js` imports a package only `packages/lib` declares | No |
| `… and no repository source imports it; full validation required` | Bump a devDependency such as `eslint` that only tools load | No |
| `… and the test script runs it; full validation required` | Bump `vitest` when the `test` script runs `vitest` | No |
| `… and a workspace package script runs it; full validation required` | In a pnpm workspace, bump `vitest` when any script in `packages/lib/package.json` runs `vitest` | No |
| `Dependency change (…) and …/package.json cannot be read; full validation required` | Bump a pnpm workspace dependency while a workspace package's `package.json` is unparseable | No |
| `… and … loads it; full validation required` | Bump a Babel plugin that `babel.config.js` loads | No |
| `… and …, which loads it, is outside the dependency graph; full validation required` | Bump a package that a config file outside the graph loads | No |
| `package.json test script now lists …, which does not exist; full validation required` | Add `tests/missing.test.js` to the `test` script without creating it | No |

### Tests and the dependency graph

| Reason | Example change | Narrow |
| --- | --- | --- |
| `Dependency graph confidence is UNSAFE; full validation required` | Any change in a repository that uses `require(name)` with a computed `name` | No |
| `Computed module load in … is outside the dependency graph; full validation required` | `import(\`./locales/${lang}.js\`)` in a changed file's importer | No |
| `Repository declares … but no test files were discovered; full validation required` | `jest` is a dependency but every test lives under a directory DiffCI does not search | No |
| `Workspace package … declares … but no test files were discovered in it; full validation required` | Change code that reaches a workspace package whose own `test` script runs Vitest or Jest from a config DiffCI does not read, such as a `vite.config.ts` with `include: ['./**/test.ts']` | Fix: give the package a `vitest.config.*` with literal `include` globs, or name its tests `*.test.*` |
| `Changed test selection invariant violated: … directly changed test(s) not selected (…)` | Edit a test file DiffCI could not attach to the suite (an internal error) | No |
| `Deleted test …; legacy coverage/dependents cannot be established safely` | Delete `src/a.test.ts` | No |
| `Deleted source/asset … not present in HEAD dependency graph; legacy dependents cannot be determined` | Delete `src/legacy.css` while an unchanged `src/app.tsx` still imports it, or while a workflow step names it (renamed or deleted files whose importers all changed are narrowed) | Yes: declare it in `inputs` |
| `Declared input … selects no tests; full validation required` | `inputs` names the changed file, but its `tests` globs match no test file | Fix: point `tests` at existing tests |
| `Invalid inputs: each entry needs non-empty files and tests glob lists` | `"inputs": [{ "files": ["fixtures/**"] }]` | Fix: give every entry `files` and `tests` |
| `Invalid computedImports: the only supported value is follow-path-literals` | `"computedImports": "trust"` | Fix: use `"follow-path-literals"` or remove the key |
| `Invalid importer TypeScript configuration: …` | Break the JSON in `tsconfig.json`. A `tsconfig.json` in a nested package that is not a workspace member, and whose stated paths stay inside it, decides only changes that reach that package, such as an E2E app whose config extends a generated `.nuxt/tsconfig.json` | No |
| `Unsupported … …; root-relative test discovery requires full validation` | Set `root: "./src"` in `vitest.config.ts` or `rootDir` in `jest.config.js`. A root that names the config's own directory is supported: `"."`, `__dirname`, `import.meta.dirname`, `dirname(fileURLToPath(import.meta.url))`, `fileURLToPath(new URL(".", import.meta.url))` or `resolve()` of one of these, directly or through a top-level `const`, with the helpers imported from `node:path` and `node:url` | No |
| `Multiple runner configurations require completely understood explicit test includes; full validation required` | Keep both `vitest.config.ts` and `jest.config.js` without explicit `include`/`testMatch` | No |
| `Unmodeled languages alongside an adapter require full validation` | Add Python files to a Go repository. When every such file sits inside nested package directories or a top-level dot-directory such as `.agents/`, only changes that reach those directories fall back | No |
| `Workspace package … is imported by … file(s) but DiffCI cannot map the import to the package's source files; point the package's types entry at a tsconfig outDir or declarationDir with a rootDir, or at source` | A workspace member imports another workspace package by name, and that package's `types` entry (or its export's `types` condition) points at build output that no `tsconfig*.json` in the package root maps back to source with `outDir`/`declarationDir` and `rootDir`, or points only at JavaScript. Installing or building does not help: built declarations are not source | Fix: give the package a tsconfig with `rootDir` and the output directory its `types` entry uses (as Sentry's `tsconfig.types.json` does), or point the entry at source |
| `Mixed Go/JavaScript repositories require explicit cross-language dependencies; full validation required` | A repository with both `go.mod` and `package.json` tests | No |

### Go

_The runtime-input check (`Go runtime inputs outside source/embed metadata …`) was contributed by [@FredApps](https://github.com/FredApps) in [#36](https://github.com/DiffCI/core/pull/36)._

| Reason | Example change | Narrow |
| --- | --- | --- |
| `Go support requires one root go.mod; workspaces and nested modules require full validation` | Add `tools/go.mod` beside a root `go.mod`, add a `go.work`, or add a `.go` file outside every nested module | Yes: `"go": { "scope": "root-module" }` |
| `Go modules without a root go.mod are not modelled; a change that reaches one requires full validation` | A repository in another language with Go tools in nested modules and no root `go.mod` or `go.work`, such as `tools/agent-shim/go.mod`. Go isn't modelled there: a change that reaches a module's directory falls back, and other changes are planned as if the repository had no Go | No |
| `Go root-module scope with local replacements requires full validation` | A local `replace` with `go.scope` set whose directory is not a nested module root in the repository. `replace example.com/x => ./x`, where `x/go.mod` exists, is modelled instead: changes to the `x/` packages the root build uses select their importers, and other `x/` files (its own tests, unused packages) fall back as runtime inputs. In-repository replace targets were contributed by [@sarankumar1325](https://github.com/sarankumar1325) in [#110](https://github.com/DiffCI/core/pull/110) | No |
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
| `Changes in Go discovery-excluded paths require full validation, including runtime test data` | Edit a `testdata` file of a package without `_test.go` files, a file under a `_`-prefixed directory, a `_`/`.`-prefixed directory inside the `testdata` tree, `testdata` that `go:embed` embeds, or `testdata` that code outside the owning package names | No - plain owned `testdata` selects the owning package's tests instead (see below) |

_Package testdata (#83): a plain `testdata/` input whose parent directory is a reported Go package with `_test.go` files selects that package's tests (reason `GO_TESTDATA`) instead of falling back - the go tool runs a package's tests with the package directory as the working directory. It falls back when code outside the owning package names the path or its `testdata` directory - any other reported Go package's test or ordinary source files (a helper package with no tests of its own included), or a test or source module outside the reported Go packages, such as a nested module or a Python helper - when a `_`-prefixed or `.`-prefixed directory lies on the way or below `testdata`, when the cached profile predates the package-test evidence, or when the file is embedded. A declared `inputs` entry adds its declared tests on top of the package's. Contributed by [Shounak Joshi (@shounakjoshi88-a11y)](https://github.com/shounakjoshi88-a11y) in [#85](https://github.com/DiffCI/core/pull/85); follow-ups in [#90](https://github.com/DiffCI/core/issues/90)._

### Maven

_Module resource and dependency impact contributed by [@FredApps](https://github.com/FredApps) in [#33](https://github.com/DiffCI/core/pull/33)._

| Reason | Example change | Narrow |
| --- | --- | --- |
| `Invalid Maven lifecycle goal or profiles` | `"maven": { "goal": "install" }` | Fix: use `test` or `verify` |
| `Maven analysis found no pom.xml` | A Java repository built with another tool | No |
| `Maven reactor contains no Java sources` | A `pom.xml` with only resources | No |
| `Maven …: custom source roots require full validation` | Set `<sourceDirectory>`, or a `<testSourceDirectory>` that is interpolated (`${…}`), absolute, outside the module, declared more than once, inside a profile, or inherited from a parent POM | Declare a plain relative `<testSourceDirectory>` inside the module, in the module's own `<build>`; DiffCI finds tests there |
| `Maven …: Java sources outside the standard roots require full validation` | A `.java` or `.kt` file in the module outside `src/main/{java,kotlin}`, `src/test/{java,kotlin}` and the module's `<testSourceDirectory>`, such as a `src/it/java` root added by `build-helper-maven-plugin` or a test root set by a parent POM outside the repository | Move the files under a standard root, or declare the test root as a plain relative `<testSourceDirectory>` in the module's own POM |
| `Maven …: unresolved dependency coordinates require full validation` | Use a `${property}` version DiffCI cannot resolve | No |

### Python

These appear only in Python projects (a root `pyproject.toml`, `setup.py`, `setup.cfg`, `pytest.toml`, `.pytest.toml`, `pytest.ini`, `.pytest.ini`, `tox.ini` or `conftest.py`). A changed project file such as `pyproject.toml` or `requirements.txt` falls back under `Configuration file(s) changed`.

| Reason | Example change | Narrow |
| --- | --- | --- |
| `Python file could not be parsed (…): …` | A `.py` file with a syntax error | Fix: make the file parse |
| `Python computed import in …; full validation required` | `importlib.import_module(name)` with a name built at run time | No |
| `Unresolved relative import in …: ……` | `from .gone import x` after deleting `gone.py` | No |
| `Unresolved first-party Python import in …: …` | `import shop.generated` where `shop/generated.py` is created by a build step | No |
| `pytest configuration DiffCI cannot read: …` | `python_files` set to something other than a string or list in `pyproject.toml` | Fix: use a literal string or list |
| `pytest configuration DiffCI cannot read: …` | A `pytest.toml` or `[tool.pytest]` key that isn't a list of strings, both `[tool.pytest]` and `[tool.pytest.ini_options]` in one `pyproject.toml`, or options above the `[pytest]` table in `pytest.toml`; a quoted or dotted key, or a table header with spaces or quotes inside the brackets; or a `pytest.toml`, `.pytest.toml` or `[tool.pytest]` next to another pytest config that pytest before 9 would read instead | Fix: use a list of strings, keep one table, and put options under `[pytest]` (pytest 9 rejects all three); write bare keys and `[pytest]` / `[tool.pytest]` headers; keep a single pytest config file |
| `Python analysis found no Python files` | Project files with every `.py` file inside a virtual environment | No |

_Reading pytest configuration the way pytest does was improved by [@sarankumar1325](https://github.com/sarankumar1325): `pytest.ini` wins even when empty, and `.pytest.ini` is read ([#314](https://github.com/DiffCI/core/pull/314)); `pyproject.toml` lists are read as TOML strings ([#315](https://github.com/DiffCI/core/pull/315)); `tox.ini` and `setup.cfg` settings are covered by tests ([#316](https://github.com/DiffCI/core/pull/316))._

### Vue

These appear only for Vue and Nuxt repositories, most of them only after `vue` is set in `diffci.json`.

| Reason | Example change | Narrow |
| --- | --- | --- |
| `Invalid Vue package/suite scope` | `"vue": { "packageRoot": "../web" }` | Fix: a package-relative path and `vitest.config.*` |
| `Nuxt implicit routes and auto-imports require a dedicated framework adapter` | Any change in a repository whose root depends on `nuxt`, or whose nested Nuxt config uses layers, a parent path or a computed path | No |
| `Nuxt implicit routes and auto-imports require a dedicated framework adapter: …` | A change that reaches a nested Nuxt app, such as an E2E test application | No |
| `Changes outside the declared Vue package require full validation` | Edit `server/` when `vue.packageRoot` is `web` | No |
| `Vue suite configuration or shared setup dependency changed; full validation required` | Edit `web/vitest.setup.ts` | No |
| `Vue dependency crosses the declared package boundary: … -> …` | `web/` imports `../shared/x.ts` | No |
| `Vue asset or macro dependency crosses the declared package boundary` | A component loads an asset from outside `web/` | No |
| `Resolved implementation cannot be included in the scoped source inventory: …` | An alias resolves to a file DiffCI cannot read | No |
| `Unresolved Vue dependencies require full validation` | `import X from "@/missing.vue"`. When every importer sits inside nested package directories, only changes that reach those packages fall back | No |
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

### Rust adapter safety

Maintainer: [@FredApps](https://github.com/FredApps).

Rust support is experimental. Cargo workspaces and single crates support conservative crate-level selection. Commands require verified plain `cargo test` evidence; wrappers and unmodeled execution contexts remain advisory. Toolchain and cache actions (`dtolnay/rust-toolchain`, `actions-rust-lang/setup-rust-toolchain`, `Swatinem/rust-cache`, `actions/cache`), `rustup` steps (also chained with `&&`, with toolchain names from a matrix of plain words), `cargo build`/`check`/`clippy`/`fmt`/`doc` steps, `RUSTFLAGS`/`RUSTDOCFLAGS` set only to `-Dwarnings`, and `CARGO_TERM_*` settings count as ordinary CI. `cargo test --workspace` (or `--all`) counts as plain `cargo test` only when plain `cargo test` already tests every member: a single crate, or a virtual workspace without `default-members`. Metadata unions all features and target-platform dependencies, including dev-dependencies. Feature-conditional source stays crate-granular. A target with `required-features` keeps its package whole in a selected command (`-p name`, never `--test name`), so Cargo runs or skips it exactly as the full `cargo test` does. Locked registry and Git dependencies, including their build scripts and procedural macros, do not block selection: a `Cargo.lock` change keeps the full suite. A workspace crate with a build script, code that runs Cargo or rustc, or code that climbs out of its crate directory (`.parent()`, `.ancestors()`, `PathBuf::pop` or a formatted `..` path) is treated as depending on every workspace crate, so it runs for any Rust change while other crates still narrow. A literal path in Rust code that reaches another crate becomes a dependency on that crate. A local path package inside the repository that is not a workspace member (an excluded or vendored crate) is an unmodelled boundary: a change to it keeps the full suite, dependencies through it are followed, and a member that reaches one whose code could read other crates' files (a build script, path literals, includes, climbing out of its directory, running Cargo) depends on every workspace crate. Whether or not a member reaches it, such a package's build scripts and code that reads documentation make documentation changes keep the full suite, and code that runs other programs counts as Rust code that starts external programs. A local path package outside the repository keeps the repository-wide fallback. Only the crates plain `cargo test` covers (the root package, `default-members`, or every member of a virtual workspace) are test targets; other members stay sources whose changes reach their tested dependents. In a Cargo-only repository, a Python helper script or a C/C++ source is confined to the crate that contains it (or its top-level directory outside every crate): a change that reaches that crate, or to the file itself, keeps the full suite, and other changes still narrow. JavaScript, Go, Java and other files that another engine could test, Python test files, files in a root package, and any repository whose Rust code starts external programs (other than Cargo, rustc or the package's own binaries) keep the repository-wide fallback. When dependency declarations request features, Cargo resolves features for each tested crate alone and with its dependents (`cargo tree`), and a selected command must give every package the features the full `cargo test` gives it. When the selected crates alone would build a shared dependency with fewer features, the command adds the tested crates of the smallest set Cargo resolved with the full run's features (it runs more tests than selected, and fewer than the full run); without such a set the plan stays advisory.

| Reason | Meaning / next step |
| --- | --- |
| `Rust support requires a Cargo workspace or crate at the repository root`<br>`Ambiguous Cargo workspace package names require full validation`<br>`Rust package … has an unavailable or external manifest`<br>`Rust file has no verified Cargo package: …`<br>`Rust target …/… has an unavailable, external or differently owned source`<br>`Unsupported Cargo target kind: …/…`<br>`Multiple Cargo test targets share a source path: …`<br>`Cargo metadata found no supported test targets`<br>`Invalid or incomplete Cargo metadata requires full validation`<br>`Rust support requires a root Cargo.toml`<br>`Cargo metadata unavailable: install Rust and repository dependencies; offline, locked metadata must succeed` | Cargo ownership or dependency evidence is incomplete; retain the full suite. Check the root manifest, target paths and offline metadata. |
| `Cargo manifests outside workspace membership require full validation: …`<br>`Cargo packages share a manifest; ownership is ambiguous` | Cargo package ownership is incomplete or ambiguous; retain the full suite. |
| `Custom Cargo configuration requires full validation`<br>`Cargo dependency resolution is missing or incomplete; full validation required`<br>`Local Cargo path dependencies outside the workspace require full validation: …`<br>`Rust computed includes or path attributes require full validation: …`<br>`Rust include outside its crate or unavailable requires full validation: …`<br>`Custom Cargo configuration or compiler environment requires full validation`<br>`Mixed Rust/language repositories require explicit cross-language dependencies; full validation required`<br>`Rust runtime inputs outside crate metadata or workspace configuration require full validation: …`<br>`Rust include code with a non-Rust extension requires full validation: …`<br>`Cargo target with a non-Rust extension requires full validation: …`<br>`Cargo feature resolution is unavailable; full validation required`<br>`Cargo metadata without default workspace members requires full validation; use Cargo 1.71 or later`<br>`Incomplete Rust source inventory or symlinked inputs require full validation` | Cargo ownership, build context or dependency evidence is incomplete; retain the full suite. |
| `Cargo package … has no unambiguous package specification; full validation required` | A dependency has the same name and version as a workspace member, so `cargo test -p` can't tell them apart; retain the full suite. A member that only shares its name is passed to Cargo as `name@version`. |

### No runnable command

Sometimes DiffCI selects tests but can't write a command that runs only those tests. Then `check` prints `no command: <reason>`, the job summary prints `No runnable command: <reason>`, and Core's plan reports `commandSynthesis.status: "UNAVAILABLE"` with the reason. The selection is still reported. Run the repository's full test command for that change. `…` stands for a path.

| Reason | Example cause | What to do |
| --- | --- | --- |
| `Workspace routing requires non-overlapping declared npm or pnpm packages` | A Yarn or Bun workspace, or one workspace package nested inside another | Run the full suite |
| `A selected test has no verified workspace owner` | A test file inside a workspace package that the package's test discovery doesn't list | Run the full suite. Check the package's test config includes the file |
| `A selected root test has no runner` | A test outside every workspace package that the root suite doesn't claim | Run the full suite |
| `Workspace test scripts require a single declared Vitest phase without lifecycle hooks or discovery blind spots` | A package `test` script like `lint && vitest run` or `vitest --coverage`, a `pretest`/`posttest` script, or a runner other than Vitest | Run the full suite, or make the package's `test` script a plain `vitest run` |
| `A workspace test script names a Vitest configuration DiffCI did not discover` | `vitest run --config vitest.e2e.config.ts` where that file is missing or has no `include` | Run the full suite. Check the config file path |
| `Vitest projects must be statically declared inline in one configuration` | `test.projects` built from a variable or spread, or projects spread over several configs | Run the full suite, or list the projects inline in one config |
| `Workspace test path exceeds the safe command length` | A single test path over 3000 characters | Run the full suite |
| `No workspace runtime suite can be safely narrowed; full validation is required` | Every selected suite is non-isolated or only type tests remain | Run the full suite |
| `Scoped Vitest execution requires pnpm and verified package test paths` | A Vue-scoped package with npm or Yarn, or a selected file its suite doesn't list | Run the full suite |
| `Python test files require pytest discovery by the Python adapter` | A selected `.py` file that pytest discovery didn't report | Run the full suite. Check pytest collects the file |
| `Go test files require verified package metadata` | A selected `_test.go` file with no package from `go list` | Run the full suite |
| `Invalid Go package target` | A Go package path outside the module or containing `..` | Run the full suite |
| `Maven test files require verified reactor module metadata` | A selected `.java`/`.kt` test with no reactor module | Run the full suite |
| `Mixed Maven/JavaScript selective execution requires separate CI jobs` | Selected Java tests and JavaScript tests in one change | Run each toolchain's tests in its own job, or run the full suite |
| `Invalid Maven reactor module target` | A module path that is absolute or contains `..` | Run the full suite |
| `Non-isolated or ambiguous Vitest isolation requires full validation` | `test: { isolate: false }`, `poolOptions.threads.isolate: false`, or an `isolate` value that isn't the literal `true` | Run the full suite. Test files share state, so a subset isn't safe |
| `Selected test has no declared Vitest project` | A selected file that no inline Vitest project includes | Run the full suite, or add the file's glob to a project |
| `Vitest project selection exceeds the safe command length` | A single test path over 3000 characters in a project | Run the full suite |
| `Repository declares no recognised test framework; DiffCI cannot construct a command that would run a subset of its tests` | No test framework dependency and no test runner config | Run the full suite |
| `No framework claims the remaining selected tests` | Tests that no config includes, and no framework to fall back to | Run the full suite |
| `Selected tests are outside the default runner configuration` | A selected file that the default config excludes or doesn't include | Run the full suite. Check the config's `include` and `exclude` |
| `The runner reads test paths as patterns and cannot be given … literally` | A test path with glob or regex characters, such as `[id].test.ts`, for a runner that reads paths as patterns | Run the full suite |
| `Mixed Rust selective execution requires separate CI jobs` | A change selects Rust test targets and tests in another language together | Run the full suite, or run each language's tests in its own CI job |
| `Rust tests require verified plain cargo test invocation evidence` | CI runs `cargo nextest`, a wrapper script or `cargo test` with flags, or no workflow or `package.json` shows how tests run | Run the full suite. See [Rust adapter safety](#rust-adapter-safety) for the steps DiffCI can reproduce |
| `Rust test wrappers, scripts and Cargo options require full validation` | A `package.json` script such as `cargo test --all-features` or a `pretest` step around `cargo test` | Run the full suite, or make the `test` script a plain `cargo test` |
| `Rust tests require verified Cargo package and target metadata` | A selected Rust file that Cargo metadata doesn't report as a test target, for example in a profile cached before Rust support | Run the full suite. Re-run the analysis with Cargo installed |
| `Invalid Cargo package or test target` | A package or target name that isn't a plain Cargo name, or a target kind other than lib, bin, test, bench or example | Run the full suite |
| `Rust tests require verified Cargo feature resolution` | A profile without Cargo's feature resolution, for example one cached by an older DiffCI | Run the full suite. Re-run the analysis with Cargo installed |
| `Selected Cargo crates would build … with different features than the full cargo test; full validation required` | Testing a crate without the dependent that turns on one of its features, so `cargo test -p` would build it differently. `…` is a package | Run the full suite |

`npm test` checks that every literal reason in `src/planner/test-command.ts` and `src/planner/rust-command.ts` is listed here (`node scripts/fallback-reasons.mjs --no-command` prints them).

_Documented by [@sarankumar1325](https://github.com/sarankumar1325) in [#150](https://github.com/DiffCI/core/pull/150); the isolation refusal is covered for a root Vitest config by his tests in [#149](https://github.com/DiffCI/core/pull/149)._
