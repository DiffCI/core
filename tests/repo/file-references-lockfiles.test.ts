// SPDX-License-Identifier: MIT
/** Reference resolution skips every lockfile from the shared list (issue #97). */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { resolveFileReferences, type ReferenceResolutionInput } from "../../src/repo/file-references.js";
import { LOCKFILE_NAMES } from "../../src/repo/lockfiles.js";
import { workflowFeedsTests } from "../../src/repo/workflow-test-steps.js";

function input(files: Record<string, string>): ReferenceResolutionInput {
  return {
    files: Object.keys(files).sort(),
    read: (path) => files[path],
    isTestFile: (path) => /\.test\.[cm]?[jt]s$/.test(path),
    isDocumentation: (path) => /\.mdx?$/.test(path),
    inGraph: () => false,
    isCodeFile: (path) => /\.[cm]?[jt]sx?$/.test(path),
    workflowFeedsTests: (content, names) => workflowFeedsTests(content, names),
  };
}

describe("lockfiles in reference resolution", () => {
  for (const name of LOCKFILE_NAMES) {
    for (const path of [name, `packages/web/${name}`]) {
      it(`does not treat ${path} as a reader of a file it names`, () => {
        const result = resolveFileReferences("fixtures/data.csv", input({
          "fixtures/data.csv": "a,b",
          [path]: "resolved: fixtures/data.csv",
          "tests/a.test.ts": "x",
        }));
        assert.deepEqual(result.readers, []);
      });
    }
  }

  it("still follows a non-lockfile that names the file", () => {
    const result = resolveFileReferences("fixtures/data.csv", input({
      "fixtures/data.csv": "a,b",
      "notes/lock.txt": "resolved: fixtures/data.csv",
      "tests/a.test.ts": "x",
    }));
    assert.deepEqual(result.readers.map((reader) => reader.path), ["notes/lock.txt"]);
  });
});
