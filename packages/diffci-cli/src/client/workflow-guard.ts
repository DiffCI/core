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

import { inferFullCommand } from "./full-command.js";
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
   * which covers `DiffCI/core@sha`, a local `./.github/actions/diffci`, and a future npm-published
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
 * string: a third-party repository writes `uses: DiffCI/core@<sha>`, while this repository (and
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
 *
 * The same holds for four other kinds of data (2026-11-02): plain `echo`/`printf` messages, `gh api`
 * fields and `repos/...` paths, SCREAMING_SNAKE environment variable names, and `.json` paths, which
 * are read rather than run. Core's own release workflow mentions `DIFFCI_PRODUCT_DISPATCH_TOKEN` in an
 * error message, dispatches `-f event_type=diffci-core-release` to `repos/DiffCI/DiffCI.com`, and reads
 * `./packages/diffci-cli/package.json`, and `check` reported both of those jobs as badly installed
 * observers. An echo line with a substitution, pipe or command separator is kept, because it can run
 * something.
 */
function commandText(run: string): string {
  return run
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, "$1").replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, " "))
    .map((line) => (/^\s*(?:echo|printf)\s/.test(line) && !/\$\(|`|\||&&|;/.test(line) ? "" : line))
    .map((line) => line
      .replace(/(^|\s)(?:-[fF]|--(?:raw-)?field)\s+(?:"[^"]*"|'[^']*'|\S+)/g, "$1")
      .replace(/(^|[\s"'])repos\/[^\s"']+/g, "$1")
      .replace(/\$?\{?\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b\}?/g, " ")
      .replace(/[^\s"'()]*\.json\b/g, " "))
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

/**
 * Enforce mode audit (docs/enforce-mode-01-plan.md, step 4).
 *
 * The non-interference audit above proves an observer cannot change CI. Enforce mode deliberately does
 * change it - pull requests stop running the full suite - so it needs the opposite guarantees:
 *
 *   1. There is an enforcing job, and it is a real gate (not continue-on-error, nothing like the dry run).
 *   2. Its kill switch is wired to the repository variable. A hardcoded "on" would mean flipping the
 *      variable no longer stops enforcement, and the plan's main rollback silently stops working.
 *   3. The full suite still runs on every push to main. That run is the safety net and the ground truth
 *      the miss detector reads; an installation without it skips tests with nothing checking the skips.
 *
 * "Cannot tell" is a finding, never a pass: an `if:` this module cannot evaluate, or a full command it
 * cannot infer, is BLOCKING, because the whole point of the audit is to prove (3) rather than assume it.
 */
export interface EnforceAuditOptions {
  /** The branch whose pushes must run the full suite. */
  defaultBranch?: string;
  /** Overrides the full command inferred from the repository (`npm test` and its equivalents). */
  fullCommand?: string;
}

export interface EnforceAuditResult {
  /** "<workflow file>#<job id>" for every job that enforces (runs `verify --policy enforce` as a gate). */
  enforceJobs: string[];
  /** "<workflow file>#<job id>" for every job that runs the full suite on push to the default branch. */
  fullSuiteJobs: string[];
  /** The command recognised as the full suite, or undefined when none could be inferred. */
  fullCommand?: string;
  findings: WorkflowFinding[];
  workflowsScanned: string[];
}

/** Where repository-wide findings (no single workflow to blame) point. */
const WORKFLOWS_DIR = join(".github", "workflows");
const ENFORCE_VARIABLE_EXPRESSION =/^\$\{\{\s*vars\.DIFFCI_ENFORCE\s*\}\}$/;

function runInvokesEnforcePolicy(run: string): boolean {
  return runInvokesDiffCiVerification(run) && /--policy[=\s]+["']?enforce\b/.test(commandText(run));
}

/** `npm run test` and `npm test` are the same command; so are the pnpm/yarn/bun pairs. */
function normalizeTestCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ").replace(/^(npm|pnpm|yarn|bun) run test$/, "$1 test");
}

function runInvokesFullCommand(run: string, fullCommand: string): boolean {
  const target = normalizeTestCommand(fullCommand);
  return commandText(run).split("\n").some((line) => normalizeTestCommand(line) === target);
}

function globToRegExp(glob: string): RegExp {
  const pattern = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${pattern}$`);
}

/**
 * Does this workflow run on every push to `branch`? A `paths` or `paths-ignore` filter means some pushes
 * do not trigger it, and those are exactly the pushes nothing would check, so it does not count.
 */
function triggersOnEveryPush(on: unknown, branch: string): { ok: boolean; reason?: string } {
  if (on === "push") return { ok: true };
  if (Array.isArray(on)) return { ok: on.includes("push") };
  if (!isRecord(on) || !("push" in on)) return { ok: false };
  const push = on.push;
  if (push === null || push === undefined) return { ok: true };
  if (!isRecord(push)) return { ok: false };
  if (push.paths !== undefined || push["paths-ignore"] !== undefined) {
    return { ok: false, reason: "its push trigger has a paths filter, so some pushes do not run it" };
  }
  const branches = asArray(push.branches).filter((value): value is string => typeof value === "string");
  const ignored = asArray(push["branches-ignore"]).filter((value): value is string => typeof value === "string");
  if (ignored.some((glob) => globToRegExp(glob).test(branch))) return { ok: false };
  if (push.branches === undefined) {
    // `tags:` alone restricts push to tags; branches are then not covered.
    return { ok: push.tags === undefined && push["tags-ignore"] === undefined };
  }
  let included = false;
  for (const glob of branches) {
    if (glob.startsWith("!")) {
      if (globToRegExp(glob.slice(1)).test(branch)) included = false;
    } else if (globToRegExp(glob).test(branch)) {
      included = true;
    }
  }
  return { ok: included };
}

type Truth = "TRUE" | "FALSE" | "UNKNOWN";
type Value = { known: true; value: string | boolean } | { known: false };

/**
 * Evaluates an `if:` for a push to `branch` with Kleene logic. `vars.*`, `inputs.*` and anything else
 * not fixed by "this is a push to the default branch" are UNKNOWN, so a condition only counts as TRUE
 * when it holds whatever those are. Unsupported syntax is UNKNOWN as well, never FALSE or TRUE.
 */
export function evaluatePushCondition(expression: string, branch: string): Truth {
  const source = expression.trim().replace(/^\$\{\{\s*|\s*\}\}$/g, "").trim();
  const known: Record<string, string> = {
    "github.event_name": "push",
    "github.ref": `refs/heads/${branch}`,
    "github.ref_name": branch,
    "github.ref_type": "branch",
  };
  const tokens = source.match(/'(?:[^']|'')*'|"[^"]*"|&&|\|\||==|!=|!|\(|\)|[A-Za-z_][\w.-]*\(\)|[A-Za-z_][\w.-]*/g);
  if (!tokens || tokens.join("").replace(/\s/g, "") !== source.replace(/\s/g, "")) return "UNKNOWN";
  let index = 0;
  const peek = (): string | undefined => tokens[index];
  const truth = (value: Value): Truth => (!value.known ? "UNKNOWN" : value.value === false || value.value === "" ? "FALSE" : "TRUE");
  const fromTruth = (value: Truth): Value => (value === "UNKNOWN" ? { known: false } : { known: true, value: value === "TRUE" });

  const operand = (): Value => {
    const token = tokens[index++];
    if (token === undefined) return { known: false };
    if (token === "(") {
      const inner = or();
      if (tokens[index++] !== ")") return { known: false };
      return fromTruth(inner);
    }
    if (token.startsWith("'")) return { known: true, value: token.slice(1, -1).replace(/''/g, "'") };
    if (token.startsWith('"')) return { known: true, value: token.slice(1, -1) };
    if (token === "true" || token === "false") return { known: true, value: token === "true" };
    if (token === "always()" || token === "success()") return { known: true, value: true };
    if (token === "failure()" || token === "cancelled()") return { known: true, value: false };
    if (token in known) return { known: true, value: known[token]! };
    return { known: false };
  };
  const comparison = (): Truth => {
    if (peek() === "!") {
      index++;
      const inner = comparison();
      return inner === "UNKNOWN" ? "UNKNOWN" : inner === "TRUE" ? "FALSE" : "TRUE";
    }
    const left = operand();
    const operator = peek();
    if (operator !== "==" && operator !== "!=") return truth(left);
    index++;
    const right = operand();
    if (!left.known || !right.known) return "UNKNOWN";
    // GitHub compares strings case-insensitively.
    const equal = String(left.value).toLowerCase() === String(right.value).toLowerCase();
    return (operator === "==") === equal ? "TRUE" : "FALSE";
  };
  const and = (): Truth => {
    let result = comparison();
    while (peek() === "&&") {
      index++;
      const next = comparison();
      result = result === "FALSE" || next === "FALSE" ? "FALSE" : result === "UNKNOWN" || next === "UNKNOWN" ? "UNKNOWN" : "TRUE";
    }
    return result;
  };
  function or(): Truth {
    let result = and();
    while (peek() === "||") {
      index++;
      const next = and();
      result = result === "TRUE" || next === "TRUE" ? "TRUE" : result === "UNKNOWN" || next === "UNKNOWN" ? "UNKNOWN" : "FALSE";
    }
    return result;
  }
  const result = or();
  return index === tokens.length ? result : "UNKNOWN";
}

function conditionHolds(condition: unknown, branch: string): Truth {
  if (condition === undefined) return "TRUE";
  if (typeof condition === "boolean") return condition ? "TRUE" : "FALSE";
  if (typeof condition !== "string") return "UNKNOWN";
  return evaluatePushCondition(condition, branch);
}

export function auditEnforceWorkflows(repoPath: string, options: EnforceAuditOptions = {}): EnforceAuditResult {
  const branch = options.defaultBranch ?? "main";
  const findings: WorkflowFinding[] = [];
  const enforceJobs: string[] = [];
  const fullSuiteJobs: string[] = [];
  const workflowsScanned: string[] = [];
  const unprovable: string[] = [];
  const inferred = options.fullCommand ? { command: options.fullCommand, reason: "--full-command" } : inferFullCommand(repoPath);
  const fullCommand = inferred.command;

  if (!fullCommand) {
    findings.push({
      severity: "BLOCKING",
      code: "FULL_COMMAND_UNKNOWN",
      workflow: WORKFLOWS_DIR,
      message: `could not infer the full test command (${inferred.reason}), so it cannot be shown that the full suite still runs on ${branch}. Pass --full-command.`,
    });
  }

  for (const relativePath of listWorkflowFiles(repoPath)) {
    let document: unknown;
    try {
      document = YAML.parse(readFileSync(join(repoPath, relativePath), "utf8"));
    } catch {
      // The non-interference audit reports unparseable workflows; here they simply prove nothing.
      continue;
    }
    workflowsScanned.push(relativePath);
    if (!isRecord(document)) continue;
    const jobs = isRecord(document.jobs) ? document.jobs : {};
    const workflowEnv = isRecord(document.env) ? document.env : {};
    const trigger = triggersOnEveryPush(document.on, branch);

    for (const [jobId, rawJob] of Object.entries(jobs)) {
      if (!isRecord(rawJob)) continue;
      const steps = asArray(rawJob.steps).filter(isRecord);
      const where = `${relativePath}#${jobId}`;

      // 1 + 2. Enforcing jobs. A continue-on-error job is a dry run whatever it calls itself.
      const enforceSteps = steps.filter((step) => typeof step.run === "string" && runInvokesEnforcePolicy(step.run));
      if (enforceSteps.length > 0 && rawJob["continue-on-error"] !== true) {
        enforceJobs.push(where);
        const jobEnv = isRecord(rawJob.env) ? rawJob.env : {};
        for (const step of enforceSteps) {
          const stepEnv = isRecord(step.env) ? step.env : {};
          const value = stepEnv.DIFFCI_ENFORCE ?? jobEnv.DIFFCI_ENFORCE ?? workflowEnv.DIFFCI_ENFORCE;
          if (typeof value !== "string" || !ENFORCE_VARIABLE_EXPRESSION.test(value.trim())) {
            findings.push({
              severity: "BLOCKING",
              code: "ENFORCE_KILL_SWITCH_NOT_WIRED",
              message: `job "${jobId}" runs verify --policy enforce with DIFFCI_ENFORCE ${value === undefined ? "unset" : `set to ${JSON.stringify(value)}`} - set it to \${{ vars.DIFFCI_ENFORCE }} so turning the repository variable off stops enforcement.`,
              workflow: relativePath,
              job: jobId,
            });
          }
        }
      }

      // 3. The full suite on push to the default branch.
      if (!fullCommand || !trigger.ok) continue;
      const jobCondition = conditionHolds(rawJob.if, branch);
      if (jobCondition === "FALSE") continue;
      for (const step of steps) {
        if (typeof step.run !== "string" || !runInvokesFullCommand(step.run, fullCommand)) continue;
        if (step["working-directory"] !== undefined && step["working-directory"] !== ".") continue;
        const stepCondition = conditionHolds(step.if, branch);
        if (jobCondition === "TRUE" && stepCondition === "TRUE") {
          fullSuiteJobs.push(where);
          break;
        }
        if (stepCondition !== "FALSE") unprovable.push(where);
      }
    }
  }

  if (enforceJobs.length === 0) {
    findings.push({
      severity: "BLOCKING",
      code: "ENFORCE_JOB_MISSING",
      workflow: WORKFLOWS_DIR,
      message: "no job runs `diffci verify --policy enforce` as a gate. A continue-on-error job is a dry run and does not count.",
    });
  }
  if (fullCommand && fullSuiteJobs.length === 0) {
    const detail = unprovable.length > 0
      ? ` ${unprovable.join(", ")} might, but its if: could not be shown to hold for every push to ${branch}.`
      : "";
    findings.push({
      severity: "BLOCKING",
      code: "FULL_SUITE_NOT_ON_DEFAULT_BRANCH",
      workflow: WORKFLOWS_DIR,
      message: `no job provably runs "${fullCommand}" on every push to ${branch}.${detail} Enforce mode skips tests on pull requests; without that run nothing checks what was skipped.`,
    });
  }

  return { enforceJobs, fullSuiteJobs, fullCommand, findings, workflowsScanned };
}

/** True when nothing found would let the observation change what the rest of CI does. */
export function isNonInterfering(result: Pick<WorkflowGuardResult, "findings">): boolean {
  return result.findings.every((finding) => finding.severity !== "BLOCKING");
}
