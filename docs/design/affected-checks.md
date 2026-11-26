# Design: selecting affected checks, not just tests

Status: proposal (2026-10-28). Not implemented beyond what "First slice" below says.

## Why

DentalPresence evidence (2026-08 to 2026-10, `dentalpresence-ai-waste-evidence.md` §5d):

- 104 Cloudflare builds failed the repository gates (`npm run check` and the test suite) after a push
  whose local work had passed. Agents ran tests they picked themselves, or `tsc`, but rarely the full
  `check`.
- Example: `5e13bcd2` failed `scripts/check-architecture-boundaries.js` ("Google product API runtime
  coupling outside the frozen adapter boundary"). No test selection would have caught it, because it
  is not a test.
- On staging, `npm run check` took 9.9 build-hours, more than the whole test suite (9.4).

Test selection saves about 1.4% of build time there. Telling an agent, before it pushes, which
*checks* its change affects, and running those, targets the late failures directly.

## What a "check" is

Anything the repository's gate runs that is not the test script. In DentalPresence:

```
check = npm run typecheck && npm run lint && node scripts/run-parallel.mjs lint:wordpress \
        check:unused check:links check:social-utm check:routes check:cloudflare-api-shield \
        check:d1-sql validate:cloudflare
```

DiffCI already infers a task registry with `typecheck`, `lint` and `build` categories
(`src/research/baseline/registry.ts`), but only from fixed script names and coarse globs, and the
planner decides RUN/SKIP per task without ever looking inside a composite script.

## Model

1. **Discover the gate.** Read the scripts a gate runs: `check`, `lint`, `typecheck`, `validate*`,
   plus scripts named by the CI workflow steps that run before tests (`workflow-test-steps.ts`
   already parses those). Expand a composite (`a && b`, `npm run x`, `run-parallel x y`, `concurrently`)
   into leaf commands, reusing `testScriptClosure`'s script-name matching.

2. **Classify each leaf** into one of four input models:

   | Kind | Example | Inputs | Narrowing |
   |---|---|---|---|
   | Whole-program | `tsc --noEmit`, `vue-tsc` | every file in the tsconfig program, tsconfig, `@types/*`, lockfile | Skip only if no changed file is in the program and no config/dependency changed. Never narrowed to files. |
   | Per-file linter | `eslint "src/**/*.{ts,tsx}"`, `prettier --check`, `biome` | the glob; config files | Run on the changed files that match the glob; whole glob when lint config, plugins or the lockfile changed. |
   | Repository script | `node scripts/check-architecture-boundaries.js` | the script, its import closure, and whatever it reads from disk | Run if the change touches the script, its graph closure, or a path the script names (see 3). |
   | Unknown | `bash ops/validate.sh`, a binary | unknown | Always run. |

3. **Who does a repository script read?** This is the inverse of the reference resolver that already
   exists (`src/repo/file-references.ts`): instead of "which files name the changed path", ask "which
   paths does this check script name". A script that names `"src"` (as `sourceFiles(path.join(root,
   "src"))` does) reads everything under `src/`. A script that reads `package.json` is affected by a
   dependency change. A script whose reads cannot be determined (path built from variables, walks
   `root` with no directory name) is treated as reading everything: fail closed, as with tests.

   For `check-architecture-boundaries.js`: it names `src` and `package.json`, so the `5e13bcd2` change
   to `src/lib/index/places-budget.ts` selects it. A docs-only change does not.

4. **Output** one ordered list per change, cheapest first, each with the exact command and the reason:

   ```json
   "checks": [
     { "id": "lint", "command": "npx eslint src/lib/index/places-budget.ts", "reason": "1 changed file matches the lint glob" },
     { "id": "check-architecture-boundaries", "command": "node scripts/check-architecture-boundaries.js", "reason": "reads src/" },
     { "id": "typecheck", "command": "npm run typecheck", "reason": "changed TypeScript in the program" }
   ],
   "skipped_checks": [ { "id": "check:links", "reason": "reads docs/ and site/ only" } ]
   ```

   `diffci verify --changed` runs the selected checks before the selected tests, and the pre-push
   hook (`diffci init`, see `docs/agent-installation.md`) makes that the default path before a
   push.

## Safety rules

- Required CI stays authoritative. Selected checks are a pre-push filter, never a replacement for the
  gate in CI.
- A global signal that already forces the full test suite (unresolved config, lockfile with a
  tooling package, workflow that runs tests) also forces every check.
- A check whose leaf command is not understood always runs.
- Per-file linting is only narrowed for rules that are file-local. Type-aware ESLint rules
  (`parserOptions.project`) and import-cycle rules are whole-program; when the config enables them,
  lint is treated as whole-program.

## How to measure it

Replay DentalPresence's 104 gate failures (Cloudflare build logs give the failing stage): for each
pushed commit, compute the affected checks and record whether the failing check was in the set. The
target is 100% recall on those 104 with a median selected-check time well under the 88-second full
`check`.

## First slice (smallest useful step)

1. Expand the `check` script into leaf commands and report them in `diffci_select_tests` output as
   `checks` with reason "always run (not yet narrowed)". This alone puts the exact gate in front of
   agents, which is what the 104 failures lacked.
2. Narrow per-file lint to the changed files.
3. Add the repository-script rule from step 3.

Typecheck narrowing is deliberately last: `tsc --incremental` is usually the better tool.

## Python checks (2026-11-18)

A Python repository has no `package.json` gate, so it had no checks at all. A sweep of public CI history
found PRs red only on a Python type check: in langgenius/dify, 4 of 28 red PRs failed only in
`make type-check-core` (pyrefly), each on a file the PR changed. `src/planner/python-checks.ts` now reads
the Python checks a GitHub Actions workflow runs:

- `make [-C dir] <target>` for a check-named target the Makefile defines, unless its recipe rewrites
  files (`--fix`, `ruff format` without `--check`);
- direct `mypy`, `pyright`, `basedpyright`, `pyrefly check`, `ruff check` and `ruff format --check`
  calls, optionally behind `uv run`, `poetry run`, `pdm run`, `hatch run`, `pipenv run` or `python -m`.

Anything not read with certainty adds nothing. A Python-only check (a direct call, or a target whose
recipe only calls Python tools, directly or through a repository script) is skipped when no Python file,
Python configuration, the Makefile or one of its scripts, or a workflow changed. Every other check runs
as written. The CLI skips a check whose program is not installed and says so: CI still runs it.

### Named tox environments and nox sessions

A single root-level Actions command such as `tox -e lint,type` or `nox -s lint types` can contribute
one check. Discovery reads the root `tox.ini` or `noxfile.py` as text. Verification runs the original
command when every selected name resolves and every command in its body is understood.

- Tox environments must skip installing the project and explicitly allow the external check tools.
  A named section can inherit commands from `[testenv]`.
- Nox sessions use `@nox.session(python=False)` or `@nox.session(venv_backend="none")`. The complete
  module must consist of `import nox` and literal session definitions using only `session.run(...)`.
- Supported commands are `ruff format --check`, `ruff check --no-fix --no-fix-only` and
  `mypy --config-file= src` with literal paths. The empty mypy config disables config-driven plugins
  and report writers. Ruff accepts `--isolated`. Without it, Ruff can check extra file extensions, so
  its session runs on any change. Even isolated checks run on ignore-file changes and when Git cannot
  rule out symlinked inputs.

An ordinary `actions/checkout` step or another supported session may precede the command. Earlier
setup scripts or custom actions could change the runner environment or generate a different configuration.
Those cases, conditional steps, changed working directories, environment overrides, dependencies, hooks and
dynamic declarations leave the session to CI. The CLI also leaves tox to CI on Windows, where it
cannot establish which user configuration the runner will load. Existing test selection and full-suite
fallback apply independently of these checks.
