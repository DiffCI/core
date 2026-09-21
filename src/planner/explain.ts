import type { ImpactEvidence, ImpactResult } from "../repo/impact-types.js";
import type { ExecutionPlan } from "./types.js";

export type ExplainVerdict = "SELECTED" | "ALWAYS_RUN" | "SKIP_CANDIDATE" | "NOT_IN_PLAN";

export interface ExplainResult {
  target: string;
  verdict: ExplainVerdict;
  reason: string;
  changed: string[];
  evidence: ImpactEvidence[];
  safety: {
    graphConfidence: string;
    fallbackRequired: boolean;
  };
}

export function explain(
  target: string,
  plan: ExecutionPlan,
  impact: ImpactResult,
): ExplainResult {
  const normalized = target.replace(/\\/g, "/");
  const changed = impact.changedFiles.map((c) => c.file.path);

  const isSelected = plan.selectedTests.includes(normalized);
  const isAlwaysRun = plan.alwaysRunTasks.includes(normalized);
  const isTask = plan.tasks.some((t) => t.id === normalized || t.command.includes(normalized));

  let verdict: ExplainVerdict = "NOT_IN_PLAN";
  let reason = "Target is not part of this plan.";

  if (isAlwaysRun) {
    verdict = "ALWAYS_RUN";
    reason = "Covered by always-run safety policy.";
  } else if (isSelected) {
    verdict = "SELECTED";
    reason = "Selected by dependency graph impact analysis.";
  } else if (isTask) {
    const task = plan.tasks.find((t) => t.id === normalized);
    if (task) {
      verdict = task.status === "SKIP_CANDIDATE" ? "SKIP_CANDIDATE" : "SELECTED";
      reason = task.reason;
    }
  } else if (impact.affectedTests.some((t) => t.path === normalized)) {
    verdict = "SELECTED";
    reason = "Impact analyzer selected this test.";
  } else {
    verdict = "SKIP_CANDIDATE";
    reason = "No dependency path from any changed file.";
  }

  const evidence = impact.evidence.filter(
    (e) =>
      e.affectedFile === normalized ||
      (e.path && e.path.path.includes(normalized)) ||
      e.message.includes(normalized),
  );

  return {
    target: normalized,
    verdict,
    reason,
    changed,
    evidence,
    safety: {
      graphConfidence: plan.safety.graphConfidence,
      fallbackRequired: plan.safety.fallbackRequired,
    },
  };
}
