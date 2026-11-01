import assert from "node:assert/strict";
import { test } from "node:test";
import { detectAgentFromEnvironment, normalizeDeclaredAgent, resolveObservationAgent } from "../../src/client/agent-identity.js";

test("declared agent names normalise to a closed set", () => {
  assert.equal(normalizeDeclaredAgent("Claude Code"), "claude");
  assert.equal(normalizeDeclaredAgent({ name: "github_copilot" }), "copilot");
  assert.equal(normalizeDeclaredAgent("some-new-agent"), "other");
  assert.equal(normalizeDeclaredAgent("human"), null);
  assert.equal(normalizeDeclaredAgent("not a valid name!"), undefined);
  assert.equal(normalizeDeclaredAgent(42), undefined);
});

test("--agent auto needs exactly one agent marker", () => {
  assert.equal(detectAgentFromEnvironment({ CLAUDECODE: "1" }), "claude");
  assert.equal(detectAgentFromEnvironment({ CLAUDECODE: "1", CURSOR_AGENT: "1" }), undefined);
  assert.equal(detectAgentFromEnvironment({ CLAUDECODE: "0" }), undefined);
});

test("no flag and no DIFFCI_AGENT means no agent field", () => {
  assert.equal(resolveObservationAgent(undefined, {}), undefined);
  assert.deepEqual(resolveObservationAgent("codex", {}), { name: "codex", source: "flag" });
  assert.deepEqual(resolveObservationAgent(undefined, { DIFFCI_AGENT: "auto", GEMINI_CLI: "1" }), { name: "gemini", source: "environment" });
  assert.equal(resolveObservationAgent("auto", {}), undefined);
});
