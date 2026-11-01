/**
 * Phase 03 (2026-08-26): sending the report out of somebody else's CI.
 *
 * Two properties are being defended: a credential must never travel in the clear or appear in output,
 * and a delivery problem must never become the host repository's failure. The retry policy is tested
 * because getting it wrong in either direction is expensive - retrying a 4xx hammers a server that has
 * already said no, and not retrying a 5xx throws away an observation over a transient blip.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { makeReport } from "../helpers/report-fixture.js";
import { submitObservation } from "../../src/client/submit.js";

const TOKEN = "dci_secret_value_that_must_never_appear";

function respondWith(responses: Array<{ status: number; body?: unknown }>): { fetchImpl: typeof fetch; calls: Request[] } {
  const calls: Request[] = [];
  let index = 0;
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    calls.push(new Request(input as string, init));
    const next = responses[Math.min(index++, responses.length - 1)]!;
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const noSleep = async (): Promise<void> => undefined;

describe("submitting an observation", () => {
  it("sends the report with the token as a bearer credential", async () => {
    const { fetchImpl, calls } = respondWith([{ status: 201, body: { ok: true, duplicate: false } }]);
    const outcome = await submitObservation({ apiUrl: "https://api.diffci.test/v1/ingest/observations", token: TOKEN, report: makeReport(), fetchImpl });

    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.duplicate, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.headers.get("authorization"), `Bearer ${TOKEN}`);
    assert.equal(calls[0]!.method, "POST");
  });

  it("reports a duplicate as success, because a re-run is not a failure", async () => {
    const { fetchImpl } = respondWith([{ status: 200, body: { ok: true, duplicate: true } }]);
    const outcome = await submitObservation({ apiUrl: "https://api.diffci.test/v1/ingest/observations", token: TOKEN, report: makeReport(), fetchImpl });
    assert.equal(outcome.ok === true && outcome.duplicate, true);
  });

  it("refuses to send a credential over plain http", async () => {
    const { fetchImpl, calls } = respondWith([{ status: 201 }]);
    const outcome = await submitObservation({ apiUrl: "http://api.diffci.test/v1/ingest/observations", token: TOKEN, report: makeReport(), fetchImpl });

    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.kind, "misconfigured");
    assert.equal(calls.length, 0, "nothing may be sent at all");
  });

  it("allows plain http to localhost, so the flow is developable without weakening the rule", async () => {
    const { fetchImpl } = respondWith([{ status: 201, body: { ok: true } }]);
    const outcome = await submitObservation({ apiUrl: "http://localhost:8787/v1/ingest/observations", token: TOKEN, report: makeReport(), fetchImpl });
    assert.equal(outcome.ok, true);
  });

  it("never puts the token in any returned value, including on failure", async () => {
    const cases = [
      await submitObservation({ apiUrl: "http://api.diffci.test/x", token: TOKEN, report: makeReport(), fetchImpl: respondWith([{ status: 201 }]).fetchImpl }),
      await submitObservation({
        apiUrl: "https://api.diffci.test/x",
        token: TOKEN,
        report: makeReport(),
        fetchImpl: respondWith([{ status: 401, body: { ok: false, rejection: "invalid_token", error: "not recognised" } }]).fetchImpl,
      }),
      await submitObservation({
        apiUrl: "https://api.diffci.test/x",
        token: TOKEN,
        report: makeReport(),
        retries: 0,
        fetchImpl: (async () => {
          throw new Error(`connection refused while sending Bearer ${TOKEN}`);
        }) as unknown as typeof fetch,
      }),
    ];
    for (const outcome of cases) {
      assert.equal(JSON.stringify(outcome).includes(TOKEN), false, `token leaked into ${JSON.stringify(outcome)}`);
    }
  });

  it("retries a server error once, then gives up without failing the build", async () => {
    const { fetchImpl, calls } = respondWith([{ status: 503 }, { status: 503 }]);
    const outcome = await submitObservation({ apiUrl: "https://api.diffci.test/x", token: TOKEN, report: makeReport(), fetchImpl, sleep: noSleep });

    assert.equal(calls.length, 2);
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.kind, "unreachable");
    assert.match(outcome.message, /on disk/);
  });

  it("succeeds when the retry succeeds", async () => {
    const { fetchImpl, calls } = respondWith([{ status: 500 }, { status: 201, body: { ok: true } }]);
    const outcome = await submitObservation({ apiUrl: "https://api.diffci.test/x", token: TOKEN, report: makeReport(), fetchImpl, sleep: noSleep });
    assert.equal(outcome.ok, true);
    assert.equal(calls.length, 2);
  });

  it("does not retry a rejection, and passes the server's own message through", async () => {
    const { fetchImpl, calls } = respondWith([
      { status: 403, body: { ok: false, rejection: "repository_mismatch", error: "This token belongs to acme/checkout" } },
    ]);
    const outcome = await submitObservation({ apiUrl: "https://api.diffci.test/x", token: TOKEN, report: makeReport(), fetchImpl, sleep: noSleep });

    assert.equal(calls.length, 1, "a 4xx repeated verbatim gets the same answer, more slowly");
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.kind, "rejected");
    assert.equal(outcome.rejection, "repository_mismatch");
    assert.match(outcome.message, /acme\/checkout/);
  });

  it("refuses without a token rather than sending an unauthenticated report", async () => {
    const { fetchImpl, calls } = respondWith([{ status: 201 }]);
    const outcome = await submitObservation({ apiUrl: "https://api.diffci.test/x", token: "", report: makeReport(), fetchImpl });
    assert.equal(outcome.ok === false && outcome.kind, "misconfigured");
    assert.equal(calls.length, 0);
  });
});
