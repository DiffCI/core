import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  agentMarker,
  bucketJob,
  classify,
  collectRedBuilds,
  formatReport,
  pickMainWorkflow,
  githubClient,
  runRedBuildsCommand,
  signatures,
  StopCollection,
  type Annotation,
  type GitHubGet,
  type JobSummary,
  type RunSummary,
} from "../../src/client/red-builds.js";

const REPO = "acme/app";

function job(id: number, name: string, failedSteps: string[] = ["Run tests"], conclusion = "failure"): JobSummary {
  return { id, name, conclusion, startedAt: "2026-11-10T10:00:00Z", completedAt: "2026-11-10T10:10:00Z", failedSteps };
}

function run(id: number, overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    id, workflowId: 1, workflowName: "CI", attempt: 1, headSha: `${id}`.padStart(40, "a"), headBranch: `feature-${id}`,
    headRepo: REPO, conclusion: "failure", createdAt: `2026-11-10T10:${String(id % 60).padStart(2, "0")}:00Z`, ...overrides,
  };
}

const fail = (path: string, message: string): Annotation => ({ path, title: null, message, level: "failure" });

describe("bucketJob", () => {
  it("sorts jobs into local checks, CI-only jobs and infrastructure", () => {
    assert.equal(bucketJob(job(1, "lint")), "check");
    assert.equal(bucketJob(job(1, "Typecheck")), "check");
    assert.equal(bucketJob(job(1, "Unit tests (node 22)")), "check");
    assert.equal(bucketJob(job(1, "CI / build")), "check");
    assert.equal(bucketJob(job(1, "E2E tests")), "ci-only", "CI-only wins over the word tests");
    assert.equal(bucketJob(job(1, "Playwright (chromium)")), "ci-only");
    assert.equal(bucketJob(job(1, "Deploy preview")), "ci-only");
    assert.equal(bucketJob(job(1, "policy")), "ci-only", "an unknown job never counts as a local check");
    assert.equal(bucketJob(job(1, "test", ["Set up job", "Install dependencies"])), "infra");
    assert.equal(bucketJob(job(1, "test", [])), "infra", "no failed step: cancelled or timed out");
    assert.equal(bucketJob(job(1, "test", ["Block untrusted lockfile edits"])), "ci-only");
  });

  it("honours overriding patterns", () => {
    const patterns = { checkJob: /^policy$/i, ciOnlyJob: /^nothing$/ };
    assert.equal(bucketJob(job(1, "policy"), patterns), "check");
  });
});

describe("signatures", () => {
  it("keeps file + first message line, blurs numbers and hashes, drops runner noise", () => {
    const sigs = signatures([
      fail("src/a.test.ts", "expected 3 to be 4\n  at line 12"),
      fail(".github", "Process completed with exit code 1."),
      fail("src/b.ts", "Process completed with exit code 2."),
      { path: "src/c.ts", title: null, message: "warning", level: "warning" },
    ]);
    assert.deepEqual([...sigs], ["src/a.test.ts ::  :: expected # to be #"]);
  });
});

describe("classify", () => {
  it("tells the PR's own failures from shared ones, and counts the rest honestly", () => {
    const runs = [
      run(1), // own lint failure -> preventable
      run(2), // same test failure as run 3, on another PR -> shared
      run(3),
      run(4), // own check failure plus an E2E failure -> partly
      run(5), // check failed, no annotations -> likely
      run(6), // only E2E -> ci-only
      run(7), // setup step -> infra
      run(8, { headSha: "f".repeat(40) }), // passed later on the same commit -> flaky
      run(9, { headSha: "f".repeat(40), conclusion: "success" }),
      run(10, { conclusion: "success" }),
    ];
    const jobs = new Map<number, JobSummary[]>([
      [1, [job(11, "lint"), job(12, "unit", [], "success")]],
      [2, [job(21, "unit tests")]],
      [3, [job(31, "unit tests")]],
      [4, [job(41, "typecheck"), job(42, "e2e")]],
      [5, [job(51, "unit tests")]],
      [6, [job(61, "playwright")]],
      [7, [job(71, "unit tests", ["Install dependencies"])]],
      [8, [job(81, "unit tests")]],
    ]);
    const annotations = new Map<number, Annotation[]>([
      [11, [fail("src/x.ts", "'y' is defined but never used")]],
      [21, [fail("tests/db.test.ts", "connection refused on port 5432")]],
      [31, [fail("tests/db.test.ts", "connection refused on port 5433")]],
      [41, [fail("src/z.ts", "Type 'string' is not assignable to type 'number'.")]],
      [81, [fail("tests/q.test.ts", "boom")]],
    ]);
    const rows = classify({ repository: REPO, runs, jobs, annotations });
    const verdict = Object.fromEntries(rows.map((r) => [r.run, r.verdict]));
    assert.deepEqual(verdict, { 1: "preventable", 2: "shared", 3: "shared", 4: "partly", 5: "likely", 6: "ci-only", 7: "infra", 8: "flaky" });
    assert.equal(rows.find((r) => r.run === 1)!.runnerMinutes, 20);
  });

  it("leaves out red runs whose jobs could not be read", () => {
    assert.deepEqual(classify({ repository: REPO, runs: [run(1)], jobs: new Map(), annotations: new Map() }), []);
  });
});

describe("agentMarker", () => {
  it("spots agent co-author trailers and agent branch prefixes", () => {
    assert.deepEqual(agentMarker("fix\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>", "main"), { written: true, marker: "claude" });
    assert.deepEqual(agentMarker("feat\n\n🤖 Generated with [Claude Code](https://claude.com)", "x"), { written: true, marker: "claude code" });
    assert.deepEqual(agentMarker("fix", "codex/fix-thing"), { written: true, marker: "branch prefix" });
    assert.deepEqual(agentMarker("fix\n\nCo-authored-by: Jane <jane@example.com>", "jane/fix"), { written: false, marker: "" });
  });
});

function fakeGitHub(routes: Record<string, unknown>, calls: string[] = []): GitHubGet {
  return async (path) => {
    calls.push(path);
    const key = Object.keys(routes).find((prefix) => path.startsWith(prefix));
    if (!key) return { status: 404, body: { message: "Not Found" } };
    return { status: 200, body: routes[key] };
  };
}

describe("collectRedBuilds", () => {
  const runsPage = { workflow_runs: [
      { id: 1, workflow_id: 9, name: "CI", run_attempt: 2, head_sha: "a".repeat(40), head_branch: "claude/fix", head_repository: { full_name: REPO }, conclusion: "failure", created_at: "2026-11-10T10:00:00Z" },
      { id: 2, workflow_id: 9, name: "CI", run_attempt: 1, head_sha: "b".repeat(40), head_branch: "ok", head_repository: { full_name: "fork/app" }, conclusion: "success", created_at: "2026-11-10T11:00:00Z" },
  ] };
  const routes = {
    [`repos/${REPO}/actions/runs?`]: runsPage,
    [`repos/${REPO}/actions/workflows/9/runs?`]: runsPage,
    [`repos/${REPO}/actions/runs/1/attempts/2/jobs`]: { jobs: [
      { id: 100, name: "lint", conclusion: "failure", started_at: "2026-11-10T10:00:00Z", completed_at: "2026-11-10T10:03:00Z", steps: [{ name: "Run eslint", conclusion: "failure" }] },
    ] },
    [`repos/${REPO}/check-runs/100/annotations`]: [{ path: "src/a.ts", annotation_level: "failure", message: "no-unused-vars" }],
    [`repos/${REPO}/commits/${"a".repeat(40)}`]: { commit: { message: "fix\n\nCo-Authored-By: Claude <noreply@anthropic.com>" } },
  };

  it("reads only the latest attempt of red runs, then annotations and the preventable commits", async () => {
    const calls: string[] = [];
    const report = await collectRedBuilds({ repository: REPO, get: fakeGitHub(routes, calls), maxRuns: 200 });
    assert.equal(report.pullRequestRuns, 2);
    assert.equal(report.redRuns, 1);
    assert.equal(report.verdicts.preventable.runs, 1);
    assert.equal(report.agentWrittenPreventable, 1);
    assert.equal(report.rows[0]!.fork, false);
    assert.equal(calls.length, 5, "workflow sample, its runs, one job list, one annotation list, one commit");
    assert.equal(report.workflow, "CI");
    const text = formatReport(report);
    assert.match(text, /2 pull request runs, 1 red \(50%\)/);
    assert.match(text, /Up to 1 of 1 red runs \(100%\)/);
    assert.match(text, /written by a coding agent\s+1/);
    assert.match(text, /upper bound/);
  });

  it("reports what it read when GitHub asks it to stop", async () => {
    let n = 0;
    const get: GitHubGet = async (path) => {
      if (++n > 3) throw new StopCollection("fewer than 1000 GitHub API calls left this hour");
      return fakeGitHub(routes)(path);
    };
    const report = await collectRedBuilds({ repository: REPO, get, maxRuns: 200 });
    assert.match(report.stoppedEarly ?? "", /fewer than 1000/);
    assert.equal(report.verdicts.likely.runs, 1, "no annotations were read, so it cannot confirm whose failure it was");
    assert.match(formatReport(report), /Stopped early/);
  });

  it("names a missing repository instead of reporting zero", async () => {
    await assert.rejects(collectRedBuilds({ repository: REPO, get: fakeGitHub({}), maxRuns: 10 }), /not found/);
  });
});

describe("githubClient", () => {
  function response(status: number, headers: Record<string, string>, body: unknown = {}) {
    return new Response(JSON.stringify(body), { status, headers });
  }

  it("paces calls and stops below the quota floor or on Retry-After", async () => {
    const sleeps: number[] = [];
    let remaining = "4000";
    const fetchFn = (async () => response(200, { "x-ratelimit-remaining": remaining })) as unknown as typeof fetch;
    const get = githubClient("t", { fetchFn, sleep: async (ms) => { sleeps.push(ms); } });
    await get("a");
    await get("b");
    assert.equal(sleeps.length, 1, "the second call waits");
    remaining = "999";
    await assert.rejects(get("c"), StopCollection);
    const slow = githubClient("t", { fetchFn: (async () => response(403, { "retry-after": "60" })) as unknown as typeof fetch, sleep: async () => undefined });
    await assert.rejects(slow("d"), /slow down/);
  });
});

describe("runRedBuildsCommand", () => {
  it("rejects a bad repository or flag with exit 2", async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (line: string) => errors.push(line);
    try {
      assert.equal(await runRedBuildsCommand(["not-a-repo"], {}, { get: fakeGitHub({}) }), 2);
      assert.equal(await runRedBuildsCommand([REPO, "--runs", "0"], {}, { get: fakeGitHub({}) }), 2);
      assert.equal(await runRedBuildsCommand([REPO, "--bogus", "1"], {}, { get: fakeGitHub({}) }), 2);
    } finally {
      console.error = original;
    }
    assert.ok(errors.some((e) => /owner\/name/.test(e)));
  });
});

describe("job naming edge cases from real repositories", () => {
  it("lets a check word beat a weak CI-only word, but not a strong one", () => {
    assert.equal(bucketJob(job(1, "ci / Typecheck + Release Registry")), "check");
    assert.equal(bucketJob(job(1, "ci / Runner support suite")), "check");
    assert.equal(bucketJob(job(1, "ci / e2e shard (8/8)")), "ci-only");
    assert.equal(bucketJob(job(1, "Release")), "ci-only");
    assert.equal(bucketJob(job(1, "Typecheck + Release"), { checkJob: /typecheck/i, ciOnlyJob: /release/i }), "ci-only", "an explicit --ci-only-jobs wins");
  });

  it("ignores an aggregate gate job when another job failed in the same run", () => {
    const runs = [run(1), run(2)];
    const jobs = new Map<number, JobSummary[]>([
      [1, [job(11, "ci / General tests (server (1/12))"), job(12, "ci / verify", ["Check needs"])]],
      [2, [job(21, "ci / verify", ["Check needs"])]],
    ]);
    const annotations = new Map<number, Annotation[]>([[11, [fail("server/x.test.ts", "expected true")]]]);
    const rows = classify({ repository: REPO, runs, jobs, annotations });
    assert.equal(rows.find((r) => r.run === 1)!.verdict, "preventable");
    assert.equal(rows.find((r) => r.run === 2)!.verdict, "ci-only", "a gate failing alone is kept");
  });
});

describe("pickMainWorkflow", () => {
  // Minutes per workflow from real 100-run samples (2026-11-13): plain "most minutes" chose the wrong one.
  function sample(entries: Array<[number, string, string, number]>) {
    return entries.map(([id, name, path, minutes]) => ({
      workflow_id: id, name, path: `.github/workflows/${path}`,
      run_started_at: "2026-11-13T10:00:00Z", updated_at: new Date(Date.parse("2026-11-13T10:00:00Z") + minutes * 60_000).toISOString(),
    }));
  }
  const cases: Array<[string, Array<[number, string, string, number]>, string]> = [
    ["formbricks", [[1, "SonarQube", "sonarqube.yml", 217], [2, "PR Update", "pr.yml", 139], [3, "Integration Tests", "integration-tests.yml", 114], [4, "Docker Build Validation", "docker-build-validation.yml", 82]], "PR Update"],
    ["TanStack/router", [[1, "Benchmarks", "benchmarks.yml", 184], [2, "Compiler Platforms", "compiler-platforms.yml", 114], [3, "PR", "pr.yml", 102], [4, "Bundle Size", "bundle-size.yml", 36]], "PR"],
    ["langfuse", [[1, "AWS preview build", "preview-build.yml", 13], [2, "CI/CD", "pipeline.yml", 10], [3, "CodeQL", "codeql.yml", 9], [4, "Security review", "claude-code-security-review.yml", 4]], "CI/CD"],
    ["medusa", [[1, "Documentation Tests", "docs-test.yml", 205], [2, "Medusa Pipeline", "action.yml", 146], [3, "CLI Pipeline", "test-cli-with-database.yml", 55]], "Medusa Pipeline"],
    ["lobehub", [[1, "Test CI", "test.yml", 156], [2, "E2E CI", "e2e.yml", 123], [3, "Desktop PR Build", "pr-build-desktop.yml", 49]], "Test CI"],
  ];
  for (const [repo, entries, expected] of cases) {
    it(`picks the test CI for ${repo}`, () => {
      assert.equal(pickMainWorkflow(sample(entries))?.name, expected);
    });
  }
});
