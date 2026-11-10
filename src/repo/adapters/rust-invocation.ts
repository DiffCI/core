import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const plain = (value: unknown): boolean => typeof value === "string" && value.trim() === "cargo test";
const customContext = (value: Record<string, unknown>): boolean =>
  ["env", "defaults", "shell", "working-directory", "container", "services", "strategy", "if"].some(key => key in value);

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
      if (!record(workflow) || !record(workflow.jobs) || customContext(workflow)) return undefined;
      for (const job of Object.values(workflow.jobs)) {
        // A second job or reusable workflow may run another suite. We do not infer its
        // closure from a label or from the presence of one plain command elsewhere.
        if (!record(job) || "uses" in job || !Array.isArray(job.steps) || customContext(job)) return undefined;
        for (const step of job.steps) {
          if (!record(step) || customContext(step)) return undefined;
          if ("run" in step) {
            // Applies before AND after the test, across all jobs/workflows: wrappers,
            // nextest, cargo make, just, and unknown shell scripts are not reproduced.
            if (!plain(step.run) || "uses" in step) return undefined;
            found = true;
          } else {
            // Only uncustomized official checkout has modeled semantics here. Unknown
            // actions, local actions and toolchain setup can replace cargo or persist env.
            if (typeof step.uses !== "string" || !/^actions\/checkout@(?:v[456]|[a-f0-9]{40})$/.test(step.uses)
              || "with" in step) return undefined;
          }
        }
      }
    } catch { return undefined; }
  }
  return found ? "cargo test" : undefined;
}
