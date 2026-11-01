import { strict as assert } from "node:assert";
import { test } from "node:test";
import { githubDeliveryWarning } from "../../src/client/delivery-warning.js";

test("failed delivery becomes a non-failing GitHub Actions warning", () => {
  assert.equal(
    githubDeliveryWarning("not sent (server): retry 50%\nlater", { GITHUB_ACTIONS: "true" }),
    "::warning title=DiffCI report delivery failed::not sent (server): retry 50%25%0Alater",
  );
});

test("successful delivery and local runs do not emit workflow commands", () => {
  assert.equal(githubDeliveryWarning("sent", { GITHUB_ACTIONS: "true" }), undefined);
  assert.equal(githubDeliveryWarning("not sent: unavailable", {}), undefined);
});
