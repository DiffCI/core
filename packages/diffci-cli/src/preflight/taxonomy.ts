/**
 * Preflight failure taxonomy (Part 1). Deliberately independent of GitHub-specific job names - a job
 * called "check" must not automatically imply a class (Stage 2C's own measurement-pipeline fix ran into
 * exactly this trap for a different purpose: job names/categories are a weak, sometimes-wrong signal).
 * Classification here is driven by STEP-LEVEL evidence (error text, failing command, exit semantics),
 * never the job's display name alone - see classifyFailureFromEvidence() in fingerprint.ts.
 */
export type FailureClass =
  | "TYPECHECK"
  | "LINT"
  | "BUILD"
  | "UNIT_TEST"
  | "INTEGRATION_TEST"
  | "DEPENDENCY"
  | "CONFIGURATION"
  | "GENERATED_ARTIFACT"
  | "SECURITY_SCAN"
  | "DEPLOYMENT"
  | "RUNNER_INFRASTRUCTURE"
  | "TIMEOUT"
  | "FLAKY"
  | "UNKNOWN";

export const FAILURE_CLASSES: readonly FailureClass[] = [
  "TYPECHECK", "LINT", "BUILD", "UNIT_TEST", "INTEGRATION_TEST", "DEPENDENCY", "CONFIGURATION",
  "GENERATED_ARTIFACT", "SECURITY_SCAN", "DEPLOYMENT", "RUNNER_INFRASTRUCTURE", "TIMEOUT", "FLAKY", "UNKNOWN",
];

export function isFailureClass(value: string): value is FailureClass {
  return (FAILURE_CLASSES as readonly string[]).includes(value);
}
