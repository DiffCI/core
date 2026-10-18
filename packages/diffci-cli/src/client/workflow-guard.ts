/**
 * Can this installation change what the repository's CI does? (Phase 02, 2026-08-26.)
 *
 * The Phase 02 exit criterion is "seven days in a third-party repository, CI byte-identical". Two
 * different things have to hold for that, and only one of them is about DiffCI's own code:
 *
 *   1. The observer must not touch the checkout. That is checked at run time, per run, by comparing
 *      HEAD and `git status --porcelain` before and after (src/client/observe.ts).
 *   2. The observer's JOB must not be able to influence any other job. That is a property of the
 *      workflow file, not of DiffCI, and no amount of care inside the observer can establish it.
 *
 * This module is (2). It reads the repository's own workflow YAML and looks for the specific ways an
 * added job stops being inert:
 *
 *   - Another job `needs:` it, so a DiffCI failure blocks real work.
 *   - It is not `continue-on-error: true`, so a DiffCI failure becomes the WORKFLOW's conclusion - which
 *     is what a required status check and a merge queue read. This is the one that surprises people:
 *     the build jobs all pass, and the pull request is still red.
 *   - It is not a dedicated job: DiffCI steps sit in a job that also builds or tests, where a slow
 *     install or a mutated file is no longer isolated from anything.
 *   - It can write. An observer with `contents: write` is one bug away from not being an observer.
 *
 * Findings are severity-ranked and carry stable codes. BLOCKING means the byte-identical claim cannot
 * be made from this workflow, and the operator should fix the workflow before the seven days start -
 * not that DiffCI failed.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

import type { WorkflowFinding } from "./report.js";

/** Steps a dedicated observation job may legitimately contain besides the DiffCI action itself. */
const ALLOWED_STEP_ACTIONS = [
  "actions/checkout",
  "actions/setup-node",
  "actions/cache",
  "actions/upload-artifact",
];

/** Permission scopes that make a job something other than a reader. `contents: read` is fine. */
const WRITE_PERMISSION = "write";

export interface WorkflowGuardOptions {
  /**
   * How a step is recognised as the DiffCI action. Defaults to any `uses:` mentioning "diffci",
   * which covers `owner/DiffCI.com@sha`, a local `./.github/actions/diffci`, and a future npm-published
   * action alike.
   */
  actionPattern?: RegExp;
}
export interface WorkflowGuardResult {
  /** "<workflow file>#<job id>" for every job that runs the DiffCI action. */
  observerJobs: string[];
  findings: WorkflowFinding[];
  /** Workflow files that were read. Zero means nothing was checked, which is not a pass. */
  workflowsScanned: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function permissionsGrantWrite(permissions: unknown): string[] {
  if (permissions === "write-all") return ["write-all"];
  if (!isRecord(permissions)) return [];
  return Object.entries(permissions)
    .filter(([, level]) => level === WRITE_PERMISSION)
    .map(([scope]) => scope);
}

function listWorkflowFiles(repoPath: string): string[] {
  const dir = join(repoPath, ".github", "workflows");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort()
    .map((name) => join(".github", "workflows", name));
}

/**
 * `uses: owner/repo@ref` is pinned when `ref` is a full commit SHA. A tag or branch means the action's
 * contents can change without the repository changing, which is exactly the property an installation
 * promising byte-identical CI should not have.
 */
/**
 * Does this step run DiffCI? Two forms have to be recognised, and only one of them has "diffci" in the
 * string: a third-party repository writes `uses: owner/DiffCI.com@<sha>`, while this repository (and
 * anyone vendoring the action) writes `uses: ./`, which names a directory. A guard that missed the
 * local form would report "no job runs the DiffCI action" for the one installation we control - and
 * silently check nothing.
 */
/**
 * Does this step run DiffCI via a `run:` command rather than `uses:`?
 *
 * Since DiffCI became a proprietary package rather than a public Action, the generated workflow
 * installs and invokes the agent with `run:` steps. A guard that only understood `uses:` reported
 * "no job runs DiffCI" for the installation the product itself generates - and therefore checked
 * nothing at all, while still returning a clean result. That is the worst possible failure for a
 * safety check, so it is matched explicitly here.
 */
function runReferencesDiffCi(run: string, actionPattern: RegExp): boolean {
  return actionPattern.test(commandText(run));
}

/** A fail-closed `verify` job is intentionally allowed to affect its own check conclusion. */
function runInvokesDiffCiVerification(run: string): boolean {
  const command = commandText(run);
  return /\bdiffci:verify\b/i.test(command) ||
    /\b(?:diffci(?:\.com\/diffci)?(?:@[^\s"']+)?|cli\.(?:js|ts))["']?\s+verify(?=\s|$)/i.test(command);
}

/**
 * The part of a `run:` script that can invoke something: shell comments and URLs are removed line by
 * line before matching. A URL is data handed to a command, not a command - DiffCI's own deploy
 * workflow curls `https://diffci-research-sandbox.….workers.dev/…` and was reported as running the
 * observer, then told its deploy job was a badly installed DiffCI job (2026-09-06). Everything the
 * product generates keeps matching: `npm install … @diffci/observer@1.4.2`,
 * `"${RUNNER_TEMP}/diffci/node_modules/.bin/diffci" observe`, `docker run … <image>@sha256:… observe`,
 * `npx @diffci/observer observe` all name DiffCI outside any URL.
 */
function commandText(run: string): string {
  return run
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, "$1").replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, " "))
    // A literal npm registry tag removal neither installs nor invokes the observer. Match the
    // entire line, with only a literal `|| true` allowed, so appended observer commands and shell
    // substitutions still take the conservative inspection path. Other script lines remain intact.
    .filter((line) => !/^\s*npm(?:\.cmd)?\s+dist-tag\s+(?:rm|remove)\s+@?[\w./-]+\s+[\w.-]+(?:\s*\|\|\s*true)?\s*$/.test(line))
    .join("\n");
}

/**
 * Returns the offending specifier if a `run:` command installs DiffCI at anything other than an exact
 * version or an image digest. This is the `run:`-shaped equivalent of the commit-SHA rule above: a
 * customer who edits the generated "1.4.2" into "latest" has re-opened exactly the hole the generated
 * workflow was written to close, and should be told so rather than getting a clean report.
 */
function findMutableAgentReference(run: string): string | undefined {
  for (const match of commandText(run).matchAll(/(@?[A-Za-z0-9._/-]*diffci[A-Za-z0-9._/-]*)@([^\s"']+)/gi)) {
    const version = match[2]!;
    if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) continue;
    if (/^sha256:[0-9a-f]{64}$/.test(version)) continue;
    return match[0];
  }
  return undefined;
}

function referencesDiffCi(uses: string, repoPath: string, actionPattern: RegExp): boolean {
  if (actionPattern.test(uses)) return true;
  if (!uses.startsWith("./")) return false;
  for (const file of ["action.yml", "action.yaml"]) {
    const candidate = join(repoPath, uses.slice(2), file);
    if (!existsSync(candidate)) continue;
    try {
      const parsed: unknown = YAML.parse(readFileSync(candidate, "utf8"));
      if (isRecord(parsed) && typeof parsed.name === "string" && actionPattern.test(parsed.name)) return true;
    } catch {
      // An unparseable local action is reported by the workflow scan itself, not silently trusted.
    }
  }
  return false;
}

function isPinnedToSha(uses: string): boolean {
  const at = uses.lastIndexOf("@");
  if (at === -1) return uses.startsWith("./") || uses.startsWith("docker://");
  return /^[0-9a-f]{40}$/i.test(uses.slice(at + 1));
}

export function auditWorkflows(repoPath: string, options: WorkflowGuardOptions = {}): WorkflowGuardResult {
  const actionPattern = options.actionPattern ?? /diffci/i;
  const findings: WorkflowFinding[] = [];
  const observerJobs: string[] = [];
  const workflowsScanned: string[] = [];

  for (const relativePath of listWorkflowFiles(repoPath)) {
    let document: unknown;
    try {
      document = YAML.parse(readFileSync(join(repoPath, relativePath), "utf8"));
    } catch (error) {
      findings.push({
        severity: "WARNING",
        code: "WORKFLOW_UNPARSEABLE",
        message: `could not parse this workflow, so it was not checked: ${(error as Error).message.split("\n")[0]}`,
        workflow: relativePath,
      });
      continue;
    }
    workflowsScanned.push(relativePath);
    if (!isRecord(document)) continue;

    const jobs = isRecord(document.jobs) ? document.jobs : {};
    const workflowPermissions = permissionsGrantWrite(document.permissions);

    for (const [jobId, rawJob] of Object.entries(jobs)) {
      if (!isRecord(rawJob)) continue;
      const steps = asArray(rawJob.steps).filter(isRecord);
      const isDiffCiStep = (step: Record<string, unknown>): boolean =>
        (typeof step.uses === "string" && referencesDiffCi(step.uses, repoPath, actionPattern)) ||
        (typeof step.run === "string" && runReferencesDiffCi(step.run, actionPattern));
      const isVerificationStep = (step: Record<string, unknown>): boolean =>
        typeof step.run === "string" && runInvokesDiffCiVerification(step.run);
      // This guard proves that observation jobs are inert. A dedicated fail-closed verification job
      // is a different product surface: making its own status check fail is its intended contract.
      const diffciSteps = steps.filter((step) => isDiffCiStep(step) && !isVerificationStep(step));
      if (diffciSteps.length === 0) continue;

      observerJobs.push(`${relativePath}#${jobId}`);

      // 1. Nothing may depend on the observer.
      const dependants = Object.entries(jobs)
        .filter(([otherId, otherJob]) => otherId !== jobId && isRecord(otherJob) && asArray(otherJob.needs).includes(jobId))
        .map(([otherId]) => otherId);
      if (dependants.length > 0) {
        findings.push({
          severity: "BLOCKING",
          code: "JOB_IS_A_DEPENDENCY",
          message: `job "${jobId}" is listed in needs: by ${dependants.join(", ")} - a DiffCI failure would block ${dependants.length === 1 ? "that job" : "those jobs"}. Remove the dependency.`,
          workflow: relativePath,
          job: jobId,
        });
      }

      // 2. The observer's outcome must not become the workflow's outcome.
      if (rawJob["continue-on-error"] !== true) {
        findings.push({
          severity: "BLOCKING",
          code: "JOB_NOT_CONTINUE_ON_ERROR",
          message: `job "${jobId}" is missing continue-on-error: true - without it a DiffCI failure fails the whole workflow run, which a required status check or merge queue will read as a failed build.`,
          workflow: relativePath,
          job: jobId,
        });
      }

      // 3. The observer must be alone in its job.
      const foreignSteps = steps.filter((step) => {
        // DiffCI's own steps are never foreign, whichever form they take. This has to come first: since
        // DiffCI became a package rather than an Action it invokes itself with `run:`, and the rule
        // below - "any run: step is real work" - was written when that could not happen. Leaving the
        // order the other way round made the product's own generated workflow fail its own guard.
        if (isDiffCiStep(step) && !isVerificationStep(step)) return false;
        // Any other shell step in this job IS real work, and DiffCI must not share a job with it.
        if (typeof step.run === "string") return true;
        if (typeof step.uses !== "string") return false;
        return !ALLOWED_STEP_ACTIONS.some((allowed) => step.uses === allowed || (step.uses as string).startsWith(`${allowed}@`));
      });
      if (foreignSteps.length > 0) {
        findings.push({
          severity: "BLOCKING",
          code: "JOB_NOT_DEDICATED",
          message: `job "${jobId}" contains ${foreignSteps.length} step(s) that are not part of observation - DiffCI must run in a job of its own so it shares nothing with real work.`,
          workflow: relativePath,
          job: jobId,
        });
      }

      // 4. An observer that can write is not an observer.
      const jobPermissions = rawJob.permissions === undefined ? workflowPermissions : permissionsGrantWrite(rawJob.permissions);
      if (jobPermissions.length > 0) {
        findings.push({
          severity: "WARNING",
          code: "JOB_HAS_WRITE_PERMISSIONS",
          message: `job "${jobId}" ${rawJob.permissions === undefined ? "inherits" : "declares"} write permission for: ${jobPermissions.join(", ")}. Set permissions: { contents: read } on the job.`,
          workflow: relativePath,
          job: jobId,
        });
      }

      // 5. A mutable reference means the code that runs here can change without this repository
      // changing. Two forms have to be checked, because DiffCI is invoked both ways: a `uses:` step
      // must name a commit SHA, and a `run:` step installing the agent must name an exact version.
      // Checking only the first would let someone edit the generated "1.4.2" into "latest" and still
      // get a clean report - which is the same hole, reopened by hand.
      for (const step of diffciSteps) {
        if (typeof step.uses === "string") {
          if (!isPinnedToSha(step.uses)) {
            findings.push({
              severity: "WARNING",
              code: "ACTION_NOT_PINNED",
              message: `"${step.uses}" is not pinned to a 40-character commit SHA, so what runs here can change without this repository changing.`,
              workflow: relativePath,
              job: jobId,
            });
          }
          continue;
        }
        if (typeof step.run === "string") {
          const mutable = findMutableAgentReference(step.run);
          if (mutable) {
            findings.push({
              severity: "WARNING",
              code: "AGENT_NOT_PINNED",
              message: `"${mutable}" is not an exact version, so the DiffCI agent running here can change without this repository changing.`,
              workflow: relativePath,
              job: jobId,
            });
          }
        }
      }

      // 6. A shared concurrency group lets this job cancel another one.
      const group = isRecord(rawJob.concurrency) ? rawJob.concurrency.group : rawJob.concurrency;
      if (typeof group === "string") {
        const sharing = Object.entries(jobs)
          .filter(([otherId, otherJob]) => {
            if (otherId === jobId || !isRecord(otherJob)) return false;
            const otherGroup = isRecord(otherJob.concurrency) ? otherJob.concurrency.group : otherJob.concurrency;
            return otherGroup === group;
          })
          .map(([otherId]) => otherId);
        if (sharing.length > 0) {
          findings.push({
            severity: "WARNING",
            code: "JOB_SHARES_CONCURRENCY_GROUP",
            message: `job "${jobId}" shares concurrency group "${group}" with ${sharing.join(", ")}, so one can cancel the other.`,
            workflow: relativePath,
            job: jobId,
          });
        }
      }
    }
  }

  return { observerJobs, findings, workflowsScanned };
}

/** True when nothing found would let the observation change what the rest of CI does. */
export function isNonInterfering(result: WorkflowGuardResult): boolean {
  return result.findings.every((finding) => finding.severity !== "BLOCKING");
}
