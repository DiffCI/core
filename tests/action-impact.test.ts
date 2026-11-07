// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// @ts-expect-error - plain ESM shipped with the Action, deliberately untyped and dependency-free.
import { commentMarker, formatComment, impactOutputs, main, upsertComment } from "../action/impact.mjs";

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
  assert.equal(commentMarker("a-->b"), "<!-- diffci-change-impact:ab -->");
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
