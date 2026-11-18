import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const plain = (value: unknown): boolean => typeof value === "string" && value.trim() === "cargo test";

/** `--workspace` (or its old name `--all`) tests every member. That is plain `cargo test` exactly when
 * plain `cargo test` already covers every member: a single crate, or a virtual workspace without
 * `default-members`. The adapter says which. */
const wholeWorkspace = (value: unknown): boolean => typeof value === "string" && /^cargo test --(?:workspace|all)$/.test(value.trim());

/** Steps that install a toolchain, restore caches or check out the code. They choose which compiler
 * runs, the same for the selected and the full command, but not which tests run or with what flags. */
const SETUP_ACTION = /^(?:actions\/checkout|actions\/cache(?:\/restore)?|actions\/upload-artifact|Swatinem\/rust-cache|dtolnay\/rust-toolchain|actions-rust-lang\/setup-rust-toolchain|actions-rs\/toolchain)@[A-Za-z0-9._/-]+$/;

/** Other Cargo and rustup commands that build, lint, format or install, but run no tests. One command
 * per step: chaining, substitution or redirection could hide another invocation. */
const NON_TEST_COMMAND = /^(?:cargo (?:build|check|clippy|fmt|doc)|rustup (?:component|target|toolchain|default|show|update))(?: [A-Za-z0-9_.,:=@+/-]+)*$/;

/** rustup commands chained with `&&` (`rustup default stable && rustup update --no-self-update`),
 * where an argument may be a matrix value. Only rustup, so the chain cannot hide a test run. */
const RUSTUP_ARGUMENT = String.raw`(?:[A-Za-z0-9_.,:=@+/-]+|\$\{\{ ?matrix\.([A-Za-z0-9_-]+) ?\}\})`;
const RUSTUP_COMMAND = new RegExp(String.raw`^rustup (?:component|target|toolchain|default|show|update)(?: ${RUSTUP_ARGUMENT})*$`);

/** A matrix value is pasted into the script as text, so each one a rustup step uses must be a plain
 * toolchain-like word, in the matrix and in every `include` entry. */
function plainMatrixValues(strategy: unknown, key: string): boolean {
  if (!record(strategy) || !record(strategy.matrix)) return false;
  const word = (value: unknown) => (typeof value === "string" || typeof value === "number") && /^[A-Za-z0-9_.-]+$/.test(String(value));
  const values = strategy.matrix[key];
  const include = strategy.matrix.include;
  if (include !== undefined && (!Array.isArray(include) || include.some(entry => !record(entry) || (key in entry && !word(entry[key]))))) return false;
  if (values === undefined) return Array.isArray(include) && include.some(entry => record(entry) && key in entry);
  return Array.isArray(values) && values.length > 0 && values.every(word);
}

function setupCommand(run: string, strategy: unknown): boolean {
  if (NON_TEST_COMMAND.test(run)) return true;
  const parts = run.split(" && ");
  return parts.every(part => {
    if (!RUSTUP_COMMAND.test(part)) return false;
    return [...part.matchAll(/\$\{\{ ?matrix\.([A-Za-z0-9_-]+) ?\}\}/g)].every(match => plainMatrixValues(strategy, match[1]!));
  });
}

/** Environment that changes output or retries, never what is compiled or tested. */
const NEUTRAL_ENV = new Set(["CARGO_TERM_COLOR", "CARGO_TERM_VERBOSE", "CARGO_INCREMENTAL", "CARGO_NET_RETRY", "CARGO_NET_GIT_FETCH_WITH_CLI",
  "CARGO_REGISTRIES_CRATES_IO_PROTOCOL", "RUST_BACKTRACE", "RUSTUP_MAX_RETRIES", "CI"]);

/** `RUSTFLAGS: -Dwarnings` (and the same for rustdoc) turns warnings into errors. It changes neither
 * what is compiled nor which tests run, and applies equally to the selected and the full command.
 * Any other flag (cfg, codegen, target features, sanitizers) still makes the evidence advisory. */
const DENY_WARNINGS = /^\s*(?:(?:-D ?warnings|--deny[= ]warnings)\s*)+$/;

const neutralEnv = (value: unknown): boolean => value === undefined || record(value)
  && Object.entries(value).every(([key, setting]) => ["string", "number", "boolean"].includes(typeof setting) && !String(setting).includes("${{")
    && (NEUTRAL_ENV.has(key) || ["RUSTFLAGS", "RUSTDOCFLAGS"].includes(key) && DENY_WARNINGS.test(String(setting))));

/** Workflow and job keys with no effect on how a step's command runs. */
const WORKFLOW_KEYS = new Set(["name", "run-name", "on", "true", "permissions", "concurrency", "env", "jobs"]);
const JOB_KEYS = new Set(["name", "runs-on", "permissions", "concurrency", "timeout-minutes", "needs", "strategy", "env", "steps"]);
const SETUP_STEP_KEYS = new Set(["name", "id", "uses", "with", "if", "env", "timeout-minutes", "continue-on-error"]);
const TEST_STEP_KEYS = new Set(["name", "id", "run", "env", "timeout-minutes"]);

/** Evidence for the one invocation whose flags and execution context we can reproduce.
 * Do not turn a Cargo manifest, a wrapper or a feature-specific CI run into plain cargo test. */
export function rustTestInvocation(repoPath: string, files: readonly string[], options: { allMembersTested?: boolean } = {}): "cargo test" | undefined {
  let found = false;
  const testCommand = (value: unknown) => plain(value) || options.allMembersTested === true && wholeWorkspace(value);
  if (files.includes("package.json")) {
    try {
      const manifest: unknown = JSON.parse(readFileSync(join(repoPath, "package.json"), "utf8"));
      if (!record(manifest)) return undefined;
      if ("scripts" in manifest) {
        if (!record(manifest.scripts)) return undefined;
        // A plain command under an unrelated script name is not evidence that the actual
        // test entrypoint has the same semantics. Unknown scripts may wrap additional suites.
        if (!testCommand(manifest.scripts.test) || Object.values(manifest.scripts).some(script => !testCommand(script))) return undefined;
        if (Object.keys(manifest.scripts).some(name => /^(?:pre|post)/.test(name))) return undefined;
        found = true;
      }
    } catch { return undefined; }
  }
  for (const path of files.filter(path => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path))) {
    try {
      const workflow: unknown = parse(readFileSync(join(repoPath, path), "utf8"));
      if (!record(workflow) || !record(workflow.jobs) || Object.keys(workflow).some(key => !WORKFLOW_KEYS.has(key)) || !neutralEnv(workflow.env)) return undefined;
      for (const job of Object.values(workflow.jobs)) {
        // A reusable workflow, container, service, default shell or working directory, or a
        // conditional job may run another suite or change the context; we do not infer it.
        if (!record(job) || !Array.isArray(job.steps) || Object.keys(job).some(key => !JOB_KEYS.has(key)) || !neutralEnv(job.env)) return undefined;
        // A matrix may vary the runner or toolchain, which the selected and the full command share,
        // but not the test command: that must stay literally `cargo test` below.
        if (job.strategy !== undefined && (!record(job.strategy) || Object.keys(job.strategy).some(key => !["matrix", "fail-fast", "max-parallel"].includes(key)))) return undefined;
        for (const step of job.steps) {
          if (!record(step)) return undefined;
          if ("run" in step) {
            if (testCommand(step.run)) {
              // The test step itself runs unconditionally, in the checkout root, with the default shell.
              if (Object.keys(step).some(key => !TEST_STEP_KEYS.has(key)) || !neutralEnv(step.env)) return undefined;
              found = true;
            } else if (typeof step.run !== "string" || !setupCommand(step.run.trim(), job.strategy)
              || Object.keys(step).some(key => !["name", "id", "run", "env", "if", "timeout-minutes", "continue-on-error"].includes(key)) || !neutralEnv(step.env)) {
              // Wrappers, nextest, cargo make, just, other `cargo test` flags and unknown scripts are
              // not reproduced, before or after the test and in any job.
              return undefined;
            }
          } else if (typeof step.uses !== "string" || !SETUP_ACTION.test(step.uses)
            || Object.keys(step).some(key => !SETUP_STEP_KEYS.has(key)) || !neutralEnv(step.env)
            // Checking out another repository, ref or directory changes which code `cargo test` sees.
            || step.uses.startsWith("actions/checkout@") && step.with !== undefined
              && (!record(step.with) || Object.keys(step.with).some(key => !["fetch-depth", "persist-credentials", "lfs", "submodules", "clean", "show-progress"].includes(key)))) {
            // Unknown and local actions can replace cargo or persist environment for later steps.
            return undefined;
          }
        }
      }
    } catch { return undefined; }
  }
  return found ? "cargo test" : undefined;
}
