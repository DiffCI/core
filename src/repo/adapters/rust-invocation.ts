import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const plain = (value: unknown): boolean => typeof value === "string" && value.trim() === "cargo test";

/** Steps that install a toolchain, restore caches or check out the code. They choose which compiler
 * runs, the same for the selected and the full command, but not which tests run or with what flags. */
const SETUP_ACTION = /^(?:actions\/checkout|actions\/cache(?:\/restore)?|actions\/upload-artifact|Swatinem\/rust-cache|dtolnay\/rust-toolchain|actions-rust-lang\/setup-rust-toolchain|actions-rs\/toolchain)@[A-Za-z0-9._/-]+$/;

/** Other Cargo and rustup commands that build, lint, format or install, but run no tests. One command
 * per step: chaining, substitution or redirection could hide another invocation. */
const NON_TEST_COMMAND = /^(?:cargo (?:build|check|clippy|fmt|doc)|rustup (?:component|target|toolchain|default|show|update))(?: [A-Za-z0-9_.,:=@+/-]+)*$/;

/** Environment that changes output or retries, never what is compiled or tested. */
const NEUTRAL_ENV = new Set(["CARGO_TERM_COLOR", "CARGO_INCREMENTAL", "CARGO_NET_RETRY", "CARGO_NET_GIT_FETCH_WITH_CLI",
  "CARGO_REGISTRIES_CRATES_IO_PROTOCOL", "RUST_BACKTRACE", "RUSTUP_MAX_RETRIES", "CI"]);

const neutralEnv = (value: unknown): boolean => value === undefined || record(value)
  && Object.entries(value).every(([key, setting]) => NEUTRAL_ENV.has(key) && ["string", "number", "boolean"].includes(typeof setting) && !String(setting).includes("${{"));

/** Workflow and job keys with no effect on how a step's command runs. */
const WORKFLOW_KEYS = new Set(["name", "run-name", "on", "true", "permissions", "concurrency", "env", "jobs"]);
const JOB_KEYS = new Set(["name", "runs-on", "permissions", "concurrency", "timeout-minutes", "needs", "strategy", "env", "steps"]);
const SETUP_STEP_KEYS = new Set(["name", "id", "uses", "with", "if", "env", "timeout-minutes", "continue-on-error"]);
const TEST_STEP_KEYS = new Set(["name", "id", "run", "env", "timeout-minutes"]);

/** Evidence for the one invocation whose flags and execution context we can reproduce.
 * Do not turn a Cargo manifest, a wrapper or a feature-specific CI run into plain cargo test. */
export function rustTestInvocation(repoPath: string, files: readonly string[]): "cargo test" | undefined {
  let found = false;
  if (files.includes("package.json")) {
    try {
      const manifest: unknown = JSON.parse(readFileSync(join(repoPath, "package.json"), "utf8"));
      if (!record(manifest)) return undefined;
      if ("scripts" in manifest) {
        if (!record(manifest.scripts)) return undefined;
        // A plain command under an unrelated script name is not evidence that the actual
        // test entrypoint has the same semantics. Unknown scripts may wrap additional suites.
        if (!plain(manifest.scripts.test) || Object.values(manifest.scripts).some(script => !plain(script))) return undefined;
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
            if (plain(step.run)) {
              // The test step itself runs unconditionally, in the checkout root, with the default shell.
              if (Object.keys(step).some(key => !TEST_STEP_KEYS.has(key)) || !neutralEnv(step.env)) return undefined;
              found = true;
            } else if (typeof step.run !== "string" || !NON_TEST_COMMAND.test(step.run.trim())
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
