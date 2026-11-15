/** Best-effort usage signal. Carries a repository name only when given one; never content, paths or machine details. */
export type UsageCommand = "check" | "observe" | "verify" | "plan";
export type UsageOutcome = "observed" | "refused" | "error" | "passed" | "failed" | "blocked" | "selective" | "full";
export type UsageSurface = "cli" | "local-mcp" | "github-action" | "gitlab-component";
export interface UsageSignal {
  command: UsageCommand;
  outcome: UsageOutcome;
  version: string;
  surface?: UsageSurface;
  activity?: "internal" | "external";
  ci?: boolean;
  installationId?: string;
  repository?: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
}
export interface DeliveryResult { status: "delivered" | "accepted" | "failed" | "timed-out"; httpStatus?: number }
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
