// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Phase 01 follow-up (2026-08-26): what a directory MEANS must come from the repository, and Next.js
 * conventions must only apply to Next.js applications.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { repositoryLayout, UNKNOWN_REPOSITORY_LAYOUT } from "../../src/repo/layout.js";
import type { RepositoryProfile, SourceRoot } from "../../src/repo/types.js";

function profileWith(options: {
  roots?: Array<{ path: string; kind: SourceRoot["kind"] }>;
  dependencies?: string[];
  devDependencies?: string[];
  nextConfig?: boolean;
}): RepositoryProfile {
  return {
    packageManager: "npm",
    packageJson: {
      name: "fixture",
      scripts: {},
      dependencies: options.dependencies ?? [],
      devDependencies: options.devDependencies ?? [],
    },
    nextConfig: options.nextConfig ? { exists: true, file: "next.config.ts" } : { exists: false },
    sourceRoots: options.roots ?? [],
    tests: [],
    testFilePaths: [],
    workflows: [],
    configFiles: [],
    pathAliases: [],
    entryPoints: [],
    stats: { sourceFiles: 0, testFiles: 0, workflowFiles: 0, configFiles: 0 },
  };
}

describe("repositoryLayout", () => {
  it("takes script roots from what the repository actually has", () => {
    const layout = repositoryLayout(
      profileWith({ roots: [{ path: "src", kind: "source" }, { path: "tools", kind: "scripts" }] }),
    );

    assert.deepEqual(layout.scriptRoots, ["tools"]);
    assert.equal(layout.isScriptPath("tools/release.ts"), true);
    assert.equal(layout.isScriptPath("src/index.ts"), false);
    // The two names the engine used to hardcode are not special. This repository has neither.
    assert.equal(layout.isScriptPath("scripts/build.ts"), false);
    assert.equal(layout.isScriptPath("ops/deploy.ts"), false);
  });

  it("has no script roots when the repository has none", () => {
    const layout = repositoryLayout(profileWith({ roots: [{ path: "src", kind: "source" }] }));
    assert.deepEqual(layout.scriptRoots, []);
    assert.equal(layout.isScriptPath("scripts/anything.ts"), false);
  });

  it("counts operations roots as auxiliary code too", () => {
    const layout = repositoryLayout(profileWith({ roots: [{ path: "ops", kind: "operations" }] }));
    assert.equal(layout.isScriptPath("ops/deploy.ts"), true);
  });

  it("treats Markdown as documentation anywhere, and conventional doc directories by name", () => {
    const layout = repositoryLayout(profileWith({}));
    assert.equal(layout.isDocumentationPath("anywhere/deep/NOTES.md"), true);
    assert.equal(layout.isDocumentationPath("docs/guide.html"), true);
    assert.equal(layout.isDocumentationPath("documentation/api.html"), true);
    assert.equal(layout.isDocumentationPath("src/index.ts"), false);
  });

  it("is a Next.js app only when the repository says so", () => {
    // Before this, any repository with a file named route.ts or error.ts got Next.js semantics.
    // Measured across the Phase 01 cohort that mislabelled files in five of nine repositories -
    // unjs/h3 alone has seven, where route and error are HTTP concepts.
    assert.equal(repositoryLayout(profileWith({})).isNextApp, false);
    assert.equal(repositoryLayout(profileWith({ nextConfig: true })).isNextApp, true);
    assert.equal(repositoryLayout(profileWith({ dependencies: ["next"] })).isNextApp, true);
    assert.equal(repositoryLayout(profileWith({ devDependencies: ["next"] })).isNextApp, true);
    assert.equal(repositoryLayout(profileWith({ dependencies: ["nextra"] })).isNextApp, false);
  });

  it("normalises separators and trailing slashes rather than failing to match on them", () => {
    const layout = repositoryLayout(profileWith({ roots: [{ path: "scripts/", kind: "scripts" }] }));
    assert.equal(layout.isScriptPath("scripts\\build.ts"), true);
    assert.equal(layout.isScriptPath("scripts/build.ts"), true);
  });

  it("knows nothing when there is no profile to derive from", () => {
    assert.equal(UNKNOWN_REPOSITORY_LAYOUT.isNextApp, false);
    assert.equal(UNKNOWN_REPOSITORY_LAYOUT.isScriptPath("scripts/x.ts"), false);
    assert.equal(UNKNOWN_REPOSITORY_LAYOUT.isDocumentationPath("README.md"), true);
  });
});
