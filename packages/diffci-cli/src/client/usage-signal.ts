/** Explicit, best-effort aggregate usage signal. No repository or machine identifier is sent. */
export async function sendUsageSignal(input: {
  command: "check" | "observe";
  outcome: "observed" | "refused" | "error";
  version: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const url = new URL(input.endpoint ?? "https://app.diffci.com/v1/usage-events");
  if (url.protocol !== "https:") return false;
  try {
    const response = await (input.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schema: "diffci.usage.v1", command: input.command, outcome: input.outcome, version: input.version }),
      signal: AbortSignal.timeout(2500),
    });
    return response.ok;
  } catch {
    return false;
  }
}
