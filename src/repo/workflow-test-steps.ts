// SPDX-License-Identifier: MIT
/**
 * Can this GitHub Actions workflow run the repository's tests? (2026-10-21.)
 *
 * WHY. Any change under `.github/workflows/` forced full validation: 48 of 132 verification receipts in one
 * dogfood repository and 25 of 124 in the other. A workflow that runs tests defines the environment the suite
 * runs in, so a change to it can affect every test and full validation is right. A workflow that only
 * deploys, publishes, scans or labels cannot change a test outcome; tests observe it only by reading the
 * file, which the reference resolver (src/repo/file-references.ts) handles like any other data file.
 *
 * THE QUESTION ANSWERED HERE IS ONE-SIDED. `true` means "may run tests" and is the answer whenever the
 * file cannot be read with confidence: unparseable YAML, a reusable workflow, a local or unrecognised
 * action, a test runner anywhere on a command line, an npm script whose closure reaches tests, or an
 * interpreter executing a repository file (which may itself run tests). Only a workflow made entirely
 * of recognised non-test steps answers `false`.
 */
import { parse } from "yaml";
import { testScriptClosure } from "./file-references.js";

/** Actions known not to execute repository tests. Anything else is assumed to. */
const NON_TEST_ACTIONS = [
  "actions/checkout", "actions/setup-node", "actions/setup-go", "actions/setup-java", "actions/setup-python",
  "actions/cache", "actions/upload-artifact", "actions/download-artifact", "actions/configure-pages",
  "actions/upload-pages-artifact", "actions/deploy-pages", "actions/attest-build-provenance", "actions/labeler",
  "actions/create-github-app-token", "actions/stale", "actions/first-interaction", "github/codeql-action/",
  "pnpm/action-setup", "oven-sh/setup-bun", "softprops/action-gh-release", "peter-evans/create-pull-request",
  "peter-evans/create-or-update-comment", "aws-actions/configure-aws-credentials", "google-github-actions/auth",
  "google-github-actions/setup-gcloud", "azure/login", "dependabot/fetch-metadata", "cloudflare/wrangler-action",
  // DiffCI's own observer Action only analyses; it runs no repository command (action.yml).
  "diffci/core",
];
/** DiffCI subcommands that run no tests. `verify`, `check`, `pilot` and `enforce-misses` do, so `diffci`
 * followed by anything else stays a test runner (2026-10-29: DiffCI's own observation workflows were
 * 60 of 65 workflow-triggered fallbacks in one dogfood repository's telemetry). */
const DIFFCI_NON_TEST_COMMAND = /\bdiffci["']?(?:\s+--?[\w-]+(?:=\S+)?)*\s+(?:observe|init|version|telemetry|pilot-packet|verify-workflow|validate-specs|mcp)\b/g;

/** A job whose `if` is the literal false never runs (a retired workflow kept for its history). */
function jobDisabled(job: object): boolean {
  const condition = (job as { if?: unknown }).if;
  return condition === false || (typeof condition === "string" && /^\s*(?:\$\{\{\s*)?false(?:\s*\}\})?\s*$/.test(condition));
}
const TEST_RUNNERS = /(?:^|[\s/"'`(;&|])(?:vitest|jest|mocha|ava|tap|playwright|cypress|karma|jasmine|pytest|tox|nox|phpunit|rspec|diffci|ctest)(?=$|[\s"'`);&|])|(?:node|tsx|bun|deno)(?:\s+--?[\w-]+(?:=\S+)?)*\s+--?test\b|\b(?:go|cargo|dotnet|swift|mix|zig)\s+test\b|\b(?:mvn|mvnw|gradle|gradlew|sbt|bazel|make|just)\b/;
const PACKAGE_SCRIPT = /\b(?:npm|pnpm|yarn|bun)\s+(?:(?:run|run-script|-w\s+\S+|--workspace[= ]\S+|--prefix[= ]\S+|--if-present|-r|--recursive|--silent|-s)\s+)*([\w:.-]+)/g;
const INTERPRETER_FILE = /\b(?:node|tsx|ts-node|bash|sh|zsh|pwsh|powershell|python3?|ruby|perl|deno\s+run|bun(?:\s+run)?|npx\s+(?:--\S+\s+)*tsx)\s+(?:-{1,2}[\w-]+(?:=\S+)?\s+)*\.{0,2}\/?[\w./-]+\.(?:m?[jt]s|c[jt]s|sh|ps1|py|rb|pl)\b|(?:^|[\s;&|])\.{1,2}\/[\w./-]+/;
const PACKAGE_MANAGER_BUILTINS = new Set(["ci", "install", "i", "add", "remove", "uninstall", "publish", "pack", "version", "view", "info", "whoami", "login", "config", "cache", "audit", "outdated", "ls", "list", "exec", "dlx", "init", "create", "link", "prune", "dedupe", "rebuild", "set-script", "pkg", "fund", "doctor", "help", "--version", "-v"]);

/** `strict` asks only whether the command runs a test runner or the test script; otherwise running any
 * repository file also counts, because that file may run tests itself. */
function commandRunsTests(text: string, scripts: Readonly<Record<string, string>>, seen: Set<string> = new Set(), strict = false): boolean {
  text = text.replace(DIFFCI_NON_TEST_COMMAND, " ");
  if (TEST_RUNNERS.test(text) || (!strict && INTERPRETER_FILE.test(text))) return true;
  for (const match of text.matchAll(PACKAGE_SCRIPT)) {
    const name = match[1] ?? "";
    if (!name || seen.has(name) || PACKAGE_MANAGER_BUILTINS.has(name)) continue;
    if (name === "test" || name === "t" || name.startsWith("test:")) return true;
    if (typeof scripts[name] !== "string") return true;
    seen.add(name);
    if (commandRunsTests(scripts[name] ?? "", scripts, seen, strict)) return true;
    for (const hook of [`pre${name}`, `post${name}`]) if (typeof scripts[hook] === "string" && commandRunsTests(scripts[hook] ?? "", scripts, seen, strict)) return true;
  }
  return false;
}

/**
 * Can something a workflow names reach the test suite through that workflow? (2026-10-21.)
 *
 * A workflow step that names a file can only influence test results by preparing what a LATER step in
 * the same job runs tests against. A check script run as its own CI step is required CI, which stays
 * authoritative, not part of the suite DiffCI selects from. One dogfood repository's deploy workflow runs two such
 * checks, and counting them blocked every site HTML change in its replayed history.
 *
 * So the answer is true when a job step matching `names` is, or precedes, a step that runs the test
 * command or a test runner, or an action not known to be test-free; when a reusable-workflow job or
 * job-level configuration names it in a job that runs tests; and whenever the YAML cannot be read.
 */
export function workflowFeedsTests(workflowText: string, names: RegExp, scripts: Readonly<Record<string, string>> = {}): boolean {
  let document: unknown;
  try { document = parse(workflowText); } catch { return true; }
  if (!document || typeof document !== "object") return true;
  const jobs = (document as { jobs?: unknown }).jobs;
  if (!jobs || typeof jobs !== "object") return names.test(workflowText);
  const testStep = (step: unknown): boolean => {
    if (!step || typeof step !== "object") return true;
    const { uses, run } = step as { uses?: unknown; run?: unknown };
    if (typeof uses === "string") {
      const action = uses.split("@")[0]!.toLowerCase();
      if (!NON_TEST_ACTIONS.some((known) => known.endsWith("/") ? action.startsWith(known) : action === known)) return true;
    } else if (uses !== undefined) return true;
    if (run !== undefined && typeof run !== "string") return true;
    return typeof run === "string" && commandRunsTests(run, scripts, new Set(), true);
  };
  for (const job of Object.values(jobs as Record<string, unknown>)) {
    if (!job || typeof job !== "object") return true;
    if (jobDisabled(job)) continue;
    const { steps, uses, ...configuration } = job as { steps?: unknown; uses?: unknown };
    if (uses !== undefined) { if (names.test(JSON.stringify(job))) return true; continue; }
    if (!Array.isArray(steps)) return true;
    const firstNaming = steps.findIndex((step) => names.test(JSON.stringify(step)));
    const jobRunsTests = steps.some(testStep);
    if (jobRunsTests && names.test(JSON.stringify(configuration))) return true;
    if (firstNaming !== -1 && steps.slice(firstNaming).some(testStep)) return true;
  }
  return false;
}

/** True unless every job in `workflowText` is made of recognised non-test steps. */
export function workflowMayRunTests(workflowText: string | undefined, scripts: Readonly<Record<string, string>> = {}): boolean {
  if (workflowText === undefined) return true;
  let document: unknown;
  try { document = parse(workflowText); } catch { return true; }
  if (!document || typeof document !== "object") return true;
  const jobs = (document as { jobs?: unknown }).jobs;
  if (!jobs || typeof jobs !== "object") return true;
  for (const job of Object.values(jobs as Record<string, unknown>)) {
    if (!job || typeof job !== "object") return true;
    if (jobDisabled(job)) continue;
    const record = job as { uses?: unknown; steps?: unknown; container?: unknown; services?: unknown };
    if (record.uses !== undefined) return true;
    if (!Array.isArray(record.steps)) return true;
    for (const step of record.steps) {
      if (!step || typeof step !== "object") return true;
      const { uses, run } = step as { uses?: unknown; run?: unknown };
      if (typeof uses === "string") {
        const action = uses.split("@")[0]!.toLowerCase();
        if (!NON_TEST_ACTIONS.some((known) => known.endsWith("/") ? action.startsWith(known) : action === known)) return true;
      } else if (uses !== undefined) return true;
      if (typeof run === "string" && commandRunsTests(run, scripts)) return true;
      if (run !== undefined && typeof run !== "string") return true;
    }
  }
  return false;
}
