// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// @ts-expect-error - plain ESM shipped with the Action, deliberately untyped and dependency-free.
import { DEFAULT_CHECK_NAME, agentLabel, commitMessages, detectAgents, gateVerdict, main } from "../action/check-run.mjs";

const HEAD = "a".repeat(40);

function report(result: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  return {
    status: "OBSERVED",
    stage: "complete",
    observer: { version: "0.3.40" },
    result: {
      mode: "SELECTIVE",
      changedFileCount: 3,
      selectedTests: ["tests/a.test.ts", "tests/b.test.ts"],
      totalTestCount: 40,
      fallbackReasons: [],
      blindSpot: false,
      ...result,
    },
    ...overrides,
  };
}

const receipt = {
  selection: "selected",
  tests_selected: 2,
  tests_available: 40,
  diffci_version: "0.3.40",
  checks: [{ id: "lint", status: "passed" }, { id: "typecheck", status: "passed" }],
};

test("agents are read from co-author trailers and the head branch, as labels only", () => {
  assert.deepEqual(detectAgents({ messages: ["fix\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>"] }), [{ agent: "claude", source: "trailer" }]);
  assert.deepEqual(detectAgents({ messages: ["x\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)"] }), [{ agent: "claude", source: "trailer" }]);
  assert.deepEqual(detectAgents({ branch: "codex/fix-login" }), [{ agent: "codex", source: "branch" }]);
  assert.deepEqual(detectAgents({ messages: ["y\n\nCo-authored-by: Claude <noreply@anthropic.com>"], branch: "claude/issue-12" }), [{ agent: "claude", source: "trailer+branch" }]);
  assert.deepEqual(
    detectAgents({ messages: ["a\n\nCo-authored-by: Copilot <198982749+Copilot@users.noreply.github.com>", "b\n\nCo-authored-by: Cursor Agent <cursoragent@cursor.com>"] }).map(({ agent }: { agent: string }) => agent),
    ["copilot", "cursor"],
  );
  assert.equal(agentLabel(detectAgents({ messages: ["a\n\nCo-authored-by: codex <codex@openai.com>", "b\n\nCo-authored-by: Claude <noreply@anthropic.com>"] })), "claude+codex");
});

test("people and prose that merely mention an agent are not attributed", () => {
  assert.deepEqual(detectAgents({ messages: ["Co-authored-by: Jane Doe <jane@example.com>", "Ask Claude about this later"] }), []);
  assert.deepEqual(detectAgents({ branch: "feature/claude-docs" }), []);
  assert.equal(agentLabel([]), "none detected");
});

test("the gate passes only when the affected tests passed, and fails only when they failed", () => {
  const agents = [{ agent: "claude", source: "trailer" }];
  const passed = gateVerdict({ verifyEnabled: true, verifyStatus: "passed", report: report(), receipt, agents });
  assert.equal(passed.conclusion, "success");
  assert.equal(passed.agent, "claude");
  assert.equal(passed.title, "Affected tests passed · agent: claude");
  assert.match(passed.summary, /\| Tests run \| 2 test files of 40 \|/);
  assert.match(passed.summary, /\| Not affected, not run here \| 38 test files/);
  assert.match(passed.summary, /`lint` passed, `typecheck` passed/);
  assert.match(passed.summary, /claude \(co-author trailer\)/);

  assert.equal(gateVerdict({ verifyEnabled: true, verifyStatus: "failed", report: report(), receipt }).conclusion, "failure");
});

test("the summary claims an uploaded record only when there is one", () => {
  const none = gateVerdict({ verifyEnabled: true, verifyStatus: "skipped", report: report({ mode: "FULL" }) });
  assert.doesNotMatch(none.summary, /uploaded/);
  const reportOnly = gateVerdict({ verifyEnabled: true, verifyStatus: "skipped", report: report({ mode: "FULL" }), uploaded: true });
  assert.match(reportOnly.summary, /The observation report is uploaded as an artifact\./);
  assert.doesNotMatch(reportOnly.summary, /receipt/);
  const both = gateVerdict({ verifyEnabled: true, verifyStatus: "passed", report: report(), receipt, uploaded: true });
  assert.match(both.summary, /observation report and verification receipt are uploaded/);
});

test("anything DiffCI is unsure about is neutral, never red", () => {
  const skipped = gateVerdict({
    verifyEnabled: true,
    verifyStatus: "skipped",
    report: report({ mode: "FULL", selectedTests: [], fallbackReasons: ["package.json changed", "@scope/pkg is unknown"] }),
  });
  assert.equal(skipped.conclusion, "neutral");
  assert.match(skipped.summary, /Why the full suite is needed:\n- package.json changed\n- @​scope\/pkg is unknown/);
  assert.equal(gateVerdict({ verifyEnabled: true, verifyStatus: "blocked", report: report() }).conclusion, "neutral");
  assert.equal(gateVerdict({ verifyEnabled: true, verifyStatus: "", report: undefined }).conclusion, "neutral");
  const refused = gateVerdict({ verifyEnabled: true, verifyStatus: "", report: { status: "REFUSED", stage: "commit-range", reason: "base commit missing" } });
  assert.match(refused.summary, /- base commit missing/);
  const off = gateVerdict({ verifyEnabled: false, verifyStatus: "", report: report() });
  assert.equal(off.conclusion, "neutral");
  assert.match(off.summary, /verify: "true"/);
});

test("commit messages are read from the range, and a bad range reads nothing", () => {
  const repo = mkdtempSync(join(tmpdir(), "diffci-gate-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("commit", "-q", "--allow-empty", "-m", "base");
  const base = git("rev-parse", "HEAD");
  git("commit", "-q", "--allow-empty", "-m", "change\n\nCo-authored-by: Claude <noreply@anthropic.com>");
  const head = git("rev-parse", "HEAD");
  const messages = commitMessages(repo, base, head);
  assert.equal(messages.length, 1);
  assert.deepEqual(detectAgents({ messages }).map(({ agent }: { agent: string }) => agent), ["claude"]);
  assert.deepEqual(commitMessages(repo, "--output=/tmp/x", head), [], "only commit ids reach git");
  assert.deepEqual(commitMessages(repo, base, "f".repeat(40)), [], "an unknown commit reads nothing");
});

test("main posts one completed check run on the pull request head, and never throws", async () => {
  const dir = mkdtempSync(join(tmpdir(), "diffci-gate-main-"));
  const event = join(dir, "event.json");
  const output = join(dir, "output");
  const reportPath = join(dir, "report.json");
  const receiptPath = join(dir, "receipt.json");
  writeFileSync(event, JSON.stringify({ pull_request: { number: 7, head: { sha: HEAD, ref: "claude/fix" }, base: { sha: "b".repeat(40) } } }));
  writeFileSync(reportPath, JSON.stringify(report()));
  writeFileSync(receiptPath, JSON.stringify(receipt));
  writeFileSync(output, "");

  const calls: Array<{ url: string; init: RequestInit }> = [];
  const realFetch = globalThis.fetch;
  const env = {
    GITHUB_EVENT_PATH: event,
    GITHUB_OUTPUT: output,
    GITHUB_REPOSITORY: "acme/app",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_RUN_ID: "99",
    GITHUB_SHA: "c".repeat(40),
    DIFFCI_REPORT: reportPath,
    DIFFCI_RECEIPT: receiptPath,
    DIFFCI_VERIFY_ENABLED: "true",
    DIFFCI_VERIFY_STATUS: "passed",
    DIFFCI_GITHUB_TOKEN: "t",
  };
  try {
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ html_url: "https://github.com/acme/app/runs/1" }), { status: 201 });
    }) as typeof fetch;
    await main(env);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://api.github.com/repos/acme/app/check-runs");
    const body = JSON.parse(String(calls[0]!.init.body));
    assert.equal(body.name, DEFAULT_CHECK_NAME);
    assert.equal(body.head_sha, HEAD, "the pull request head, not the merge commit");
    assert.equal(body.status, "completed");
    assert.equal(body.conclusion, "success");
    assert.equal(body.details_url, undefined, "GitHub ignores it for GITHUB_TOKEN check runs");
    assert.match(body.output.summary, /\(https:\/\/github\.com\/acme\/app\/actions\/runs\/99\)/, "the run link is in the summary");
    assert.equal(body.output.title, "Affected tests passed · agent: claude");
    assert.match(readFileSync(output, "utf8"), /gate-conclusion=success\nagent=claude\n/);

    globalThis.fetch = (async () => new Response("{}", { status: 403 })) as typeof fetch;
    await main(env);
    await main({ ...env, DIFFCI_GITHUB_TOKEN: "" });
  } finally {
    globalThis.fetch = realFetch;
  }
});
