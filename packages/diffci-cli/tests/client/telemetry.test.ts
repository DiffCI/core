import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configureTelemetry, preferencePath, readTelemetryPreference, recordUsage } from "../../src/client/telemetry.js";
import { deliverUsageSignal } from "../../src/client/usage-signal.js";

test("consent is explicit, denial wins, and installation identity exists only in installation mode", async () => {
  const home = mkdtempSync(join(tmpdir(), "diffci-telemetry-"));
  const env = { DIFFCI_TELEMETRY_HOME: home };
  const originalFetch = globalThis.fetch;
  const bodies: any[] = [];
  globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return new Response(null, { status: 200 }); };
  try {
    await recordUsage("verify", "passed", "0.3.9", {}, env);
    assert.equal(bodies.length, 0);
    const first = configureTelemetry("installations", true, env);
    assert.equal(configureTelemetry("installations", true, env).installationId, first.installationId);
    await recordUsage("verify", "passed", "0.3.9", { "share-usage": true, "no-send": true }, env);
    await recordUsage("verify", "passed", "0.3.9", { "share-usage": true }, { ...env, DIFFCI_NO_SEND: "1" });
    assert.equal(bodies.length, 0);
    await recordUsage("verify", "passed", "0.3.9", {}, { ...env, DIFFCI_MCP: "1" });
    assert.equal(bodies[0].installation_id, first.installationId);
    assert.equal(bodies[0].activity, "internal");
    assert.equal(bodies[0].surface, "local-mcp");
    configureTelemetry("anonymous", false, env);
    await recordUsage("observe", "observed", "0.3.9", {}, env);
    assert.equal(bodies[1].installation_id, undefined);
    assert.equal(readTelemetryPreference(env).installationId, undefined);
    configureTelemetry("off", false, env);
    await recordUsage("verify", "passed", "0.3.9", {}, env);
    assert.equal(bodies.length, 2);
    const second = configureTelemetry("installations", false, env);
    assert.notEqual(second.installationId, first.installationId);
    writeFileSync(preferencePath(env), '{"mode":"installations","installationId":"email@example.com"}');
    assert.equal(readTelemetryPreference(env).mode, "off");
  } finally { globalThis.fetch = originalFetch; rmSync(home, { recursive: true, force: true }); }
});

test("delivery distinguishes receipt acceptance, forwarding success, rejection and timeout", async () => {
  const signal = { command: "verify" as const, outcome: "passed" as const, version: "0.3.9" };
  for (const [status, expected] of [[200, "delivered"], [202, "accepted"], [502, "failed"]] as const) {
    assert.equal((await deliverUsageSignal({ ...signal, fetchImpl: async () => new Response(null, { status }) })).status, expected);
  }
  assert.equal((await deliverUsageSignal({ ...signal, fetchImpl: async () => { throw new DOMException("timeout", "TimeoutError"); } })).status, "timed-out");
});
