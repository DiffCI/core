import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  agentMarker,
  branchAgent,
  bucketJob,
  NO_AGENT_BRANCH,
  summarise,
  DEFAULT_PATTERNS,
  isAggregateJob,
  classify,
  collectRedBuilds,
  formatReport,
  pickMainWorkflow,
  githubClient,
  nothingRan,
  runRedBuildsCommand,
  signatures,
  StopCollection,
  suggestWorkflows,
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

  it("judges a failed job by its name when GitHub dropped its step data", () => {
    // github/gh-aw runs seven months old came back with "steps": [] (2026-11-16).
    const noSteps = (name: string, conclusion = "failure"): JobSummary => ({ ...job(1, name, [], conclusion), stepsKnown: false });
    assert.equal(bucketJob(noSteps("test")), "check");
    assert.equal(bucketJob(noSteps("policy")), "ci-only", "unknown names stay CI-only");
    assert.equal(bucketJob(noSteps("Playwright (chromium)")), "ci-only");
    assert.equal(bucketJob(noSteps("test", "cancelled")), "infra");
    assert.equal(bucketJob(noSteps("test", "timed_out")), "infra");
    assert.equal(bucketJob(job(1, "test", [])), "infra", "with step data, no failed step still means cancelled or timed out");
  });

  it("treats PR Gate and CI Gate as gate jobs, not CI-only failures", () => {
    for (const name of ["PR Gate", "CI Gate", "CI / CI-Gate", "merge gate"]) assert.ok(isAggregateJob(job(1, name)), name);
    assert.ok(!isAggregateJob(job(1, "Gatekeeper tests")));
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

  it("leaves out red runs where no job started", () => {
    const skipped: JobSummary = { ...job(2, "lint", [], "skipped"), startedAt: "2026-11-10T10:00:00Z" };
    const jobs = new Map([[1, [] as JobSummary[]], [2, [skipped]]]);
    assert.ok(nothingRan([]) && nothingRan([skipped]));
    assert.deepEqual(classify({ repository: REPO, runs: [run(1), run(2)], jobs, annotations: new Map() }), []);
  });
});

describe("agentMarker", () => {
  it("spots agent co-author trailers and agent branch prefixes", () => {
    assert.deepEqual(agentMarker("fix\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>", "main"), { written: true, marker: "claude", source: "trailer" });
    assert.deepEqual(agentMarker("feat\n\n🤖 Generated with [Claude Code](https://claude.com)", "x"), { written: true, marker: "claude code", source: "trailer" });
    assert.deepEqual(agentMarker("fix", "codex/fix-thing"), { written: true, marker: "codex", source: "branch" });
    assert.deepEqual(agentMarker("fix", "Copilot/fix-12"), { written: true, marker: "copilot", source: "branch" });
    assert.deepEqual(agentMarker("fix\n\nCo-authored-by: Jane <jane@example.com>", "jane/fix"), { written: false, marker: "", source: "" });
  });

  it("names the agent from the branch prefix alone", () => {
    assert.equal(branchAgent("copilot/fix-123"), "copilot");
    assert.equal(branchAgent("claude-refactor"), "claude");
    assert.equal(branchAgent("feature/copilot-docs"), null, "only a prefix counts");
    assert.equal(branchAgent("copilotx/thing"), null);
  });
});

describe("pull request counts", () => {
  it("counts pull requests and authors, and warns when one branch's pushes dominate", () => {
    // One maintainer pushes the same red branch four times; two other people each have one red run.
    const wip = { headBranch: "release-2", actor: "maintainer" };
    const runs = [run(1, wip), run(2, wip), run(3, wip), run(4, wip), run(5, { actor: "a" }), run(6, { actor: "b" })];
    const jobs = new Map<number, JobSummary[]>(runs.map((r) => [r.id, [job(r.id * 10, "lint")]]));
    const annotations = new Map<number, Annotation[]>(runs.map((r) => [r.id * 10, [fail(`src/${r.id > 4 ? ["", "", "", "", "", "alpha", "beta"][r.id] : "release"}.ts`, "unused variable")]]));
    const rows = classify({ repository: REPO, runs, jobs, annotations });
    assert.deepEqual(rows.map((r) => r.verdict), Array(6).fill("preventable"), "a failure repeated on its own branch is still that PR's own");
    const report = summarise(REPO, runs, rows, null);
    assert.equal(report.verdicts.preventable.runs, 6);
    assert.equal(report.verdicts.preventable.pullRequests, 3);
    assert.equal(report.redPullRequests, 3);
    assert.equal(report.largestPreventablePullRequest, 4);
    assert.equal(report.preventableAuthors, 3);
    assert.doesNotMatch(JSON.stringify(report.rows), /maintainer/, "authors are counted, never written");
    const text = formatReport(report);
    assert.match(text, /Preventable before the push\s+6\s+3/);
    assert.match(text, /By pull request: 3 of 3 red pull requests \(100%\), from 3 authors/);
    assert.match(text, /One pull request accounts for 4 of the 6 preventable runs/);
  });

  it("does not warn when the preventable runs are spread out", () => {
    const runs = [run(1, { actor: "a" }), run(2, { actor: "b" }), run(3, { actor: "a" })];
    const jobs = new Map<number, JobSummary[]>(runs.map((r) => [r.id, [job(r.id * 10, "lint")]]));
    const annotations = new Map<number, Annotation[]>(runs.map((r) => [r.id * 10, [fail(`src/${["", "alpha", "beta", "gamma"][r.id]}.ts`, "unused variable")]]));
    const report = summarise(REPO, runs, classify({ repository: REPO, runs, jobs, annotations }), null);
    assert.equal(report.preventableAuthors, 2);
    assert.doesNotMatch(formatReport(report), /One pull request accounts/);
  });
});

describe("preventable authors", () => {
  const lintRed = (runs: RunSummary[]) => {
    const jobs = new Map<number, JobSummary[]>(runs.map((r) => [r.id, [job(r.id * 10, "lint")]]));
    const annotations = new Map<number, Annotation[]>(runs.map((r) => [r.id * 10, [fail(`src/${"abcdefgh"[r.id]}file.ts`, "unused variable")]]));
    return summarise(REPO, runs, classify({ repository: REPO, runs, jobs, annotations }), null);
  };

  it("does not count a bot that pushed to someone's fork PR as a second author (dify, 2026-11-23)", () => {
    // autofix-ci pushed a fix commit to one fork PR; the same person has two more fork PRs.
    const runs = [
      run(1, { headRepo: "mika/app", headBranch: "fix-a", actor: "autofix-ci[bot]" }),
      run(2, { headRepo: "mika/app", headBranch: "fix-a", actor: "mika" }),
      run(3, { headRepo: "mind/app", headBranch: "t-1", actor: "mind" }),
      run(4, { headRepo: "mind/app", headBranch: "t-2", actor: "mind" }),
      run(5, { headRepo: "mes/app", headBranch: "scan", actor: "mes" }),
    ];
    const report = lintRed(runs);
    assert.equal(report.verdicts.preventable.pullRequests, 4);
    assert.equal(report.preventableAuthors, 3);
  });

  it("credits a fork PR to the fork owner even when a maintainer triggered the run", () => {
    assert.equal(lintRed([run(1, { headRepo: "alice/app", actor: "maintainer" }), run(2, { headRepo: "alice/app", headBranch: "x", actor: "alice" })]).preventableAuthors, 1);
  });

  it("falls back to the pull request itself when only a bot ran a same-repository branch", () => {
    assert.equal(lintRed([run(1, { actor: "renovate[bot]" }), run(2, { actor: "dependabot[bot]" })]).preventableAuthors, 2);
  });
});

describe("byBranchAgent", () => {
  it("splits runs, red runs and verdicts by the agent the branch is named after", () => {
    const runs = [
      run(1, { headBranch: "copilot/fix-1" }), // own lint failure -> preventable
      run(2, { headBranch: "copilot/fix-2", conclusion: "success" }),
      run(3, { headBranch: "copilot/fix-3" }), // failed before any job started
      run(4, { headBranch: "feature-4" }), // CI-only
      run(5, { headBranch: "feature-5", conclusion: "success" }),
      run(6, { headBranch: "copilot/fix-6", conclusion: "action_required" }), // waiting for approval: never ran
      run(7, { headBranch: "copilot/fix-7", conclusion: null }), // still running
    ];
    const jobs = new Map<number, JobSummary[]>([
      [1, [job(11, "lint")]],
      [3, []],
      [4, [job(41, "playwright")]],
    ]);
    const annotations = new Map<number, Annotation[]>([[11, [fail("src/x.ts", "'y' is defined but never used")]]]);
    const rows = classify({ repository: REPO, runs, jobs, annotations });
    assert.deepEqual(rows.map((r) => [r.run, r.branchAgent]), [[1, "copilot"], [4, null]]);
    assert.doesNotMatch(JSON.stringify(rows), /fix-1|feature-4/, "rows carry the agent, never the branch name");
    const report = summarise(REPO, runs, rows, null, new Set([3]));
    assert.equal(report.schemaVersion, 3);
    assert.equal(report.neverStarted, 1);
    assert.equal(report.redRuns, 2);
    const copilot = report.byBranchAgent.copilot!;
    assert.deepEqual([copilot.pullRequestRuns, copilot.ranRuns, copilot.redRuns, copilot.analysed, copilot.verdicts.preventable], [5, 2, 1, 1, 1]);
    assert.equal(copilot.preventableRunnerMinutes, 10);
    const other = report.byBranchAgent[NO_AGENT_BRANCH]!;
    assert.deepEqual([other.pullRequestRuns, other.ranRuns, other.redRuns, other.analysed, other.verdicts["ci-only"]], [2, 2, 1, 1, 1]);
    assert.equal(report.ranRuns, 4, "7 runs, less one waiting, one running and one that never started");
    const text = formatReport(report);
    assert.match(text, /By branch prefix/);
    assert.match(text, /copilot\/\.\.\.\s+5\s+2\s+1 \(50%\)\s+1 of 1/);
    assert.match(text, /other branches\s+2\s+2\s+1 \(50%\)\s+0 of 1/);
    assert.match(text, /share of the runs that ran/);
  });

  it("leaves the table out when no branch names an agent", () => {
    const runs = [run(1), run(2, { conclusion: "success" })];
    const rows = classify({ repository: REPO, runs, jobs: new Map([[1, [job(11, "lint")]]]), annotations: new Map() });
    const report = summarise(REPO, runs, rows, null);
    assert.deepEqual(Object.keys(report.byBranchAgent), [NO_AGENT_BRANCH]);
    assert.doesNotMatch(formatReport(report), /By branch prefix/);
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
    assert.deepEqual(report.rows[0]!.agent, { written: true, marker: "claude", source: "trailer", commitRead: true });
    assert.equal(report.rows[0]!.branchAgent, "claude");
    assert.deepEqual(Object.keys(report.byBranchAgent).sort(), ["claude", NO_AGENT_BRANCH]);
    assert.equal(report.rows[0]!.fork, false);
    assert.equal(calls.length, 5, "workflow sample, its runs, one job list, one annotation list, one commit");
    assert.equal(report.workflow, "CI");
    const text = formatReport(report);
    assert.match(text, /2 pull request runs, 1 red \(50%\)/);
    assert.match(text, /Up to 1 of 1 red runs \(100%\)/);
    assert.match(text, /written by a coding agent\s+1/);
    assert.match(text, /upper bound/);
  });

  it("counts runs that failed before any job started apart from red runs", async () => {
    const startup = { ...runsPage.workflow_runs[0], id: 3, run_attempt: 1, head_sha: "c".repeat(40), head_repository: { full_name: "fork/app" } };
    const page = { workflow_runs: [...runsPage.workflow_runs, startup] };
    const report = await collectRedBuilds({ repository: REPO, maxRuns: 200, get: fakeGitHub({
      ...routes, [`repos/${REPO}/actions/runs?`]: page, [`repos/${REPO}/actions/workflows/9/runs?`]: page,
      [`repos/${REPO}/actions/runs/3/attempts/1/jobs`]: { jobs: [] },
    }, []) });
    assert.equal(report.redRuns, 1);
    assert.equal(report.neverStarted, 1);
    assert.equal(report.unreadable, 0);
    assert.equal(report.verdicts.infra.runs, 0);
    const text = formatReport(report);
    assert.match(text, /3 pull request runs, 1 red \(50% of the 2 that ran\)/);
    assert.equal(report.ranRuns, 2);
    assert.match(text, /1 more runs were marked failed although no job started/);
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

  it("keeps the runs read before the network went down", async () => {
    const github = fakeGitHub(routes);
    let calls = 0;
    const get: GitHubGet = async (path) => {
      if (++calls > 2) throw new StopCollection("fetch failed on check-runs, 5 times");
      return github(path);
    };
    const report = await collectRedBuilds({ repository: REPO, get, maxRuns: 10, workflow: "9" });
    assert.match(report.stoppedEarly ?? "", /fetch failed/);
    assert.equal(report.pullRequestRuns, 2);
    assert.equal(report.redRuns, 1);
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

  it("retries a dropped connection or a 5xx, then stops so the partial report survives", async () => {
    const sleeps: number[] = [];
    const outcomes: Array<number | "drop"> = ["drop", 502, 200];
    const flaky = githubClient("t", {
      fetchFn: (async () => {
        const next = outcomes.shift();
        if (next === "drop") throw new TypeError("fetch failed");
        return response(next ?? 200, { "x-ratelimit-remaining": "4000" });
      }) as unknown as typeof fetch,
      sleep: async (ms) => { sleeps.push(ms); },
    });
    assert.equal((await flaky("a")).status, 200);
    assert.deepEqual(sleeps, [10_000, 30_000]);
    let calls = 0;
    const down = githubClient("t", { fetchFn: (async () => { calls++; throw new TypeError("fetch failed"); }) as unknown as typeof fetch, sleep: async () => undefined });
    await assert.rejects(down("repos/o/r/jobs?page=2"), (error: unknown) => error instanceof StopCollection && /fetch failed on repos\/o\/r\/jobs, 5 times/.test((error as Error).message));
    assert.equal(calls, 5);
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

describe("gate jobs and matrix-named jobs (continue, gutenberg)", () => {
  it("treats status-check and require-all-checks gates as aggregate jobs", () => {
    assert.ok(isAggregateJob(job(1, "Unit Tests - Status Check")));
    assert.ok(isAggregateJob(job(1, "require-all-checks-to-pass")));
    assert.ok(!isAggregateJob(job(1, "Status checker unit tests")));
  });

  it("lets a unit-test or lint workflow name a job named only by its matrix", () => {
    assert.equal(bucketJob(job(1, "JavaScript (Node.js 24) 1/4"), DEFAULT_PATTERNS, "Unit Tests"), "check");
    assert.equal(bucketJob(job(1, "JavaScript (Node.js 24) 1/4"), DEFAULT_PATTERNS, "CI"), "ci-only", "a generic workflow name says nothing");
    assert.equal(bucketJob(job(1, "JavaScript (Node.js 24) 1/4"), DEFAULT_PATTERNS, "E2E unit tests"), "ci-only");
    assert.equal(bucketJob(job(1, "release notes"), DEFAULT_PATTERNS, "Lint"), "ci-only", "a CI-side job name still wins");
  });
});

describe("a check job failing on most pull requests (continue)", () => {
  it("counts an unannotated check failing on half the PRs or more as shared, not likely", () => {
    const runs = Array.from({ length: 8 }, (_, i) => run(i + 1, { conclusion: i < 6 ? "failure" : "success" }));
    const jobs = new Map(runs.filter((r) => r.conclusion === "failure").map((r) => [r.id, [job(r.id * 10, "jetbrains-tests")]]));
    const rows = classify({ repository: REPO, runs, jobs, annotations: new Map() });
    assert.deepEqual([...new Set(rows.map((r) => r.verdict))], ["shared"]);
    const few = classify({ repository: REPO, runs: runs.slice(0, 2), jobs, annotations: new Map() });
    assert.deepEqual([...new Set(few.map((r) => r.verdict))], ["likely"], "two PRs are too few to call it broken for everyone");
  });
});

describe("pickMainWorkflow", () => {
  // Minutes per workflow from real 100-run samples (2026-11-13): plain "most minutes" chose the wrong one.
  function sample(entries: Array<[number, string, string, number]>, conclusion = "success") {
    return entries.map(([id, name, path, minutes]) => ({
      workflow_id: id, name, path: `.github/workflows/${path}`, conclusion,
      run_started_at: "2026-11-13T10:00:00Z", updated_at: new Date(Date.parse("2026-11-13T10:00:00Z") + minutes * 60_000).toISOString(),
    }));
  }
  const cases: Array<[string, Array<[number, string, string, number]>, string]> = [
    ["formbricks", [[1, "SonarQube", "sonarqube.yml", 217], [2, "PR Update", "pr.yml", 139], [3, "Integration Tests", "integration-tests.yml", 114], [4, "Docker Build Validation", "docker-build-validation.yml", 82]], "PR Update"],
    ["TanStack/router", [[1, "Benchmarks", "benchmarks.yml", 184], [2, "Compiler Platforms", "compiler-platforms.yml", 114], [3, "PR", "pr.yml", 102], [4, "Bundle Size", "bundle-size.yml", 36]], "PR"],
    ["langfuse", [[1, "AWS preview build", "preview-build.yml", 13], [2, "CI/CD", "pipeline.yml", 10], [3, "CodeQL", "codeql.yml", 9], [4, "Security review", "claude-code-security-review.yml", 4]], "CI/CD"],
    ["medusa", [[1, "Documentation Tests", "docs-test.yml", 205], [2, "Medusa Pipeline", "action.yml", 146], [3, "CLI Pipeline", "test-cli-with-database.yml", 55]], "Medusa Pipeline"],
    ["lobehub", [[1, "Test CI", "test.yml", 156], [2, "E2E CI", "e2e.yml", 123], [3, "Desktop PR Build", "pr-build-desktop.yml", 49]], "Test CI"],
    // Misses from the 37-repository sweep (samples of 2026-11-15).
    ["continue", [[1, "CLI PR Checks", "cli-pr-checks.yml", 386], [2, "PR Build And Upload VSIX", "pr-build-upload-vsix.yaml", 301], [3, "PR Checks", "pr-checks.yaml", 301]], "PR Checks"],
    ["OneKey", [[1, "02-unittest", "unittest.yml", 119], [2, "01-lint", "lint.yml", 118], [3, "Startup Graph Budget Check", "startup-graph-budget.yml", 103], [4, "Codacy Security Scan", "codacy.yml", 56]], "02-unittest"],
    ["gutenberg", [[1, "End-to-End Tests", "end2end-test.yml", 167], [2, "Performance Tests", "performance.yml", 153], [3, "Storybook Build and Smoke Tests", "storybook-check.yml", 131], [4, "Static Analysis (Linting, License, Type checks...)", "static-checks.yml", 125], [5, "iOS Tests", "ios-tests.yml", 119], [6, "Unit Tests", "unit-test.yml", 71]], "Unit Tests"],
    ["supabase", [[1, "Selfhosted Studio E2E Tests", "studio-e2e-test.yml", 16], [2, "Studio Unit Tests & Build Check", "studio-unit-tests.yml", 10], [3, "Check code with TypeScript & Lint", "typecheck.yml", 6], [4, "Check Code with Prettier", "prettier.yml", 5]], "Studio Unit Tests & Build Check"],
    ["PostHog", [[1, "Semgrep Package Managers", "semgrep-package-managers.yml", 4], [2, "PR housekeeping", "pr-housekeeping.yml", 3], [3, "Proto CI", "ci-proto.yml", 2]], "Proto CI"],
    // Wrong picks in the Copilot sweep (2026-11-16): gh-aw agent workflows (.lock.yml) and link checkers.
    ["gh-aw", [[1, "PR Code Quality Reviewer", "pr-code-quality-reviewer.lock.yml", 900], [2, "CI", "ci.yml", 300]], "CI"],
    ["dotnet/sdk", [[1, "CI Quality Investigator", "ci-quality-monitor.lock.yml", 700], [2, "PR Build", "pr-build.yml", 100]], "PR Build"],
    ["azure-sdk-for-net", [[1, "Re-review PR #63968 at f464603d", "pr-re-review.lock.yml", 500], [2, "Build", "build.yml", 60]], "Build"],
    ["azure-sdk-for-js", [[1, "Verify Links", "verify-links.yml", 40], [2, "Unit tests", "unit-tests.yml", 30]], "Unit tests"],
    ["aspnetcore", [[1, "Workflow tests", "workflow-tests.yml", 20], [2, "Build and test", "ci.yml", 15]], "Build and test"],
  ];
  for (const [repo, entries, expected] of cases) {
    it(`picks the test CI for ${repo}`, () => {
      assert.equal(pickMainWorkflow(sample(entries))?.name, expected);
    });
  }

  it("ignores time runs spent waiting for approval, and caps a run at 6 hours", () => {
    const waiting = sample([[1, "CI", "ci.yml", 5000]], "action_required");
    const real = sample([[2, "Tests", "tests.yml", 10]]);
    assert.equal(pickMainWorkflow([...waiting, ...real])?.name, "Tests");
    const stuck = sample([[3, "Build", "build.yml", 100_000]]);
    const tests = sample([[4, "Test CI", "test.yml", 300], [4, "Test CI", "test.yml", 300]]);
    assert.equal(pickMainWorkflow([...stuck, ...tests])?.name, "Test CI");
  });

  it("is not confident when only cleanups, scanners or bots ran (cal.com)", () => {
    const picked = pickMainWorkflow(sample([[1, "cleanup caches by a branch", "cache-clean.yml", 9], [2, ".github/workflows/cleanup-report.yml", "cleanup-report.yml", 9]]));
    assert.equal(picked?.confident, false);
  });

  it("suggests likely main workflows from the workflow list", () => {
    const wf = (name: string, file: string, state = "active") => ({ name, path: `.github/workflows/${file}`, state });
    const suggestions = suggestWorkflows([wf("cleanup caches by a branch", "cache-clean.yml"), wf("Unit", "unit-tests.yml"), wf("E2E", "e2e.yml"),
      wf("Lint", "lint.yml"), wf("Old CI", "old-ci.yml", "disabled_manually"), wf("Copilot", "dynamic/copilot")]);
    assert.deepEqual(suggestions, ['unit-tests.yml ("Unit")', 'lint.yml ("Lint")']);
  });

  it("refuses to guess and names candidates when no sampled workflow looks like CI", async () => {
    const at = (m: number) => new Date(Date.parse("2026-11-13T10:00:00Z") + m * 60_000).toISOString();
    const get = fakeGitHub({
      [`repos/${REPO}/actions/runs?`]: { workflow_runs: [{ workflow_id: 1, name: "Cleanup", path: ".github/workflows/cleanup.yml", conclusion: "success", run_started_at: at(0), updated_at: at(5) }] },
      [`repos/${REPO}/actions/workflows?`]: { workflows: [{ name: "Tests", path: ".github/workflows/tests.yml", state: "active" }] },
    });
    await assert.rejects(collectRedBuilds({ repository: REPO, get, maxRuns: 200 }), /looks like the main CI.*--workflow <file>; likely candidates: tests\.yml \("Tests"\)/);
  });
});
