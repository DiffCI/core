# Design: change impact for the whole pipeline (checks, build, deploy)

Status: proposal (2026-10-29). Extends [affected-checks.md](affected-checks.md), which covers lint,
typecheck and repository check scripts before push. This document adds build and deploy, and the two
places DiffCI acts after the developer's machine: inside CI jobs and at deploy time.

## Why

DiffCI selects tests today. On DentalPresence that touches 9.4 of the build-hours and saves about
1.4% (`dentalpresence-ai-waste-evidence.md` §5d). The rest of the pipeline is where the waste is:

| Stage | DentalPresence evidence | What impact analysis can do |
|---|---|---|
| Checks (`npm run check`) | 104 gate failures found only after push; `check` took 9.9 build-hours on staging | Run the affected checks before push |
| Build | Application image build is 42% of staging time (median 159 s), on every commit | Skip or reuse the build when no input of the build changed |
| Deploy | About 83 production build-hours spent waiting or timing out | Do not rebuild or redeploy a Worker whose output cannot have changed |

Agents already treat "the tests DiffCI picked passed" as done. Extending the same answer to every gate
step closes the local-maxima gap that the pitch is about.

## One model for every step

Every step of the pipeline, whatever the stage, gets the same record. This is the existing
`CITaskDefinition` / `TaskDecision` pair (`src/planner/task-registry.ts`, `src/planner/types.ts`),
which already has `lint`, `typecheck`, `build` and `deploy` categories but decides them from fixed
globs. The change is to give each step a real **input model** and a **narrowed command**:

```ts
interface PipelineStep {
  id: string;                 // "lint", "check:routes", "build", "deploy:dentalpresence-staging"
  stage: "check" | "test" | "build" | "deploy";
  command: string;            // the repository's own command
  source: "package-script" | "workflow-step" | "deploy-config";
  inputs: InputModel;         // see below
}

type InputModel =
  | { kind: "whole-program"; program: string }            // tsc, vue-tsc
  | { kind: "per-file"; globs: string[]; config: string[] } // eslint, prettier, biome
  | { kind: "reads"; paths: string[] }                      // repository script; paths it names
  | { kind: "build-closure"; entries: string[]; assets: string[]; config: string[] }
  | { kind: "deploy"; build: string; config: string }       // build step id + wrangler/Docker config
  | { kind: "unknown" };                                    // always runs

interface StepDecision {
  id: string;
  decision: "RUN" | "NARROWED" | "SKIP" | "ALWAYS";
  command?: string;           // narrowed command for NARROWED, original for RUN/ALWAYS
  reason: string;             // one line an agent or reviewer can check
  evidence: string[];         // changed paths that triggered it, or why none did
}
```

Tests stay on the existing dependency-traced path; they become one `stage: "test"` step whose
decision is today's selection.

### Discovery

1. **Package scripts**: `check`, `lint`, `typecheck`, `validate*`, `build*`, `deploy*`, expanded
   into leaf commands (`a && b`, `npm run x`, `run-parallel`, `concurrently`), reusing
   `testScriptClosure`'s matching. Covered in affected-checks.md, step 1.
2. **Workflow steps**: `src/ci-inference` already infers jobs and each operation's purpose
   (`purpose.ts`: install, build, lint, typecheck, test, security, generate). Steps whose purpose is
   established by `EXECUTABLE_POSITION` or `SCRIPT_BODY` become pipeline steps; `NONE` becomes
   `unknown` and always runs.
3. **Deploy configs**: `wrangler.*` (`isWorkerConfig` in `file-references.ts`), `Dockerfile*`,
   `vercel.json`, `netlify.toml`. Each config is one deploy target.

### Input models for build and deploy

- **Build closure.** The bundler's entry points (`main` in wrangler config, Vite/Next entry, the
  `build` script's input directory) are roots in the existing dependency graph. A changed file
  affects the build if it is in the forward closure of an entry, is a static asset directory the
  build copies (`public/`, `assets` in wrangler), is build config (`vite.config.*`,
  `tsconfig*.json`, wrangler config), or is the lockfile. Test files, docs and CI-only scripts that
  no entry reaches do not affect it.
- **Workspaces.** In a declared workspace, each package's `build` is its own step; only packages
  in the change's closure (including dependents) build. `src/repo/workspaces.ts` already discovers
  them.
- **Deploy target.** Affected if its build step is affected or its config changed. With several
  Workers in one repository, only the affected ones deploy.
- **Build key.** The same closure gives a content key: the hash of every input file's blob id plus
  config and lockfile. Equal keys mean the previous artifact can be reused. This is what turns
  "nothing relevant changed" into saved build time without trusting a skip.

## Safety rules

The rules in affected-checks.md apply to every stage, plus:

- Any global fallback signal that forces the full test suite forces every step.
- `unknown` input models always run. A step DiffCI did not recognize is never skipped.
- Security and infrastructure steps (`category` `security`, `infrastructure`) are `ALWAYS`, as the
  registry already marks them.
- Deploy is never skipped on the default branch's production path by default. Phase 3 reuses an
  artifact by build key instead, so the deploy still happens and is just cheaper.
- Skipping in CI (phase 2) starts in observe mode only, and moves to enforce per repository after
  measured recall, using the existing `enforce-misses` machinery.

## Phases

### Phase 1: before push

Where: `diffci_select_tests` (MCP), `diffci verify --changed`, the pre-push hook.

- The selection output gains `checks` and `build` next to the tests, each with command and reason
  (format in affected-checks.md, "Output").
- `verify` runs steps cheapest first: per-file lint, repository scripts, typecheck, selected tests,
  then build only when its closure is affected and the repository's gate builds.
- `selectionInstruction` names every command, so agents run the checks they skipped in the 104
  failures.

Slices, in order:

1. Expand the gate into leaf steps and report them all as `RUN` ("not yet narrowed"). This alone puts
   the exact gate in front of agents. **Implemented 2026-10-29** (`src/planner/pipeline-steps.ts`,
   `packages/diffci-cli/src/client/gate-checks.ts`). The gate also includes check-named scripts
   that a CI workflow runs: DentalPresence's architecture rule is in `validate:release`, which only
   the staging deploy workflow calls. `verify` runs the checks before the tests and stops at the first
   failure; `--no-checks` skips them, and so does CI unless `--checks` is passed.
2. Narrow per-file lint to the changed files. **Implemented 2026-10-29**
   (`src/planner/check-narrowing.ts`): `eslint` and `prettier --check` leaves with only known flags run
   on the changed files they cover, or are skipped when they cover none. Config, ignore-file,
   config-referenced, `package.json` and lockfile changes run the whole check. Type-aware, import-plugin
   or nested ESLint configs make lint whole-program: it runs whenever a code file changed. On the last
   40 DentalPresence commits that is 39 runs and 1 skip, because its lint is type-aware; slice 4's
   program membership is what would skip more there.
3. Repository-script `reads` model (inverse of `file-references.ts`).
4. Skip typecheck and build when no changed file is in the program or the build closure.

Measure: replay DentalPresence's 104 gate failures; the failing step must be in the selected set
in 104 of 104 cases, with median selected-step time under the 88-second full `check`.

### Phase 2: inside CI jobs

Where: the GitHub Action (`action.yml`) and a CLI command for other CI systems.

- `diffci plan --steps --format github-output` writes one output per job or step
  (`lint=narrowed`, `build=skip`, `e2e=run`) plus the narrowed commands. Workflows use them in
  `if:` and `run:`. `diffci verify-workflow` generates the wiring.
- `diffci gate` runs the selected steps in one command, for builders that run a script instead of
  workflow jobs (the Cloudflare Sandbox runs `npm run check` and the full test suite on every build).
- Starts as observe: every job still runs, and the report records what DiffCI would have skipped and
  whether that job then failed. Enforce is opt-in per repository once the miss rate is measured.

Measure: CI minutes per pull request in observe mode (would-have-saved) and misses (a skipped job
that failed when it ran).

### Phase 3: deploy

Where: the deploy step of the workflow or the Cloudflare build command.

- `diffci deploy-plan` lists deploy targets with `deploy`, `reuse` (build key unchanged; promote the
  previous artifact) or `skip` (non-production preview with no affected output).
- Multi-Worker repositories deploy only the affected Workers.
- The build key is published with each artifact so the next run can compare without rebuilding.

Measure: build-hours on DentalPresence staging and production before and after, from the Workers
Builds API, as in §5d of the evidence document.

## Engine and CLI changes

| Change | Where |
|---|---|
| `PipelineStep`, `InputModel`, `StepDecision` types | `src/planner/types.ts` |
| Gate discovery and leaf expansion | new `src/planner/pipeline-steps.ts`, reusing `src/repo/workflow-test-steps.ts` and `src/ci-inference/purpose.ts` |
| Build closure and build key | new `src/repo/build-closure.ts` on the existing dependency graph |
| Per-step decisions | `DefaultCIPlanner.buildTasks` uses input models instead of `inputPatterns` |
| `checks` / `build` in selection | `packages/diffci-cli/src/client/agent-selection.ts` |
| Run steps before tests | `packages/diffci-cli/src/client/verify.ts` (`executableSelection`) |
| `plan --steps`, `gate`, `deploy-plan` | `packages/diffci-cli/src/client/cli.ts` (phases 2 and 3) |

`ExecutionPlan.tasks` keeps its shape for existing report readers; the new fields are additive, and
the plan version moves to 6.0.0 when decisions change from glob matches to input models.
