/** Best-effort usage signal. Carries a repository name only when given one; never content, paths or machine details. */
/** "mcp": the local MCP server was initialized by an agent client (outcome "started"). */
export type UsageCommand = "check" | "observe" | "verify" | "plan" | "mcp";
export type UsageOutcome = "observed" | "refused" | "error" | "passed" | "failed" | "blocked" | "selective" | "full" | "started";
export type UsageSurface = "cli" | "local-mcp" | "github-action" | "gitlab-component" | "azure-devops-task";
/**
 * How much of the suite a run chose: counts only, never test names. `baselineTestsSelected` is what a simple
 * path-rule CI would have run (the comparator savings are measured against), when the report carries it.
 */
export interface UsageSelection {
  mode: "selective" | "full";
  testsSelected: number;
  testsTotal: number;
  baselineTestsSelected?: number;
}
/**
 * Local verify only (outcome-log.ts verifyStreak): failed runs on the same base since its last pass, and on a
 * pass after failures, the seconds since the first of them. Counts only, never the base or the change.
 */
export interface UsageStreak {
  failedBefore: number;
  fixSeconds?: number;
}
export const MAX_FIX_SECONDS = 24 * 60 * 60;
export interface UsageSignal {
  command: UsageCommand;
  outcome: UsageOutcome;
  version: string;
  surface?: UsageSurface;
  activity?: "internal" | "external";
  ci?: boolean;
  installationId?: string;
  repository?: string;
  selection?: UsageSelection;
  streak?: UsageStreak;
  /** "mcp" only: the agent client's name from MCP initialize, normalised by mcpClientName. */
  client?: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
}
export interface DeliveryResult { status: "delivered" | "accepted" | "failed" | "timed-out"; httpStatus?: number }
const count = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1_000_000;

function selectionFields(selection: UsageSelection | undefined): Record<string, unknown> {
  if (!selection || !count(selection.testsSelected) || !count(selection.testsTotal) || selection.testsSelected > selection.testsTotal) return {};
  return { mode: selection.mode, tests_selected: selection.testsSelected, tests_total: selection.testsTotal,
    ...(count(selection.baselineTestsSelected) && selection.baselineTestsSelected <= selection.testsTotal ? { baseline_tests_selected: selection.baselineTestsSelected } : {}) };
}

/**
 * A failed verify says whether it starts a streak (failed_before 0) or repeats one; a pass after failures
 * says how many and how long the fix took. Anything else, or inconsistent counts: nothing.
 */
function streakFields(command: UsageCommand, outcome: UsageOutcome, streak: UsageStreak | undefined): Record<string, unknown> {
  if (!streak || command !== "verify" || !count(streak.failedBefore) || streak.failedBefore > 1000) return {};
  if (outcome === "failed") return { failed_before: streak.failedBefore };
  if (outcome !== "passed" || streak.failedBefore === 0) return {};
  return { failed_before: streak.failedBefore,
    ...(count(streak.fixSeconds) && streak.fixSeconds <= MAX_FIX_SECONDS ? { fix_seconds: streak.fixSeconds } : {}) };
}

/**
 * An MCP client's self-reported clientInfo.name as a short lower-case product name ("Claude Code" -> "claude code"),
 * or undefined. It names the agent application, never the person or machine.
 */
export function mcpClientName(name: unknown): string | undefined {
  if (typeof name !== "string") return undefined;
  const value = name.trim().toLowerCase().replace(/[^a-z0-9 ._-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 48).trim();
  return /^[a-z0-9][a-z0-9 ._-]{0,47}$/.test(value) ? value : undefined;
}

/** From an observation result (observe, check). No result, or no tests found: nothing to count. */
export function observationSelection(result: { mode: "SELECTIVE" | "FULL"; selectedTests: readonly string[]; totalTestCount: number; pathBaseline?: { selectedTestCount: number } } | undefined): UsageSelection | undefined {
  if (!result || !(result.totalTestCount > 0)) return undefined;
  return { mode: result.mode === "SELECTIVE" ? "selective" : "full",
    testsSelected: result.mode === "SELECTIVE" ? result.selectedTests.length : result.totalTestCount,
    testsTotal: result.totalTestCount,
    ...(result.pathBaseline ? { baselineTestsSelected: result.pathBaseline.selectedTestCount } : {}) };
}

/** From a verification receipt. "none" with tests available means the change needed none of them. */
export function verificationSelection(report: { selection: "none" | "selected" | "full"; tests_selected: number; tests_available: number }): UsageSelection | undefined {
  if (!(report.tests_available > 0)) return undefined;
  return { mode: report.selection === "full" ? "full" : "selective",
    testsSelected: report.selection === "none" ? 0 : report.selection === "full" ? report.tests_available : report.tests_selected,
    testsTotal: report.tests_available };
}

/** From an advisory plan (diffci plan). */
export function planSelection(plan: { mode: string; selectedTests: readonly string[]; skippedTests: readonly string[] }): UsageSelection | undefined {
  const total = plan.selectedTests.length + plan.skippedTests.length;
  if (total === 0) return undefined;
  return { mode: plan.mode === "SELECTIVE" ? "selective" : "full", testsSelected: plan.selectedTests.length, testsTotal: total };
}

export async function deliverUsageSignal(input: UsageSignal): Promise<DeliveryResult> {
  try {
    const url = new URL(input.endpoint ?? "https://app.diffci.com/v1/usage-events");
    if (url.protocol !== "https:") return { status: "failed" };
    const response = await (input.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schema: "diffci.usage.v1", command: input.command, outcome: input.outcome, version: input.version,
        ...(input.surface ? { surface: input.surface } : {}),
        ...(input.activity ? { activity: input.activity } : {}),
        ...(input.ci !== undefined ? { ci: input.ci } : {}),
        ...(input.installationId ? { installation_id: input.installationId } : {}),
        ...(input.repository ? { repository: input.repository } : {}),
        ...selectionFields(input.selection),
        ...streakFields(input.command, input.outcome, input.streak),
        ...(input.command === "mcp" && input.client ? { client: input.client } : {}),
      }),
      signal: AbortSignal.timeout(3000),
    });
    return { status: !response.ok ? "failed" : response.status === 202 ? "accepted" : "delivered", httpStatus: response.status };
  } catch (error) {
    return { status: error instanceof Error && error.name === "TimeoutError" ? "timed-out" : "failed" };
  }
}

export async function sendUsageSignal(input: UsageSignal): Promise<boolean> {
  const result = await deliverUsageSignal(input);
  return result.status === "delivered" || result.status === "accepted";
}
