export { economicsContext } from "@diffci.com/core/cache/economics-context";

export interface EconomicsDecision {
  decision: "ANALYZE" | "BYPASS_FULL";
  reason: string;
  contextKey: string;
  sampleCount?: number;
  maximumGrossSavedMs?: number;
  minimumObserverMs?: number;
}

/** Economics may decline analysis; it never approves a selection or removes tests. */
export function evaluateEconomics(raw: unknown, context: { repository?: string; jobKey?: string; contextKey: string; observerVersion: string; now?: number }): EconomicsDecision {
  const analyze = (reason: string): EconomicsDecision => ({ decision: "ANALYZE", reason, contextKey: context.contextKey });
  if (!raw || typeof raw !== "object") return analyze("No valid timing history");
  const history = raw as Record<string, unknown>;
  if (history.schema !== "diffci.economics.v1" || !context.repository || !context.jobKey || history.repository !== context.repository || history.jobKey !== context.jobKey || history.contextKey !== context.contextKey || history.observerVersion !== context.observerVersion) return analyze("Timing history does not match this repository, job, configuration or observer");
  const age = (context.now ?? Date.now()) - Date.parse(String(history.recordedAt));
  if (!Number.isFinite(age) || age < 0 || age > 48 * 60 * 60 * 1000) return analyze("Timing history is stale or future-dated; resample analysis");
  if (!Array.isArray(history.samples) || history.samples.length < 5 || history.samples.length > 100) return analyze("Five to one hundred historical samples are required");
  const heads = new Set<string>();
  let maximumGrossSavedMs = 0;
  let minimumObserverMs = Infinity;
  for (const sample of history.samples) {
    if (!sample || typeof sample !== "object" || sample.stable !== true || typeof sample.headSha !== "string" || !/^[a-f0-9]{40}$/.test(sample.headSha) || ![sample.fullMs, sample.policyMs, sample.observerMs].every(value => typeof value === "number" && Number.isFinite(value) && value > 0)) return analyze("History contains an invalid or unstable sample");
    heads.add(sample.headSha);
    maximumGrossSavedMs = Math.max(maximumGrossSavedMs, sample.fullMs - sample.policyMs);
    minimumObserverMs = Math.min(minimumObserverMs, sample.observerMs);
  }
  if (heads.size < 5) return analyze("History needs five distinct commits");
  // Use the best historical gross saving and cheapest observer, with headroom.
  // This is a cost heuristic, never a correctness claim about the next change.
  const bypass = maximumGrossSavedMs * 1.25 + 250 < minimumObserverMs;
  return { decision: bypass ? "BYPASS_FULL" : "ANALYZE", reason: bypass ? "Historical avoided test work does not cover observer cost; retain the full CI job" : "Historical savings may cover analysis; measure this change", contextKey: context.contextKey, sampleCount: history.samples.length, maximumGrossSavedMs, minimumObserverMs };
}
