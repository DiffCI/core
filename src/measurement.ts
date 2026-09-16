// SPDX-License-Identifier: AGPL-3.0-only
import { performance } from "node:perf_hooks";

/** Local process measurements, not host/container billing or hardware energy measurements. */
export async function measure<T>(operation: () => T | Promise<T>) {
  const cpu = process.cpuUsage();
  const started = performance.now();
  const value = await operation();
  const wallSeconds = (performance.now() - started) / 1000;
  const used = process.cpuUsage(cpu);
  return { value, measurement: { basis: "measured" as const, scope: "current-process" as const,
    wallSeconds, cpuSeconds: (used.user + used.system) / 1e6, rssBytesAtEnd: process.memoryUsage().rss } };
}

/** Model from explicit caller inputs; no default provider prices or implied measured savings. */
export function estimateImpact(input: { computeSeconds: number; usdPerComputeSecond: number; watts: number; gridGramsCo2ePerKwh: number }) {
  for (const [name, value] of Object.entries(input)) if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and nonnegative`);
  const estimatedKwh = input.computeSeconds * input.watts / 3_600_000;
  return { basis: "estimated" as const, assumptions: { ...input }, estimatedUsd: input.computeSeconds * input.usdPerComputeSecond,
    estimatedKwh, estimatedKgCo2e: estimatedKwh * input.gridGramsCo2ePerKwh / 1000 };
}
