import assert from "node:assert/strict";
import { test } from "node:test";
import { sendUsageSignal } from "../../src/client/usage-signal.js";

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
