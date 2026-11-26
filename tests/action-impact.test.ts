// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// @ts-expect-error - plain ESM shipped with the Action, deliberately untyped and dependency-free.
import { commentMarker, formatComment, formatUpdateSummary, impactOutputs, isNewer, main, updateNotice, upsertComment } from "../action/impact.mjs";

function report(overrides: Record<string, unknown> = {}, result: Record<string, unknown> = {}) {
  return {
    status: "OBSERVED",
    stage: "complete",
    payload: { includesFilePaths: true },
    nonInterference: { worktreeUnchanged: true, workflowFindings: [] },
    result: {
      mode: "SELECTIVE",
      changedFileCount: 2,
      selectedTests: ["tests/a.test.ts", "tests/b.test.ts"],
      selectionReasons: { "tests/a.test.ts": { reason: "DIRECT_IMPORT", changed_file: "src/a.ts" } },
      totalTestCount: 40,
      fallbackReasons: [],
      blindSpot: false,
      ...result,
    },
    ...overrides,
  };
}

test("a clean selective observation is the only thing that narrows", () => {
  assert.deepEqual(impactOutputs(report()), {
    "full-suite-required": "false",
    "affected-tests": JSON.stringify(["tests/a.test.ts", "tests/b.test.ts"]),
    "affected-test-count": "2",
    "total-test-count": "40",
    reason: "",
  });
});

test("every unsure case requires the full suite", () => {
  const full = impactOutputs(report({}, { mode: "FULL", fallbackReasons: ["package.json changed"] }));
  assert.equal(full["full-suite-required"], "true");
  assert.equal(full["affected-tests"], "");
  assert.equal(full.reason, "package.json changed");

  for (const unsure of [
    report({}, { blindSpot: true }),
    report({ nonInterference: { worktreeUnchanged: false, workflowFindings: [] } }),
    report({ status: "REFUSED", stage: "commit-range", reason: "base commit missing", result: undefined }),
    undefined,
  ]) {
    const outputs = impactOutputs(unsure);
    assert.equal(outputs["full-suite-required"], "true");
    assert.equal(outputs["affected-tests"], "");
    assert.notEqual(outputs.reason, "");
  }
});

test("redacted paths never become a runnable (empty) test list", () => {
  const outputs = impactOutputs(report({ payload: { includesFilePaths: true, pathRedaction: "sha256-12" } }));
  assert.equal(outputs["full-suite-required"], "false");
  assert.equal(outputs["affected-tests"], "", "digests are not test paths, and [] would mean run nothing");
});

test("an oversized selection is left out rather than cut short", () => {
  const selectedTests = Array.from({ length: 20_000 }, (_, index) => `tests/very/long/path/number-${index}.test.ts`);
  const outputs = impactOutputs(report({}, { selectedTests }));
  assert.equal(outputs["affected-tests"], "");
  assert.equal(outputs["affected-test-count"], "20000");
});

test("the comment leads with the answer and cannot mention anyone", () => {
  const marker = commentMarker("CI/diffci");
  const selective = formatComment(report(), { marker, runUrl: "https://github.com/o/r/actions/runs/1" });
  assert.ok(selective.startsWith(marker));
  assert.match(selective, /\*\*2 of 40 test files\*\* are affected by 2 changed files/);
  assert.match(selective, /direct import from `src\/a\.ts`/);
  assert.match(selective, /\[Details in the job summary\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/1\)/);

  const full = formatComment(report({}, { mode: "FULL", fallbackReasons: ["@acme/config changed"] }), { marker });
  assert.match(full, /The full test suite is needed/);
  assert.doesNotMatch(full, /@acme/, "an @ in prose would notify a user or team");
  assert.equal(commentMarker("a-->b"), "<!-- diffci-change-impact:a--b -->");
  assert.equal(commentMarker("a--!>b"), "<!-- diffci-change-impact:a--!b -->");
  assert.equal(commentMarker("CI/diffci"), "<!-- diffci-change-impact:CI/diffci -->", "existing markers keep matching");
});

type Call = { method: string; url: string; body?: string };

async function withFetch<T>(responses: Array<{ status: number; json?: unknown }>, run: (calls: Call[]) => Promise<T>) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: { method: string; body?: string }) => {
    calls.push({ method: init.method, url, body: init.body });
    const next = responses.shift() ?? { status: 500 };
    return { ok: next.status < 300, status: next.status, json: async () => next.json } as Response;
  }) as typeof fetch;
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

function prEnv(number?: number) {
  const dir = mkdtempSync(join(tmpdir(), "diffci-impact-"));
  const eventPath = join(dir, "event.json");
  writeFileSync(eventPath, JSON.stringify(number ? { pull_request: { number } } : {}));
  return {
    DIFFCI_GITHUB_TOKEN: "t",
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_REPOSITORY: "o/r",
    GITHUB_WORKFLOW: "CI",
    GITHUB_JOB: "diffci",
    GITHUB_API_URL: "https://api.example",
  };
}

test("the comment is created once and then updated in place", async () => {
  const env = prEnv(7);
  await withFetch([{ status: 200, json: [{ id: 1, body: "unrelated" }] }, { status: 201, json: {} }], async (calls) => {
    assert.equal(await upsertComment(env, report()), "created");
    assert.equal(calls[1]!.method, "POST");
    assert.equal(calls[1]!.url, "https://api.example/repos/o/r/issues/7/comments");
  });
  const marker = commentMarker("CI/diffci");
  await withFetch(
    [{ status: 200, json: [{ id: 9, body: `> ${marker} quoted by a person` }, { id: 3, body: `${marker}\nold` }] }, { status: 200, json: {} }],
    async (calls) => {
      assert.equal(await upsertComment(env, report()), "updated");
      assert.equal(calls[1]!.method, "PATCH");
      assert.equal(calls[1]!.url, "https://api.example/repos/o/r/issues/comments/3");
    },
  );
});

test("outside a pull request nothing is posted", async () => {
  await withFetch([], async (calls) => {
    assert.equal(await upsertComment(prEnv(), report()), "skipped: not a pull request event");
    assert.equal(calls.length, 0);
  });
});

test("a read-only token warns and never fails, and outputs are still written", async () => {
  const env = prEnv(7);
  const dir = mkdtempSync(join(tmpdir(), "diffci-impact-"));
  const reportPath = join(dir, "report.json");
  const outputPath = join(dir, "output");
  writeFileSync(reportPath, JSON.stringify(report()));
  writeFileSync(outputPath, "");
  const logged: string[] = [];
  const log = console.log;
  console.log = (message: string) => logged.push(message);
  try {
    await withFetch([{ status: 403 }], () =>
      main({ ...env, DIFFCI_REPORT: reportPath, DIFFCI_COMMENT: "true", GITHUB_OUTPUT: outputPath }),
    );
  } finally {
    console.log = log;
  }
  assert.match(readFileSync(outputPath, "utf8"), /^full-suite-required=false$/m);
  assert.ok(logged.some((line) => line.startsWith("::warning") && line.includes("pull-requests: write")));
});

// #278: a path that is not a git checkout leaves no evidence; the comment must not report a changed tree.
test("a refusal with no checkout to compare does not warn that the working tree changed", () => {
  const refused = report({ status: "REFUSED", stage: "context", reason: "not a git repository, or HEAD could not be resolved", result: undefined,
    nonInterference: { worktreeUnchanged: false, reportWrittenOutsideRepository: true, workflowFindings: [] } });
  const text = formatComment(refused, { marker: commentMarker("w/j") });
  assert.doesNotMatch(text, /working tree changed/);
  assert.equal(impactOutputs(refused)["full-suite-required"], "true");

  const moved = report({ nonInterference: { headShaBefore: "a".repeat(40), headShaAfter: "b".repeat(40), worktreeDigestBefore: "d", worktreeDigestAfter: "d", worktreeUnchanged: false, workflowFindings: [] } });
  assert.match(formatComment(moved, { marker: commentMarker("w/j") }), /working tree changed/);
  const lost = report({ nonInterference: { headShaBefore: "a".repeat(40), worktreeDigestBefore: "d", worktreeUnchanged: false, workflowFindings: [] } });
  assert.match(formatComment(lost, { marker: commentMarker("w/j") }), /working tree changed/);
});

// Update notice (2026-11-26): an outside adopter ran 0.3.60 for a week while 0.3.66 fixed what made every plan
// FULL for them, and nothing in their runs said so.
test("isNewer compares plain releases only", () => {
  assert.equal(isNewer("0.3.66", "0.3.60"), true);
  assert.equal(isNewer("0.4.0", "0.3.99"), true);
  assert.equal(isNewer("0.3.10", "0.3.9"), true);
  assert.equal(isNewer("0.3.60", "0.3.60"), false);
  assert.equal(isNewer("0.3.59", "0.3.60"), false);
  assert.equal(isNewer("0.4.0-rc.1", "0.3.60"), false);
  assert.equal(isNewer(undefined, "0.3.60"), false);
  assert.equal(isNewer("0.3.66", "0.3.60-beta.1"), false);
});

const SHA = "34a71469c0fcfa25aeb40e2d7c93645574fe6484";

test("updateNotice names the newer release with a Dependabot-readable SHA pin", async () => {
  const notice = await updateNotice({ DIFFCI_CLI_VERSION: "0.3.60" }, { fetchLatest: async () => "0.3.66", resolveSha: async () => SHA });
  assert.deepEqual(notice, {
    current: "0.3.60", latest: "0.3.66", sha: SHA,
    uses: `DiffCI/core@${SHA} # v0.3.66`,
    releaseUrl: "https://github.com/DiffCI/core/releases/tag/v0.3.66",
  });
  const tagOnly = await updateNotice({ DIFFCI_CLI_VERSION: "0.3.60" }, { fetchLatest: async () => "0.3.66", resolveSha: async () => undefined });
  assert.equal(tagOnly?.uses, "DiffCI/core@v0.3.66");
});

test("updateNotice stays silent when current, turned off, or the check fails", async () => {
  let fetched = 0;
  const fetchLatest = async () => { fetched++; return "0.3.66"; };
  assert.equal(await updateNotice({ DIFFCI_CLI_VERSION: "0.3.66" }, { fetchLatest }), undefined);
  assert.equal(await updateNotice({ DIFFCI_CLI_VERSION: "0.3.60", DIFFCI_UPDATE_NOTICE: "false" }, { fetchLatest }), undefined);
  assert.equal(await updateNotice({}, { fetchLatest }), undefined);
  assert.equal(fetched, 1, "turned off or no version: no request at all");
  assert.equal(await updateNotice({ DIFFCI_CLI_VERSION: "0.3.60" }, { fetchLatest: async () => { throw new Error("offline"); } }), undefined);
  assert.equal(await updateNotice({ DIFFCI_CLI_VERSION: "0.3.60" }, { fetchLatest: async () => "0.3.66", resolveSha: async () => { throw new Error("no git"); } }).then(n => n?.uses), "DiffCI/core@v0.3.66");
});

test("the notice reaches the PR comment, the job summary and an annotation", async () => {
  const notice = { current: "0.3.60", latest: "0.3.66", sha: SHA, uses: `DiffCI/core@${SHA} # v0.3.66`, releaseUrl: "https://github.com/DiffCI/core/releases/tag/v0.3.66" };
  const comment = formatComment(report(), { marker: commentMarker("w/j"), notice });
  assert.match(comment, /DiffCI 0\.3\.66 is available; this run used 0\.3\.60/);
  assert.ok(comment.includes(`uses: DiffCI/core@${SHA} # v0.3.66`));
  assert.doesNotMatch(formatComment(report(), { marker: commentMarker("w/j") }), /is available/);
  assert.ok(formatUpdateSummary(notice).includes(`- uses: DiffCI/core@${SHA} # v0.3.66`));

  const dir = mkdtempSync(join(tmpdir(), "diffci-update-notice-"));
  const summary = join(dir, "summary.md");
  writeFileSync(summary, "");
  const logged: string[] = [];
  const original = console.log;
  console.log = (line: string) => { logged.push(String(line)); };
  try {
    await main({ GITHUB_STEP_SUMMARY: summary }, { checkUpdate: async () => notice });
    await main({ GITHUB_STEP_SUMMARY: summary }, { checkUpdate: async () => { throw new Error("boom"); } });
  } finally { console.log = original; }
  assert.match(readFileSync(summary, "utf8"), /### DiffCI 0\.3\.66 is available/);
  assert.equal(logged.filter(line => line.startsWith("::notice title=DiffCI 0.3.66 is available::")).length, 1);
});
