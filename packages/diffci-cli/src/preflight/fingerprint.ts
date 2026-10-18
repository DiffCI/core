/**
 * Failure classification (from raw evidence) and normalized fingerprinting (Part 1/3). Deliberately does
 * NOT hash raw log text - timestamps, absolute paths, container ids, and incidental byte offsets would
 * make two occurrences of the exact same underlying failure look different. Every normalization step
 * below strips or generalizes exactly one such source of incidental variance; the corpus of patterns is
 * intentionally small and explicit rather than a black-box regex pile, so a wrong classification is easy
 * to find and fix by reading this file.
 */
import type { FailureClass } from "./taxonomy.js";

export interface FailureEvidence {
  jobName: string;
  stepName?: string;
  command?: string;
  errorText: string; // the relevant tail of stdout/stderr around the failure, not the whole log
}

interface ClassificationRule {
  failureClass: FailureClass;
  /** Matched against errorText OR command - first match wins, rules are checked in array order (most
   * specific/unambiguous first, matching src/shadow/failure-classification.ts's own "ordered, first
   * match wins" precedent). */
  patterns: RegExp[];
}

// Ordered most-specific-first. A pattern here is real error-message vocabulary observed in this
// project's own actual CI failures (see docs/research/2026-08-22-preflight-p0-historical-failure-study.md
// case studies) or well-known tool output, not invented from memory.
const CLASSIFICATION_RULES: ClassificationRule[] = [
  { failureClass: "TIMEOUT", patterns: [/timed? ?out/i, /exceeded the timeout/i, /context deadline exceeded/i] },
  { failureClass: "RUNNER_INFRASTRUCTURE", patterns: [/runner has received a shutdown signal/i, /lost communication with the server/i, /econnreset/i, /the job was canceled because/i, /no space left on device/i, /1101\b/i, /container (start|start collision)/i] },
  { failureClass: "CONFIGURATION", patterns: [/ERR_UNKNOWN_BUILTIN_MODULE/i, /environment variable .* is not set/i, /missing required secret/i, /invalid configuration/i, /engines\.node/i, /unsupported engine/i] },
  { failureClass: "DEPENDENCY", patterns: [/npm error (?:code )?(?:E404|ERESOLVE|EAI_AGAIN)/i, /could not resolve host/i, /module not found/i, /cannot find module/i, /peer dep(?:endency)? (?:conflict|missing)/i] },
  { failureClass: "TYPECHECK", patterns: [/error TS\d{4}/i, /tsc --noEmit/i] },
  { failureClass: "LINT", patterns: [/eslint/i, /\d+ problems? \(\d+ errors?/i] },
  { failureClass: "BUILD", patterns: [/build failed/i, /compilation failed/i, /webpack (?:compiled with|failed)/i] },
  { failureClass: "GENERATED_ARTIFACT", patterns: [/generated file(?:s)? (?:is|are) out of date/i, /diff detected in generated/i, /snapshot mismatch/i] },
  { failureClass: "SECURITY_SCAN", patterns: [/codeql/i, /security alert/i, /vulnerability found/i] },
  { failureClass: "DEPLOYMENT", patterns: [/deploy(?:ment)? failed/i, /wrangler deploy.*error/i, /rollout failed/i] },
  { failureClass: "INTEGRATION_TEST", patterns: [/integration test/i] },
  { failureClass: "UNIT_TEST", patterns: [/ERR_TEST_FAILURE/i, /not ok \d+/i, /AssertionError/i, /expected .* to (?:equal|be)/i] },
];

export function classifyFailureFromEvidence(evidence: FailureEvidence): FailureClass {
  const haystack = `${evidence.command ?? ""} ${evidence.errorText}`;
  for (const rule of CLASSIFICATION_RULES) {
    if (rule.patterns.some((p) => p.test(haystack))) return rule.failureClass;
  }
  return "UNKNOWN";
}

/**
 * Normalizes volatile, incidental details out of an error message before fingerprinting (Part 3):
 * - absolute filesystem paths -> a repo-relative-shaped placeholder
 * - line:column numbers -> stripped (the same logical error at a slightly different line is still the
 *   same failure family)
 * - hex hashes/ids (commit SHAs, container ids, uuids) -> stripped
 * - ISO timestamps and other digit runs that look like durations/ids -> stripped
 */
function normalizeErrorText(text: string): string {
  return text
    .replace(/\/[\w./-]+(?:\.tsx?|\.jsx?|\.mjs|\.cjs)/g, "<path>")
    .replace(/:\d+:\d+/g, "") // line:column
    .replace(/\b[0-9a-f]{7,40}\b/gi, "<hash>")
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/g, "<timestamp>")
    .replace(/\b\d+ms\b|\b\d+(?:\.\d+)?s\b/g, "<duration>")
    .replace(/\b\d+\.\d+\b/g, "<duration>") // bare decimals (e.g. "duration_ms: 301.23") - almost always an incidental measurement, not part of the error's identity
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * failure_fingerprint (Part 3): failureClass + job/step class + a normalized error signature + (when
 * known) the specific failing test/module identifier - deliberately NOT the raw log. Two occurrences of
 * "the same" failure (identical error class, same test, same normalized message) produce the identical
 * fingerprint even if timestamps/paths/durations differ between the two CI runs.
 */
export function computeFailureFingerprint(input: { failureClass: FailureClass; jobName: string; stepName?: string; failingTest?: string; errorText: string }): string {
  const parts = [
    input.failureClass,
    input.jobName.toLowerCase().trim(),
    input.stepName?.toLowerCase().trim() ?? "",
    input.failingTest?.toLowerCase().trim() ?? "",
    normalizeErrorText(input.errorText).slice(0, 200), // bounded - a fingerprint is an identity key, not a log excerpt
  ];
  return parts.join("|");
}
