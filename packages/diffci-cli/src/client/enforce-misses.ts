/**
 * Enforce mode miss detection (docs/enforce-mode-01-plan.md, step 5).
 *
 * After a full run on `main`, every failing test is held against the enforce receipts of the pull
 * requests merged since the last full run that was recorded. A MISS is a test that fails on `main`,
 * fails again when re-run, was not failing before those pull requests merged, and was left out by a
 * pull request whose receipt says `selection: "selected"`. That is exactly the failure enforce mode
 * would have let through.
 *
 * Everything here is pure: parsing, classification and the report. GitHub, git and the re-run live in
 * `enforce-misses-collect.ts`, so each classification can be tested without a repository or a token.
 *
 * Nothing here changes configuration. A miss produces the exact `enforce.openUnsafeMisses` entry for
 * a human to add; re-enabling enforcement is never automatic.
 */
import { isAbsolute, relative, resolve } from "node:path";

import type { VerificationReport } from "./verify.js";

export const MISS_REPORT_SCHEMA = "diffci.enforce-misses.v1" as const;

export interface TestOutcome {
  /** `file > suite > name`: stable across runs of the same commit, so it can be matched between them. */
  id: string;
  /** Repository-relative, forward slashes. Empty when the reporter gave no file. */
  file: string;
  name: string;
  failed: boolean;
  skipped: boolean;
}

/** The receipt fields the detector reads; older receipts may lack `selected_tests`. */
export type ReceiptFields = Pick<VerificationReport, "schema" | "selection" | "selected_tests" | "command" | "enforcement" | "commit_range">;

export interface PullRequestReceipt {
  artifact: string;
  report: ReceiptFields;
}

export interface MergedPullRequest {
  number: number;
  title?: string;
  mergeSha: string;
  headSha: string;
  receipt?: PullRequestReceipt;
}

/**
 * What one merged pull request's receipt says about one failing test.
 * - `missed`: the receipt selected tests and this test's file was not among them.
 * - `selection-unrecorded`: the receipt selected tests but does not say which; counted as a miss,
 *   because "cannot tell" must not read as "was covered".
 * - `selected` / `ran-full`: the pull request ran this test, so it did not skip it.
 * - `no-tests-run`: a `none` receipt (blocked analysis). Enforce mode never passes such a run.
 * - `no-receipt`: no dry-run artifact was found for the pull request's head.
 */
export type PullRequestVerdict = "missed" | "selection-unrecorded" | "selected" | "ran-full" | "no-tests-run" | "no-receipt";

export type FailureClass =
  /** Deterministic, new, and skipped by at least one `selected` pull request. Counts. */
  | "miss"
  /** Passed when re-run. Logged, never counted. */
  | "flaky"
  /** Already failing at the start of the window, so no pull request in it introduced it. */
  | "pre-existing"
  /** Every pull request with a receipt ran it (selected it, or ran the full suite). */
  | "covered"
  /** No merged pull request with a receipt to hold it against (direct push, drift, environment). */
  | "unattributed";

export interface ClassifiedFailure {
  id: string;
  file: string;
  name: string;
  classification: FailureClass;
  pull_requests: { number: number; verdict: PullRequestVerdict; artifact?: string }[];
  detail: string;
}

export interface UnsafeMissEntry {
  test: string;
  pullRequest: number;
  receipt: string | null;
  mainSha: string;
  detectedAt: string;
  run?: string;
}

export type WindowSource = "detector-record" | "green-full-run" | "none";

export interface MissReport {
  schema: typeof MISS_REPORT_SCHEMA;
  produced_at: string;
  head_sha: string;
  run_url?: string;
  full_suite: "passed" | "failed";
  rerun: "done" | "not-run";
  window: { from_sha: string | null; source: WindowSource };
  pull_requests: { number: number; merge_sha: string; head_sha: string; receipt: string | null; selection: ReceiptFields["selection"] | null }[];
  /** Ids of the failures that were not flaky. The next run reads these as its pre-existing set. */
  deterministic_failures: string[];
  failures: ClassifiedFailure[];
  misses: number;
  open_unsafe_misses: UnsafeMissEntry[];
  notes: string[];
}

// ---------------------------------------------------------------------------------------------------
// JUnit (node:test's `--test-reporter=junit`, which also matches the common Jest/Vitest shape)

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith("#")) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[lower]!;
  });
}

function attributes(source: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of source.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) result[match[1]!] = decodeEntities(match[2]!);
  return result;
}

/** Repository-relative with forward slashes; paths outside the repository stay absolute. */
export function normalizeTestPath(path: string, repoRoot: string): string {
  const slashed = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!slashed) return "";
  if (!isAbsolute(path)) return slashed;
  const inside = relative(resolve(repoRoot), resolve(path));
  return inside && !inside.startsWith("..") && !isAbsolute(inside) ? inside.replace(/\\/g, "/") : slashed;
}

/** Testcases in document order, named by their enclosing suites. Repeated ids are merged: any failure wins. */
export function parseJunit(xml: string, repoRoot: string): TestOutcome[] {
  const byId = new Map<string, TestOutcome>();
  const suites: string[] = [];
  let current: TestOutcome | undefined;
  const finish = () => {
    if (!current) return;
    const seen = byId.get(current.id);
    if (seen) {
      seen.failed ||= current.failed;
      seen.skipped &&= current.skipped;
    } else byId.set(current.id, current);
    current = undefined;
  };
  // Attribute values may hold a raw `>` (failure messages), so the tag body skips over quoted strings.
  const tags = /<(\/?)(testsuite|testcase|failure|error|skipped)\b((?:[^>"]|"[^"]*")*?)(\/?)>/g;
  for (const [, closing, tag, body, selfClosing] of xml.matchAll(tags)) {
    if (tag === "testsuite") {
      if (closing) suites.pop();
      else if (!selfClosing) suites.push(attributes(body!).name ?? "");
    } else if (tag === "testcase") {
      if (closing) {
        finish();
        continue;
      }
      finish();
      const attrs = attributes(body!);
      const file = normalizeTestPath(attrs.file ?? "", repoRoot);
      const name = [...suites, attrs.name ?? ""].filter(Boolean).join(" > ");
      current = { id: `${file} > ${name}`, file, name, failed: attrs.failure !== undefined, skipped: false };
      if (selfClosing) finish();
    } else if (current && !closing) {
      if (tag === "skipped") current.skipped = true;
      else current.failed = true;
    }
  }
  finish();
  return [...byId.values()];
}

// ---------------------------------------------------------------------------------------------------
// Receipts

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

function normalizeSelected(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * The test files a `selected` receipt ran. Receipts from before `selected_tests` existed fall back to the
 * test-file arguments of the command. `undefined` means the receipt does not say.
 */
export function selectedFiles(report: ReceiptFields): Set<string> | undefined {
  if (Array.isArray(report.selected_tests)) return new Set(report.selected_tests.map(normalizeSelected));
  const fromCommand = (report.command ?? "")
    .split(/\s+/)
    .map((token) => normalizeSelected(token.replace(/^["']|["']$/g, "")))
    .filter((token) => TEST_FILE.test(token));
  return fromCommand.length > 0 ? new Set(fromCommand) : undefined;
}

function verdict(pr: MergedPullRequest, file: string): PullRequestVerdict {
  const report = pr.receipt?.report;
  if (!report) return "no-receipt";
  if (report.selection === "full") return "ran-full";
  if (report.selection !== "selected") return "no-tests-run";
  const files = selectedFiles(report);
  if (!files) return "selection-unrecorded";
  return files.has(file) ? "selected" : "missed";
}

// ---------------------------------------------------------------------------------------------------
// Classification

export interface ClassifyInput {
  /** Every testcase of the full run on `main`; only failures are classified. */
  fullRun: TestOutcome[];
  /** The re-run of the failing files, or undefined when no re-run was possible. */
  rerun: TestOutcome[] | undefined;
  /** Ids already failing at the start of the window. */
  baseline: readonly string[];
  pullRequests: MergedPullRequest[];
}

export function classifyFailures(input: ClassifyInput): ClassifiedFailure[] {
  const rerun = new Map((input.rerun ?? []).map((outcome) => [outcome.id, outcome]));
  const baseline = new Set(input.baseline);
  return input.fullRun
    .filter((outcome) => outcome.failed)
    .map((outcome): ClassifiedFailure => {
      const base = { id: outcome.id, file: outcome.file, name: outcome.name };
      const again = rerun.get(outcome.id);
      if (again && !again.failed && !again.skipped) {
        return { ...base, classification: "flaky", pull_requests: [], detail: "passed when re-run" };
      }
      // Not found in the re-run (or no re-run at all) is treated as deterministic: "cannot tell" must
      // never be what keeps a miss from being counted.
      const rerunNote = !input.rerun ? "not re-run" : again ? "failed again when re-run" : "absent from the re-run";
      if (baseline.has(outcome.id)) {
        return { ...base, classification: "pre-existing", pull_requests: [], detail: `already failing at the start of the window; ${rerunNote}` };
      }
      const pullRequests = input.pullRequests.map((pr) => ({
        number: pr.number,
        verdict: verdict(pr, outcome.file),
        ...(pr.receipt ? { artifact: pr.receipt.artifact } : {}),
      }));
      const skippedBy = pullRequests.filter((pr) => pr.verdict === "missed" || pr.verdict === "selection-unrecorded");
      if (skippedBy.length > 0) {
        return {
          ...base,
          classification: "miss",
          pull_requests: pullRequests,
          detail: `${rerunNote}; not selected by ${skippedBy.map((pr) => `#${pr.number}`).join(", ")}`,
        };
      }
      if (pullRequests.every((pr) => pr.verdict === "no-receipt" || pr.verdict === "no-tests-run")) {
        return { ...base, classification: "unattributed", pull_requests: pullRequests, detail: `${rerunNote}; no merged pull request in the window ran or skipped it` };
      }
      return { ...base, classification: "covered", pull_requests: pullRequests, detail: `${rerunNote}; every pull request with a receipt ran it` };
    });
}

export function unsafeMissEntries(
  failures: readonly ClassifiedFailure[],
  context: { headSha: string; detectedAt: string; runUrl?: string },
): UnsafeMissEntry[] {
  return failures
    .filter((failure) => failure.classification === "miss")
    .flatMap((failure) => failure.pull_requests
      .filter((pr) => pr.verdict === "missed" || pr.verdict === "selection-unrecorded")
      .map((pr): UnsafeMissEntry => ({
        test: failure.id,
        pullRequest: pr.number,
        receipt: pr.artifact ?? null,
        mainSha: context.headSha,
        detectedAt: context.detectedAt,
        ...(context.runUrl ? { run: context.runUrl } : {}),
      })));
}

export interface BuildReportInput extends ClassifyInput {
  headSha: string;
  producedAt: string;
  runUrl?: string;
  window: MissReport["window"];
  notes?: string[];
}

export function buildMissReport(input: BuildReportInput): MissReport {
  const failures = classifyFailures(input);
  const open = unsafeMissEntries(failures, { headSha: input.headSha, detectedAt: input.producedAt, runUrl: input.runUrl });
  return {
    schema: MISS_REPORT_SCHEMA,
    produced_at: input.producedAt,
    head_sha: input.headSha,
    ...(input.runUrl ? { run_url: input.runUrl } : {}),
    full_suite: input.fullRun.some((outcome) => outcome.failed) ? "failed" : "passed",
    rerun: input.rerun ? "done" : "not-run",
    window: input.window,
    pull_requests: input.pullRequests.map((pr) => ({
      number: pr.number,
      merge_sha: pr.mergeSha,
      head_sha: pr.headSha,
      receipt: pr.receipt?.artifact ?? null,
      selection: pr.receipt?.report.selection ?? null,
    })),
    deterministic_failures: failures.filter((failure) => failure.classification !== "flaky").map((failure) => failure.id),
    failures,
    misses: failures.filter((failure) => failure.classification === "miss").length,
    open_unsafe_misses: open,
    notes: input.notes ?? [],
  };
}

const CLASS_ORDER: readonly FailureClass[] = ["miss", "unattributed", "pre-existing", "covered", "flaky"];

export function formatMissReportMarkdown(report: MissReport): string {
  const lines = [
    report.misses > 0 ? `# DiffCI enforce: ${report.misses} unsafe miss(es) on main` : "# DiffCI enforce: no misses on main",
    "",
    `- main: \`${report.head_sha}\`${report.run_url ? ` ([run](${report.run_url}))` : ""}`,
    `- full suite: ${report.full_suite}; re-run of failures: ${report.rerun}`,
    `- window: ${report.window.from_sha ? `\`${report.window.from_sha.slice(0, 12)}..${report.head_sha.slice(0, 12)}\`` : "none found"} (${report.window.source})`,
    `- merged pull requests: ${report.pull_requests.length === 0 ? "none" : report.pull_requests.map((pr) => `#${pr.number} (${pr.selection ?? "no receipt"})`).join(", ")}`,
  ];
  for (const note of report.notes) lines.push(`- note: ${note}`);
  for (const classification of CLASS_ORDER) {
    const group = report.failures.filter((failure) => failure.classification === classification);
    if (group.length === 0) continue;
    lines.push("", `## ${classification} (${group.length})`, "");
    for (const failure of group) {
      const prs = failure.pull_requests.map((pr) => `#${pr.number}: ${pr.verdict}`).join(", ");
      lines.push(`- \`${failure.id}\` - ${failure.detail}${prs ? ` [${prs}]` : ""}`);
    }
  }
  if (report.open_unsafe_misses.length > 0) {
    lines.push(
      "",
      "## What to do",
      "",
      "Enforce mode must stop skipping tests until a human has looked at this. Add these entries to",
      "`enforce.openUnsafeMisses` in `diffci.config.json` (fallback 4 then forces the full suite), and turn",
      "the `DIFFCI_ENFORCE` repository variable off if enforcement is live. Nothing was changed automatically;",
      "clearing the entries is the deliberate step that re-enables enforcement.",
      "",
      "```json",
      JSON.stringify(report.open_unsafe_misses, null, 2),
      "```",
    );
  }
  return `${lines.join("\n")}\n`;
}
