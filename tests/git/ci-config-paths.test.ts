// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it, test } from "node:test";
import { analyzeCheckout } from "../../src/analyze.js";
import { ciConfigPredicate, gitlabLocalIncludes, isConventionalCiConfigPath } from "../../src/git/ci-config-paths.js";

describe("isConventionalCiConfigPath", () => {
  it("recognises GitHub workflows and GitLab pipeline names", () => {
    for (const path of [".github/workflows/ci.yml", ".gitlab-ci.yml", ".gitlab-ci.yaml", "ci/test.gitlab-ci.yml", ".gitlab/ci/test.yml"]) {
      assert.equal(isConventionalCiConfigPath(path), true, path);
    }
  });

  it("does not claim unrelated files", () => {
    for (const path of ["ci/test.yml", ".gitlab/issue_templates/bug.md", "docs/gitlab-ci.md", "src/gitlab-ci.ts", "config.yml"]) {
      assert.equal(isConventionalCiConfigPath(path), false, path);
    }
  });
});

describe("gitlabLocalIncludes", () => {
  const reader = (files: Record<string, string>) => (path: string) => files[path];

  it("follows local includes in every form, transitively, and ignores external ones", () => {
    const includes = gitlabLocalIncludes(reader({
      ".gitlab-ci.yml": [
        "include:",
        "  - ci/a.yml",
        "  - local: /ci/b.yml",
        "  - remote: https://example.invalid/x.yml",
        "  - https://example.invalid/y.yml",
        "  - project: group/other",
        "    file: /templates/z.yml",
        "  - template: Auto-DevOps.gitlab-ci.yml",
        "  - component: gitlab.com/group/project/c@1.0.0",
      ].join("\n"),
      "ci/b.yml": "include: ci/nested.yml\n",
    }));
    assert.deepEqual([...includes.paths].sort(), ["ci/a.yml", "ci/b.yml", "ci/nested.yml"]);
    assert.equal(includes.unresolved, false);
  });

  it("matches wildcard includes, including files they include in turn", () => {
    const files = { ".gitlab-ci.yml": "include:\n  - local: 'ci/**/*.yml'\n", "ci/jobs/test.yml": "include: { local: shared/base.yml }\n" };
    const includes = gitlabLocalIncludes(reader(files), () => ["ci/jobs/test.yml", "shared/base.yml", "src/a.ts"]);
    const isCi = ciConfigPredicate([includes]);
    assert.equal(isCi("ci/jobs/test.yml"), true);
    assert.equal(isCi("ci/new.yml"), true);
    assert.equal(isCi("shared/base.yml"), true);
    assert.equal(isCi("src/a.ts"), false);
  });

  it("treats every YAML file as pipeline config when an include cannot be followed", () => {
    for (const root of ["include:\n  - local: $CI_DIR/test.yml\n", "include: [\n"]) {
      const isCi = ciConfigPredicate([gitlabLocalIncludes(reader({ ".gitlab-ci.yml": root }))]);
      assert.equal(isCi("anything/jobs.yaml"), true, root);
      assert.equal(isCi("src/a.ts"), false, root);
    }
  });

  it("finds nothing without a root pipeline", () => {
    const includes = gitlabLocalIncludes(reader({}));
    assert.deepEqual([...includes.paths], []);
    assert.equal(includes.unresolved, false);
  });
});

/** A repository with two independent tests. `files` are committed at base; `change` is committed on top. */
function repository(files: Record<string, string>, change: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "diffci-gitlab-ci-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const write = (entries: Record<string, string>) => {
    for (const [path, content] of Object.entries(entries)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
  };
  git("init"); git("config", "user.name", "Core Test"); git("config", "user.email", "test@example.invalid");
  git("config", "commit.gpgsign", "false");
  write({
    "package.json": JSON.stringify({ name: "synthetic", type: "module", scripts: { test: "node --test src/*.test.js" } }),
    "src/value.js": "export const value = 1;\n",
    "src/value.test.js": "import { value } from './value.js';\nif (value < 1) throw new Error('bad');\n",
    ...files,
  });
  git("add", "."); git("commit", "-m", "base"); const base = git("rev-parse", "HEAD");
  write(change);
  git("add", "."); git("commit", "-m", "change");
  return { root, base };
}

const pipeline = "test:\n  script:\n    - npm test\n";
const narrowed = "test:\n  script:\n    - npm test -- src/ci.test.js\n";

// Before 2026-11-05 both of these produced a selective plan.
test("a GitLab pipeline change that a test reads still runs every test", async () => {
  const r = repository({
    ".gitlab-ci.yml": pipeline,
    "src/ci.test.js": "import { readFileSync } from 'node:fs';\nreadFileSync('.gitlab-ci.yml', 'utf8');\n",
  }, { ".gitlab-ci.yml": narrowed });
  try {
    const { plan } = await analyzeCheckout({ repoPath: r.root, base: r.base, head: "HEAD" });
    assert.equal(plan.mode, "FULL");
    assert.deepEqual(plan.skippedTests, []);
    assert.ok(plan.fallbackReasons.some((reason) => reason.startsWith("CI workflow definition(s) changed")));
  } finally { rmSync(r.root, { recursive: true, force: true }); }
});

test("a change to a file the GitLab pipeline includes runs every test, whatever its name", async () => {
  const r = repository({ ".gitlab-ci.yml": "include:\n  - local: ci/test.yml\n", "ci/test.yml": pipeline }, { "ci/test.yml": narrowed });
  try {
    const { plan } = await analyzeCheckout({ repoPath: r.root, base: r.base, head: "HEAD" });
    assert.equal(plan.mode, "FULL");
    assert.deepEqual(plan.skippedTests, []);
  } finally { rmSync(r.root, { recursive: true, force: true }); }
});

test("a file the pipeline stopped including still counts as pipeline config", async () => {
  const r = repository(
    { ".gitlab-ci.yml": "include:\n  - local: ci/test.yml\n", "ci/test.yml": pipeline },
    { ".gitlab-ci.yml": "stages: [test]\n", "ci/test.yml": narrowed },
  );
  try {
    const { plan } = await analyzeCheckout({ repoPath: r.root, base: r.base, head: "HEAD" });
    assert.equal(plan.mode, "FULL");
  } finally { rmSync(r.root, { recursive: true, force: true }); }
});

test("an unrelated YAML file in a GitLab repository is not treated as pipeline config", async () => {
  const r = repository({ ".gitlab-ci.yml": "include:\n  - local: ci/test.yml\n", "ci/test.yml": pipeline, "src/data.yml": "a: 1\n" }, { "src/value.js": "export const value = 2;\n" });
  try {
    const { plan } = await analyzeCheckout({ repoPath: r.root, base: r.base, head: "HEAD" });
    assert.ok(!plan.fallbackReasons.some((reason) => reason.startsWith("CI workflow definition(s) changed")));
    assert.ok(plan.selectedTests.includes("src/value.test.js"));
  } finally { rmSync(r.root, { recursive: true, force: true }); }
});
