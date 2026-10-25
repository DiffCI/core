/**
 * Enforce mode step 5 (docs/enforce-mode-01-plan.md): miss detection. One fixture per classification -
 * miss, flaky, pre-existing failure, a pull request that ran the full suite - plus the JUnit parsing,
 * the receipt fallbacks and the collector's window and pull-request discovery, with GitHub faked.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  buildMissReport,
  classifyFailures,
  formatMissReportMarkdown,
  parseJunit,
  selectedFiles,
  type MergedPullRequest,
  type ReceiptFields,
  type TestOutcome,
} from "../../src/client/enforce-misses.js";
import { findReceipt, findWindowStart, mergedPullRequests, type CommandRunner } from "../../src/client/enforce-misses-collect.js";

const ROOT = "/repo";

function outcome(file: string, name: string, failed: boolean): TestOutcome {
  return { id: `${file} > ${name}`, file, name, failed, skipped: false };
}

function receipt(report: Partial<ReceiptFields>): ReceiptFields {
  return { schema: "diffci.verification.v1", selection: "selected", ...report };
}

function pr(number: number, report?: Partial<ReceiptFields>): MergedPullRequest {
  return {
    number,
    mergeSha: `merge${number}`,
    headSha: `head${number}`,
    ...(report ? { receipt: { artifact: `diffci-enforce-dry-run-${number}-1-1`, report: receipt(report) } } : {}),
  };
}

const FAILING = outcome("tests/a.test.ts", "adds", true);
const PASSING = outcome("tests/b.test.ts", "subtracts", false);

describe("classifyFailures", () => {
  it("miss: deterministic, new, and left out by a selected receipt", () => {
    const [failure] = classifyFailures({
      fullRun: [FAILING, PASSING],
      rerun: [FAILING],
      baseline: [],
      pullRequests: [pr(7, { selection: "selected", selected_tests: ["tests/b.test.ts"] })],
    });
    assert.equal(failure!.classification, "miss");
    assert.deepEqual(failure!.pull_requests, [{ number: 7, verdict: "missed", artifact: "diffci-enforce-dry-run-7-1-1" }]);
  });

  it("flaky: passes on re-run, logged and never counted, even when a selected receipt skipped it", () => {
    const report = buildMissReport({
      fullRun: [FAILING],
      rerun: [{ ...FAILING, failed: false }],
      baseline: [],
      pullRequests: [pr(7, { selection: "selected", selected_tests: [] })],
      headSha: "abc",
      producedAt: "2026-10-25T00:00:00Z",
      window: { from_sha: "base", source: "detector-record" },
    });
    assert.equal(report.failures[0]!.classification, "flaky");
    assert.equal(report.misses, 0);
    assert.deepEqual(report.open_unsafe_misses, []);
    assert.deepEqual(report.deterministic_failures, []);
    assert.match(formatMissReportMarkdown(report), /## flaky \(1\)/);
  });

  it("pre-existing: already failing at the window start, so no pull request in it is blamed", () => {
    const [failure] = classifyFailures({
      fullRun: [FAILING],
      rerun: [FAILING],
      baseline: [FAILING.id],
      pullRequests: [pr(7, { selection: "selected", selected_tests: [] })],
    });
    assert.equal(failure!.classification, "pre-existing");
  });

  it("pull request that ran the full suite cannot have skipped the test", () => {
    const [failure] = classifyFailures({
      fullRun: [FAILING],
      rerun: [FAILING],
      baseline: [],
      pullRequests: [pr(8, { selection: "full", enforcement: { policy: "enforce", policy_version: 1, fired_fallback: "global-risk", detail: "x", applied: false } })],
    });
    assert.equal(failure!.classification, "covered");
    assert.equal(failure!.pull_requests[0]!.verdict, "ran-full");
  });

  it("a test the selected receipt did run is covered, not a miss", () => {
    const [failure] = classifyFailures({
      fullRun: [FAILING],
      rerun: [FAILING],
      baseline: [],
      pullRequests: [pr(9, { selection: "selected", selected_tests: ["./tests/a.test.ts"] })],
    });
    assert.equal(failure!.classification, "covered");
  });

  it("one skipping pull request is enough for a miss, beside others that ran full", () => {
    const [failure] = classifyFailures({
      fullRun: [FAILING],
      rerun: [FAILING],
      baseline: [],
      pullRequests: [pr(8, { selection: "full" }), pr(9, { selection: "selected", selected_tests: ["tests/b.test.ts"] })],
    });
    assert.equal(failure!.classification, "miss");
    assert.match(failure!.detail, /#9/);
  });

  it("no receipt for any merged pull request is unattributed, not a miss", () => {
    const [failure] = classifyFailures({ fullRun: [FAILING], rerun: [FAILING], baseline: [], pullRequests: [pr(10)] });
    assert.equal(failure!.classification, "unattributed");
    assert.equal(failure!.pull_requests[0]!.verdict, "no-receipt");
  });

  it("without a re-run, nothing is ruled flaky: the failure is treated as deterministic", () => {
    const [failure] = classifyFailures({
      fullRun: [FAILING],
      rerun: undefined,
      baseline: [],
      pullRequests: [pr(7, { selection: "selected", selected_tests: [] })],
    });
    assert.equal(failure!.classification, "miss");
    assert.match(failure!.detail, /not re-run/);
  });

  it("a selected receipt that does not say what it selected counts as a miss", () => {
    const [failure] = classifyFailures({
      fullRun: [FAILING],
      rerun: [FAILING],
      baseline: [],
      pullRequests: [pr(7, { selection: "selected", command: "npm test" })],
    });
    assert.equal(failure!.classification, "miss");
    assert.equal(failure!.pull_requests[0]!.verdict, "selection-unrecorded");
  });
});

describe("buildMissReport", () => {
  it("prints the exact openUnsafeMisses entry and never claims to have changed anything", () => {
    const report = buildMissReport({
      fullRun: [FAILING, PASSING],
      rerun: [FAILING],
      baseline: [],
      pullRequests: [pr(7, { selection: "selected", selected_tests: ["tests/b.test.ts"] })],
      headSha: "abc123",
      producedAt: "2026-10-25T00:00:00Z",
      runUrl: "https://github.com/o/r/actions/runs/1",
      window: { from_sha: "base", source: "detector-record" },
    });
    assert.equal(report.misses, 1);
    assert.deepEqual(report.open_unsafe_misses, [{
      test: "tests/a.test.ts > adds",
      pullRequest: 7,
      receipt: "diffci-enforce-dry-run-7-1-1",
      mainSha: "abc123",
      detectedAt: "2026-10-25T00:00:00Z",
      run: "https://github.com/o/r/actions/runs/1",
    }]);
    assert.deepEqual(report.deterministic_failures, [FAILING.id]);
    const markdown = formatMissReportMarkdown(report);
    assert.match(markdown, /enforce\.openUnsafeMisses/);
    assert.match(markdown, /Nothing was changed automatically/);
  });
});

describe("parseJunit", () => {
  it("reads node:test's JUnit output: suites, failures, skips, entities and raw > in attributes", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
  <testcase name="ok" classname="test" file="/repo/tests/a.test.ts"/>
  <testcase name="bad &amp; worse" classname="test" file="/repo/tests/a.test.ts" failure="1 > 2">
    <failure type="testCodeFailure" message="1 > 2">at &lt;anonymous></failure>
  </testcase>
  <testsuite name="group" tests="2">
    <testcase name="inner" file="/repo/tests/b.test.ts"><failure message="x"/></testcase>
    <testcase name="later" file="/repo/tests/b.test.ts"><skipped/></testcase>
  </testsuite>
  <testcase name="outside" file="tests/c.test.ts"/>
</testsuites>`;
    const outcomes = parseJunit(xml, ROOT);
    assert.deepEqual(outcomes.map((o) => [o.id, o.failed, o.skipped]), [
      ["tests/a.test.ts > ok", false, false],
      ["tests/a.test.ts > bad & worse", true, false],
      ["tests/b.test.ts > group > inner", true, false],
      ["tests/b.test.ts > group > later", false, true],
      ["tests/c.test.ts > outside", false, false],
    ]);
  });
});

describe("selectedFiles", () => {
  it("prefers selected_tests and falls back to the command's test-file arguments", () => {
    assert.deepEqual([...selectedFiles(receipt({ selected_tests: ["tests/x.test.ts"] }))!], ["tests/x.test.ts"]);
    assert.deepEqual(
      [...selectedFiles(receipt({ command: 'npx --no-install tsx --test "tests/a.test.ts" tests/b.spec.ts' }))!],
      ["tests/a.test.ts", "tests/b.spec.ts"],
    );
    assert.equal(selectedFiles(receipt({ command: "npm test" })), undefined);
  });
});

describe("collector", () => {
  function fakeRunner(responses: Record<string, unknown>, ancestors: string[], files: Record<string, unknown> = {}): CommandRunner {
    return (executable, args) => {
      if (executable === "git" && args[0] === "merge-base") return { ok: ancestors.includes(args[2]!), stdout: "", stderr: "" };
      if (executable === "git" && args[0] === "rev-list") return { ok: true, stdout: "c1\nc2\n", stderr: "" };
      if (executable === "gh" && args[0] === "api") {
        const body = responses[args[1]!];
        return body === undefined ? { ok: false, stdout: "", stderr: "404" } : { ok: true, stdout: JSON.stringify(body), stderr: "" };
      }
      if (executable === "gh" && args[0] === "run" && args[1] === "download") {
        const content = files[args[args.indexOf("--name") + 1]!];
        const dir = args[args.indexOf("--dir") + 1]!;
        if (content === undefined) return { ok: false, stdout: "", stderr: "no artifact" };
        for (const [name, value] of Object.entries(content as Record<string, unknown>)) writeFileSync(join(dir, name), JSON.stringify(value));
        return { ok: true, stdout: "", stderr: "" };
      }
      return { ok: false, stdout: "", stderr: `unexpected ${executable} ${args.join(" ")}` };
    };
  }

  function options(run: CommandRunner, workDir: string) {
    return { repoPath: ROOT, repository: "o/r", headSha: "HEAD1", runId: "99", workDir, run };
  }

  it("starts the window at the newest earlier detector record on an ancestor, with its failures as baseline", () => {
    const workDir = mkdtempSync(join(tmpdir(), "diffci-misses-test-"));
    try {
      const run = fakeRunner(
        {
          "repos/o/r/actions/workflows/diffci-enforce-misses.yml/runs?branch=main&status=completed&per_page=30": {
            workflow_runs: [{ id: 99, head_sha: "HEAD1" }, { id: 98, head_sha: "notAncestor" }, { id: 97, head_sha: "older" }],
          },
          "repos/o/r/actions/runs/97/artifacts?per_page=100": { artifacts: [{ id: 1, name: "diffci-enforce-misses-97-1", expired: false }] },
        },
        ["HEAD1", "older"],
        { "diffci-enforce-misses-97-1": { "enforce-misses.json": { schema: "diffci.enforce-misses.v1", deterministic_failures: ["tests/a.test.ts > adds"] } } },
      );
      assert.deepEqual(findWindowStart(options(run, workDir)), { fromSha: "older", source: "detector-record", baseline: ["tests/a.test.ts > adds"] });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("falls back to the last green ci.yml push run, then to no window", () => {
    const green = fakeRunner(
      { "repos/o/r/actions/workflows/ci.yml/runs?branch=main&event=push&status=success&per_page=30": { workflow_runs: [{ id: 5, head_sha: "green" }] } },
      ["green"],
    );
    assert.deepEqual(findWindowStart(options(green, tmpdir())), { fromSha: "green", source: "green-full-run", baseline: [] });
    assert.deepEqual(findWindowStart(options(fakeRunner({}, []), tmpdir())), { fromSha: null, source: "none", baseline: [] });
  });

  it("finds merged pull requests on main once each, and their receipt at the pull request head", () => {
    const workDir = mkdtempSync(join(tmpdir(), "diffci-misses-test-"));
    try {
      const run = fakeRunner(
        {
          "repos/o/r/commits/c1/pulls": [{ number: 7, merged_at: "2026-10-24", base: { ref: "main" }, head: { sha: "h7" } }],
          "repos/o/r/commits/c2/pulls": [
            { number: 7, merged_at: "2026-10-24", base: { ref: "main" }, head: { sha: "h7" } },
            { number: 8, merged_at: null, base: { ref: "main" }, head: { sha: "h8" } },
          ],
          "repos/o/r/actions/workflows/diffci-enforce-dry-run.yml/runs?head_sha=h7&per_page=20": { workflow_runs: [{ id: 50, head_sha: "h7" }] },
          "repos/o/r/actions/runs/50/artifacts?per_page=100": { artifacts: [{ id: 2, name: "diffci-enforce-dry-run-7-50-1", expired: false }] },
        },
        [],
        { "diffci-enforce-dry-run-7-50-1": { "diffci-enforce-dry-run.json": { schema: "diffci.verification.v1", selection: "selected", selected_tests: [] } } },
      );
      const pulls = mergedPullRequests(options(run, workDir), "from");
      assert.deepEqual(pulls.map((p) => [p.number, p.mergeSha, p.headSha]), [[7, "c1", "h7"]]);
      const found = findReceipt(options(run, workDir), pulls[0]!);
      assert.equal(found?.artifact, "diffci-enforce-dry-run-7-50-1");
      assert.equal(found?.report.selection, "selected");
      assert.deepEqual(mergedPullRequests(options(run, workDir), null), []);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
