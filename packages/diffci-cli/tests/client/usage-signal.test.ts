import assert from "node:assert/strict";
import { test } from "node:test";
import { mcpClientName, observationSelection, planSelection, sendUsageSignal, verificationSelection } from "../../src/client/usage-signal.js";

test("opt-in usage sends only the documented aggregate fields", async () => {
  let body = "";
  const ok = await sendUsageSignal({
    command: "check", outcome: "observed", version: "0.2.4",
    fetchImpl: async (_url, init) => {
      body = String(init?.body);
      return new Response(null, { status: 202 });
    },
  });
  assert.equal(ok, true);
  assert.deepEqual(JSON.parse(body), { schema: "diffci.usage.v1", command: "check", outcome: "observed", version: "0.2.4" });
});

test("usage delivery failure cannot fail validation", async () => {
  assert.equal(await sendUsageSignal({ command: "observe", outcome: "error", version: "0.2.4", fetchImpl: async () => { throw new Error("offline"); } }), false);
  assert.equal(await sendUsageSignal({ command: "observe", outcome: "error", version: "0.2.4", endpoint: "http://example.com" }), false);
});

test("selection counts are sent as numbers only, and dropped when inconsistent", async () => {
  const bodies: any[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return new Response(null, { status: 202 }); };
  await sendUsageSignal({ command: "observe", outcome: "observed", version: "0.3.61", fetchImpl,
    selection: { mode: "selective", testsSelected: 3, testsTotal: 40, baselineTestsSelected: 12 } });
  assert.deepEqual(bodies[0], { schema: "diffci.usage.v1", command: "observe", outcome: "observed", version: "0.3.61",
    mode: "selective", tests_selected: 3, tests_total: 40, baseline_tests_selected: 12 });
  await sendUsageSignal({ command: "verify", outcome: "passed", version: "0.3.61", fetchImpl,
    selection: { mode: "selective", testsSelected: 41, testsTotal: 40 } });
  await sendUsageSignal({ command: "verify", outcome: "passed", version: "0.3.61", fetchImpl,
    selection: { mode: "full", testsSelected: 1.5, testsTotal: 40 } });
  assert.equal(bodies[1].tests_selected, undefined);
  assert.equal(bodies[1].mode, undefined);
  assert.equal(bodies[2].tests_total, undefined);
});

test("selection is derived from observation, verification and plan reports", () => {
  assert.deepEqual(observationSelection({ mode: "SELECTIVE", selectedTests: ["a", "b"], totalTestCount: 10, pathBaseline: { selectedTestCount: 10 } }),
    { mode: "selective", testsSelected: 2, testsTotal: 10, baselineTestsSelected: 10 });
  assert.deepEqual(observationSelection({ mode: "FULL", selectedTests: [], totalTestCount: 10 }), { mode: "full", testsSelected: 10, testsTotal: 10 });
  assert.equal(observationSelection({ mode: "SELECTIVE", selectedTests: [], totalTestCount: 0 }), undefined);
  assert.equal(observationSelection(undefined), undefined);
  assert.deepEqual(verificationSelection({ selection: "none", tests_selected: 0, tests_available: 8 }), { mode: "selective", testsSelected: 0, testsTotal: 8 });
  assert.deepEqual(verificationSelection({ selection: "full", tests_selected: 0, tests_available: 8 }), { mode: "full", testsSelected: 8, testsTotal: 8 });
  assert.deepEqual(verificationSelection({ selection: "selected", tests_selected: 3, tests_available: 8 }), { mode: "selective", testsSelected: 3, testsTotal: 8 });
  assert.equal(verificationSelection({ selection: "none", tests_selected: 0, tests_available: 0 }), undefined);
  assert.deepEqual(planSelection({ mode: "SELECTIVE", selectedTests: ["a"], skippedTests: ["b", "c"] }), { mode: "selective", testsSelected: 1, testsTotal: 3 });
  assert.equal(planSelection({ mode: "FULL", selectedTests: [], skippedTests: [] }), undefined);
});

test("verify streaks send counts only, and only where they mean something", async () => {
  const bodies: any[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return new Response(null, { status: 202 }); };
  const send = (outcome: "passed" | "failed" | "blocked", streak: { failedBefore: number; fixSeconds?: number }, command: "verify" | "check" = "verify") =>
    sendUsageSignal({ command, outcome: command === "check" ? "observed" : outcome, version: "0.3.62", fetchImpl, streak });
  await send("failed", { failedBefore: 0 });
  await send("failed", { failedBefore: 2, fixSeconds: 60 });
  await send("passed", { failedBefore: 3, fixSeconds: 420 });
  await send("passed", { failedBefore: 0, fixSeconds: 5 });
  await send("blocked", { failedBefore: 1 });
  await send("passed", { failedBefore: 1 }, "check");
  await send("passed", { failedBefore: 1, fixSeconds: 90_000 });
  await send("passed", { failedBefore: 1.5 });
  const streaks = bodies.map(({ failed_before, fix_seconds }) => ({ failed_before, fix_seconds }));
  assert.deepEqual(streaks, [
    { failed_before: 0, fix_seconds: undefined },
    { failed_before: 2, fix_seconds: undefined },
    { failed_before: 3, fix_seconds: 420 },
    { failed_before: undefined, fix_seconds: undefined },
    { failed_before: undefined, fix_seconds: undefined },
    { failed_before: undefined, fix_seconds: undefined },
    { failed_before: 1, fix_seconds: undefined },
    { failed_before: undefined, fix_seconds: undefined },
  ]);
});

test("MCP starts send the agent client's normalised name, and only on mcp", async () => {
  assert.equal(mcpClientName("claude-code"), "claude-code");
  assert.equal(mcpClientName("Claude Code"), "claude code");
  assert.equal(mcpClientName("Visual Studio Code / Copilot"), "visual studio code - copilot");
  assert.equal(mcpClientName("  "), undefined);
  assert.equal(mcpClientName(42), undefined);
  assert.equal(mcpClientName("x".repeat(80))?.length, 48);
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  await sendUsageSignal({ command: "mcp", outcome: "started", version: "0.3.65", surface: "local-mcp", client: "cursor", fetchImpl });
  await sendUsageSignal({ command: "plan", outcome: "full", version: "0.3.65", client: "cursor", fetchImpl });
  assert.deepEqual(bodies[0], { schema: "diffci.usage.v1", command: "mcp", outcome: "started", version: "0.3.65", surface: "local-mcp", client: "cursor" });
  assert.equal(bodies[1]?.client, undefined);
});
