import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configureTelemetry, normaliseRemote, preferencePath, readTelemetryPreference, recordUsage, repositoryName } from "../../src/client/telemetry.js";
import { deliverUsageSignal } from "../../src/client/usage-signal.js";

test("counting is on by default with the repository name; only the environment stops it", async () => {
  const home = mkdtempSync(join(tmpdir(), "diffci-telemetry-"));
  const env = { DIFFCI_TELEMETRY_HOME: home, GITHUB_REPOSITORY: "Acme/Widgets", GITHUB_ACTIONS: "true" };
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const bodies: any[] = [];
  const notices: string[] = [];
  globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return new Response(null, { status: 200 }); };
  console.error = (message: string) => { notices.push(message); };
  try {
    await recordUsage("plan", "selective", "0.3.9", {}, env);
    await recordUsage("verify", "passed", "0.3.9", { "no-send": true }, env);
    assert.equal(bodies.length, 2, "--no-send stops report uploads, not the count");
    assert.equal(bodies[0].repository, "github.com/acme/widgets");
    assert.equal(bodies[0].command, "plan");
    assert.equal(bodies[0].ci, true);
    assert.equal(notices.length, 1, "the notice is shown once");
    for (const off of [{ DO_NOT_TRACK: "1" }, { DO_NOT_TRACK: "true" }, { DIFFCI_NO_SEND: "1" }, { DIFFCI_SHARE_USAGE: "0" }]) {
      await recordUsage("verify", "passed", "0.3.9", {}, { ...env, ...off });
    }
    assert.equal(bodies.length, 2);
    await recordUsage("verify", "passed", "0.3.9", {}, { ...env, DO_NOT_TRACK: "0" });
    assert.equal(bodies.length, 3);

    const first = configureTelemetry("repo", true, env);
    assert.equal(configureTelemetry("repo", true, env).installationId, first.installationId);
    await recordUsage("verify", "passed", "0.3.9", {}, { ...env, DIFFCI_MCP: "1" });
    assert.equal(bodies[3].installation_id, first.installationId);
    assert.equal(bodies[3].activity, "internal");
    assert.equal(bodies[3].surface, "local-mcp");

    configureTelemetry("count-only", false, env);
    await recordUsage("observe", "observed", "0.3.9", {}, { ...env, DIFFCI_SURFACE: "github-action" });
    assert.equal(bodies[4].installation_id, undefined);
    assert.equal(bodies[4].repository, undefined);
    assert.equal(bodies[4].surface, "github-action");
    assert.equal(readTelemetryPreference(env).installationId, undefined);

    // Older saved choices map: off and anonymous never shared a name, installations did.
    writeFileSync(preferencePath(env), '{"mode":"off"}');
    assert.equal(readTelemetryPreference(env).mode, "count-only");
    writeFileSync(preferencePath(env), '{"mode":"anonymous"}');
    assert.equal(readTelemetryPreference(env).mode, "count-only");
    writeFileSync(preferencePath(env), '{"mode":"installations","installationId":"email@example.com"}');
    assert.deepEqual([readTelemetryPreference(env).mode, readTelemetryPreference(env).installationId], ["repo", undefined]);
    assert.throws(() => configureTelemetry("everything", false, env));
  } finally { globalThis.fetch = originalFetch; console.error = originalError; rmSync(home, { recursive: true, force: true }); }
});

test("a failing endpoint never throws out of recordUsage", async () => {
  const home = mkdtempSync(join(tmpdir(), "diffci-telemetry-"));
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  globalThis.fetch = async () => { throw new Error("network down"); };
  console.error = () => {};
  try { await recordUsage("plan", "full", "0.3.9", {}, { DIFFCI_TELEMETRY_HOME: home }); }
  finally { globalThis.fetch = originalFetch; console.error = originalError; rmSync(home, { recursive: true, force: true }); }
});

test("remote URLs become host/owner/repo without credentials", () => {
  assert.equal(normaliseRemote("git@github.com:Acme/Widgets.git"), "github.com/acme/widgets");
  assert.equal(normaliseRemote("https://user:ghp_secret@github.com/acme/widgets.git"), "github.com/acme/widgets");
  assert.equal(normaliseRemote("ssh://git@gitlab.example.com:2222/group/sub/project.git\n"), "gitlab.example.com/group/sub/project");
  assert.equal(normaliseRemote("file:///home/me/repo"), undefined);
  assert.equal(normaliseRemote("/home/me/repo"), undefined);
  assert.equal(repositoryName(undefined, { CI_SERVER_HOST: "gitlab.com", CI_PROJECT_PATH: "g/p" }), "gitlab.com/g/p");
});

test("delivery distinguishes receipt acceptance, forwarding success, rejection and timeout", async () => {
  const signal = { command: "verify" as const, outcome: "passed" as const, version: "0.3.9" };
  for (const [status, expected] of [[200, "delivered"], [202, "accepted"], [502, "failed"]] as const) {
    assert.equal((await deliverUsageSignal({ ...signal, fetchImpl: async () => new Response(null, { status }) })).status, expected);
  }
  assert.equal((await deliverUsageSignal({ ...signal, fetchImpl: async () => { throw new DOMException("timeout", "TimeoutError"); } })).status, "timed-out");
});
