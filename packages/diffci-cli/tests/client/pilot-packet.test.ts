import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parse } from "yaml";

import { renderPilotPacket } from "../../src/client/pilot-packet.js";
import { buildPilotWorkflow } from "../../src/client/workflow-templates.js";
import { makeReport } from "../helpers/report-fixture.js";

describe("pilot packet", () => {
  it("generates a pinned, non-blocking, no-send observation workflow", () => {
    const source = buildPilotWorkflow("0.3.4");
    const workflow = parse(source) as Record<string, unknown>;

    assert.equal(typeof workflow, "object");
    assert.match(source, /runs-on: ubuntu-26\.04/);
    assert.match(source, /continue-on-error: true/);
    assert.match(source, /actions\/checkout@[0-9a-f]{40}/);
    assert.match(source, /actions\/setup-node@[0-9a-f]{40}/);
    assert.match(source, /actions\/upload-artifact@[0-9a-f]{40}/);
    assert.match(source, /@diffci\.com\/diffci@0\.3\.4/);
    assert.match(source, /observe --no-send/);
    assert.doesNotMatch(source, /api-token|DIFFCI_TOKEN/);
  });

  it("renders a truthful compatibility summary without claiming measured savings", () => {
    const packet = renderPilotPacket(makeReport(), {
      label: "Example library",
      repositoryUrl: "https://github.com/example/library",
    });

    assert.match(packet, /read-only compatibility assessment, not a measured savings claim/);
    assert.match(packet, /Selection: 1 of 12 discovered test files/);
    assert.match(packet, /91\.7% planned test-file reduction/);
    assert.match(packet, /Working tree unchanged: yes/);
    assert.match(packet, /diffci pilot --full <command>/);
    assert.match(packet, /\[Example library\]\(https:\/\/github\.com\/example\/library\)/);
  });

  it("reports refusals without presenting a selection", () => {
    const packet = renderPilotPacket(makeReport({
      status: "REFUSED",
      stage: "eligibility",
      reason: "unsupported repository",
      result: undefined,
    }), { label: "Unsupported library" });

    assert.match(packet, /Observation status: \*\*REFUSED\*\*/);
    assert.match(packet, /Selection: not available/);
    assert.match(packet, /Resolve the reported observation limit/);
    assert.doesNotMatch(packet, /undefined/);
  });

  it("never presents a partial internal selection as savings when the decision is FULL", () => {
    const report = makeReport();
    const packet = renderPilotPacket(makeReport({
      result: { ...report.result!, mode: "FULL", selectedTests: ["test/alpha.test.ts"] },
    }), { label: "Full validation library" });

    assert.match(packet, /Selection: full validation required across 12 discovered test files/);
    assert.match(packet, /0\.0% planned test-file reduction \(full validation required\)/);
    assert.doesNotMatch(packet, /91\.7%/);
  });
});
