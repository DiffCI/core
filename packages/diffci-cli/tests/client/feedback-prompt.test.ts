import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { formatFeedbackPrompt, markFeedbackPromptShown, shouldShowFeedbackPrompt } from "../../src/client/feedback-prompt.js";

test("feedback prompt is interactive-only, suppressible and at most weekly", () => {
  const home = mkdtempSync(join(tmpdir(), "diffci-feedback-"));
  const env = { DIFFCI_TELEMETRY_HOME: home };
  const now = Date.UTC(2026, 9, 28);
  try {
    assert.equal(shouldShowFeedbackPrompt({}, env, true, now), true);
    assert.equal(shouldShowFeedbackPrompt({ "no-send": true }, env, true, now), true);
    assert.equal(shouldShowFeedbackPrompt({}, env, false, now), false);
    assert.equal(shouldShowFeedbackPrompt({ json: true }, env, true, now), false);
    assert.equal(shouldShowFeedbackPrompt({ quiet: true }, env, true, now), false);
    assert.equal(shouldShowFeedbackPrompt({}, { ...env, CI: "true" }, true, now), false);
    assert.equal(shouldShowFeedbackPrompt({}, { ...env, DIFFCI_MCP: "1" }, true, now), false);
    assert.equal(shouldShowFeedbackPrompt({}, { ...env, DIFFCI_NO_FEEDBACK_PROMPT: "1" }, true, now), false);
    markFeedbackPromptShown(env, now);
    assert.equal(shouldShowFeedbackPrompt({}, env, true, now + 6 * 24 * 3600 * 1000), false);
    assert.equal(shouldShowFeedbackPrompt({}, env, true, now + 8 * 24 * 3600 * 1000), true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("feedback prompt offers telemetry only while it is off", () => {
  assert.match(formatFeedbackPrompt("off"), /diffci telemetry --mode anonymous/);
  assert.doesNotMatch(formatFeedbackPrompt("anonymous"), /diffci telemetry/);
  assert.match(formatFeedbackPrompt("anonymous"), /diffci\.com\/#pilot/);
});
