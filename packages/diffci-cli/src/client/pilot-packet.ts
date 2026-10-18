import type { ObservationReport } from "./report.js";

const CHECKOUT_SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const SETUP_NODE_SHA = "820762786026740c76f36085b0efc47a31fe5020";
const UPLOAD_ARTIFACT_SHA = "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";

export interface PilotPacketOptions {
  label: string;
  repositoryUrl?: string;
}

function text(value: string | undefined): string {
  return value?.trim() || "not reported";
}

function bullets(values: readonly string[], empty: string): string {
  return values.length > 0 ? values.map((value) => `- ${value}`).join("\n") : `- ${empty}`;
}

export function buildPilotWorkflow(version: string): string {
  return `name: DiffCI pilot observation
on: [pull_request]
permissions:
  contents: read
jobs:
  diffci-pilot:
    name: DiffCI pilot (non-blocking)
    runs-on: ubuntu-24.04
    continue-on-error: true
    steps:
      - uses: actions/checkout@${CHECKOUT_SHA} # immutable checkout pin
        with:
          fetch-depth: 0
      - uses: actions/setup-node@${SETUP_NODE_SHA} # immutable setup-node pin
        with:
          node-version: 22
      - name: Observe only
        run: npx "@diffci.com/diffci@${version}" observe --no-send --out "$RUNNER_TEMP/diffci-observe.json"
      - name: Upload local observation
        if: always()
        uses: actions/upload-artifact@${UPLOAD_ARTIFACT_SHA} # immutable upload-artifact v7 pin
        with:
          name: diffci-observation-\${{ github.run_id }}-\${{ github.run_attempt }}
          path: \${{ runner.temp }}/diffci-observe.json
          if-no-files-found: warn
`;
}

export function renderPilotPacket(report: ObservationReport, options: PilotPacketOptions): string {
  const result = report.result;
  const range = report.commitRange;
  const repository = options.repositoryUrl
    ? `[${options.label}](${options.repositoryUrl})`
    : options.label;
  const selection = result?.mode === "FULL"
    ? `full validation required across ${result.totalTestCount} discovered test files`
    : result
      ? `${result.selectedTests.length} of ${result.totalTestCount} discovered test files`
    : "not available";
  const reduction = result?.mode === "FULL"
    ? "0.0% planned test-file reduction (full validation required)"
    : result && result.totalTestCount > 0
    ? `${Math.max(0, (1 - result.selectedTests.length / result.totalTestCount) * 100).toFixed(1)}% planned test-file reduction`
    : "not available";
  const nextStep = report.status !== "OBSERVED"
    ? "Resolve the reported observation limit before evaluating a pilot."
    : result?.mode === "FULL"
      ? "This change requires full validation; observe more representative changes before judging fit."
      : "Review the proposed command, then use `diffci pilot --full <command>` to measure paired runtime."

  return `# DiffCI compatibility packet: ${options.label}

Generated ${report.producedAt} by DiffCI ${report.observer.version}. This is a read-only compatibility assessment, not a measured savings claim.

## Repository and revision

- Repository: ${repository}
- Base: ${text(range?.baseSha)}
- Head: ${text(range?.headSha)}
- Range source: ${text(range?.source)}

## Result

- Observation status: **${report.status}**
- Stage: ${report.stage}
- Decision: ${result?.mode ?? "not available"}
- Selection: ${selection}
- Planning result: ${reduction}
- Analysis status: ${result?.analysisStatus ?? "not available"}
- Reason: ${report.reason ?? result?.commandRefusalReason ?? "none"}

### Proposed commands

${bullets(result?.proposedCommands ?? [], "none")}

### Conservative fallbacks and risk signals

${bullets([
    ...(result?.fallbackReasons ?? []),
    ...(result?.riskSignals ?? []).map((signal) => `${signal.level}: ${signal.reason}`),
  ], "none")}

## Safety evidence

- Working tree unchanged: ${report.nonInterference.worktreeUnchanged ? "yes" : "no"}
- Report written outside the repository: ${report.nonInterference.reportWrittenOutsideRepository ? "yes" : "no"}
- File contents included: ${report.payload.includesFileContents ? "yes" : "no"}
- Environment included: ${report.payload.includesEnvironment ? "yes" : "no"}
- Credentials included: ${report.payload.includesCredentials ? "yes" : "no"}
- Workflow findings: ${report.nonInterference.workflowFindings.length}

### Workflow findings

${bullets(report.nonInterference.workflowFindings.map((finding) => `${finding.severity} ${finding.code}: ${finding.message}`), "none")}

## Recommended next step

${nextStep}

The accompanying \`diffci-observe.yml\` is a reviewable, non-blocking GitHub Actions workflow. It has read-only permissions, sends nothing, and uploads the observation only to the repository's own workflow run.
`;
}
