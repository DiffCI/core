/**
 * Phase 02 (2026-08-26): the client-side observation, run against a real repository on disk.
 *
 * This is the only test in the suite that exercises what a third-party repository actually installs:
 * a real git repository, a real TypeScript program, the real engine, and the report that would be the
 * only thing leaving that runner. The three properties asserted are the three that the seven-day
 * criterion depends on - it produces a verdict, it refuses instead of guessing, and it leaves the
 * checkout exactly as it found it.
 */
import { strict as assert } from "node:assert";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import { isInsideRepository, observe } from "../../src/client/observe.js";
import { validateObservationReport } from "../../src/client/report.js";

/**
 * `ts.findConfigFile()` walks UPWARD. A fixture repository underneath a directory that has its own
 * tsconfig.json would silently be analysed against that project, and every assertion below would be
 * about the wrong program. Same hazard the Phase 01 probe guards against, same refusal.
 */
function assertNoAncestorTsconfig(dir: string): void {
  let current = dir;
  for (;;) {
    assert.equal(
      existsSync(join(current, "tsconfig.json")),
      false,
      `${current} has a tsconfig.json above the fixture repository; the graph would be built against it`,
    );
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function git(repoPath: string, command: string): string {
  return execSync(`git ${command}`, { cwd: repoPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function write(repoPath: string, relativePath: string, contents: string): void {
  const absolute = join(repoPath, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents, "utf8");
}

/** A minimal but genuine TypeScript repository: two sources, one test that imports one of them. */
function createFixtureRepo(options: { tsconfig?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "diffci-observe-"));
  assertNoAncestorTsconfig(dir);
  git(dir, "init --quiet");
  git(dir, "config user.email test@diffci.local");
  git(dir, "config user.name Test");
  git(dir, "config core.autocrlf false");

  write(dir, "package.json", JSON.stringify({ name: "fixture", version: "1.0.0", devDependencies: { vitest: "^1.0.0" }, scripts: { test: "vitest run" } }, null, 2));
  if (options.tsconfig !== false) {
    write(dir, "tsconfig.json", JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "bundler", strict: true }, include: ["src", "test"] }, null, 2));
  }
  write(dir, "src/alpha.ts", "export const alpha = () => 1;\n");
  write(dir, "src/beta.ts", "export const beta = () => 2;\n");
  write(dir, "test/alpha.test.ts", "import { alpha } from '../src/alpha.js';\nexport const check = () => alpha();\n");
  write(dir, "test/beta.test.ts", "import { beta } from '../src/beta.js';\nexport const check = () => beta();\n");
  git(dir, "add -A");
  git(dir, 'commit --quiet -m "initial"');
  return dir;
}

describe("client-side observation", () => {
  it("selects only the tests that reach the changed file, and proves it changed nothing", async () => {
    const repoPath = createFixtureRepo();
    try {
      const base = git(repoPath, "rev-parse HEAD").trim();
      write(repoPath, "src/alpha.ts", "export const alpha = () => 42;\n");
      git(repoPath, "add -A");
      git(repoPath, 'commit --quiet -m "change alpha"');
      const head = git(repoPath, "rev-parse HEAD").trim();

      const report = await observe({
        repoPath,
        env: {},
        version: "test",
        baseOverride: base,
        headOverride: head,
        reportPath: join(tmpdir(), "diffci-observe-report.json"),
      });

      assert.equal(validateObservationReport(report).ok, true);
      assert.equal(report.status, "OBSERVED", report.reason);
      assert.equal(report.stage, "complete");
      const result = report.result;
      assert.ok(result);
      assert.equal(result.mode, "SELECTIVE", `fallback reasons: ${result.fallbackReasons.join("; ")}`);
      assert.deepEqual(result.selectedTests, ["test/alpha.test.ts"]);
      assert.equal(result.totalTestCount, 2);
      assert.deepEqual(result.changedFiles, ["src/alpha.ts"]);

      // The command has to be one THIS repository could run - the Phase 01 F2 failure was a correct
      // selection paired with a command from a different repository's runner.
      assert.deepEqual(result.proposedCommands, ["npx --no-install vitest run test/alpha.test.ts"]);
      assert.equal(result.commandRefusalReason, undefined);
      assert.deepEqual(result.unroutedTestPaths, []);
      assert.equal(result.blindSpot, false);

      // The comparator is carried on every report, never left to be reconstructed later.
      assert.ok(["SELECTIVE", "FULL"].includes(result.pathBaseline.mode));

      assert.equal(report.nonInterference.worktreeUnchanged, true);
      assert.equal(report.nonInterference.headShaBefore, report.nonInterference.headShaAfter);
      assert.equal(report.nonInterference.reportWrittenOutsideRepository, true);
      assert.equal(git(repoPath, "status --porcelain").trim(), "");
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it("selects unchanged tests outside tsconfig include when their source changes", async () => {
    const repoPath = createFixtureRepo();
    try {
      write(repoPath, "tsconfig.json", JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler" }, include: ["src"] }));
      git(repoPath, "add -A");
      git(repoPath, 'commit --quiet -m "scope typechecking to source"');
      const base = git(repoPath, "rev-parse HEAD").trim();
      write(repoPath, "src/alpha.ts", "export const alpha = () => 42;\n");
      git(repoPath, "add -A");
      git(repoPath, 'commit --quiet -m "change source without touching tests"');
      const report = await observe({ repoPath, env: {}, version: "test", baseOverride: base, headOverride: git(repoPath, "rev-parse HEAD").trim() });
      assert.equal(report.status, "OBSERVED", report.reason);
      assert.equal(report.result?.mode, "SELECTIVE");
      assert.deepEqual(report.result?.selectedTests, ["test/alpha.test.ts"]);
      assert.equal(report.result?.totalTestCount, 2);
      assert.equal(report.nonInterference.worktreeUnchanged, true);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it("redacts every path when asked, and says so in the report", async () => {
    const repoPath = createFixtureRepo();
    try {
      const base = git(repoPath, "rev-parse HEAD").trim();
      write(repoPath, "src/alpha.ts", "export const alpha = () => 42;\n");
      git(repoPath, "add -A");
      git(repoPath, 'commit --quiet -m "change alpha"');
      const head = git(repoPath, "rev-parse HEAD").trim();

      const report = await observe({ repoPath, env: {}, version: "test", baseOverride: base, headOverride: head, redactPaths: true });

      assert.equal(report.payload.includesFilePaths, false);
      assert.equal(report.payload.pathRedaction, "sha256-12");
      for (const path of [...(report.result?.changedFiles ?? []), ...(report.result?.selectedTests ?? [])]) {
        assert.match(path, /^[0-9a-f]{12}$/, `${path} was not redacted`);
      }
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it("refuses a repository with no TypeScript project instead of reporting an empty selection", async () => {
    const repoPath = createFixtureRepo({ tsconfig: false });
    try {
      const base = git(repoPath, "rev-parse HEAD").trim();
      write(repoPath, "src/alpha.ts", "export const alpha = () => 42;\n");
      git(repoPath, "add -A");
      git(repoPath, 'commit --quiet -m "change alpha"');
      const head = git(repoPath, "rev-parse HEAD").trim();

      const report = await observe({ repoPath, env: {}, version: "test", baseOverride: base, headOverride: head });

      assert.equal(report.status, "REFUSED");
      assert.equal(report.stage, "eligibility");
      assert.equal(report.result, undefined);
      assert.match(report.reason ?? "", /TypeScript/);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it("refuses, rather than throws, when the requested range does not exist", async () => {
    const repoPath = createFixtureRepo();
    try {
      const report = await observe({
        repoPath,
        env: {},
        version: "test",
        baseOverride: "f".repeat(40),
        headOverride: "HEAD",
      });
      assert.equal(report.status, "REFUSED");
      assert.equal(report.stage, "context");
      assert.match(report.reason ?? "", /fetch-depth: 0/);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it("knows when a report path would land inside the checkout", () => {
    const repoPath = join(tmpdir(), "repo");
    assert.equal(isInsideRepository(repoPath, join(repoPath, "report.json")), true);
    assert.equal(isInsideRepository(repoPath, join(repoPath, "nested", "report.json")), true);
    assert.equal(isInsideRepository(repoPath, join(tmpdir(), "report.json")), false);
    assert.equal(isInsideRepository(repoPath, repoPath), false);
  });
});
