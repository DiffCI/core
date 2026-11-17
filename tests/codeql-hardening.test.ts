// Regression tests for the CodeQL alerts fixed on 2026-11-17: slow regexes on repository-controlled text, and a
// `\s` that a template literal had turned into a literal `s`.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { evaluateCondition, renderCommand } from "../src/ci-inference/expression.js";
import { firstCommandTokens } from "../src/ci-inference/purpose.js";
import { expressionReferences } from "../src/ci-inference/resolve.js";
import { discoverGateChecks } from "../src/planner/pipeline-steps.js";
import { nodeTestGlobForPath } from "../src/planner/test-command.js";
import { contentNamesPath, widenCharacterClasses } from "../src/repo/file-references.js";
import { workflowMayRunTests } from "../src/repo/workflow-test-steps.js";

/** Fails if `run` takes longer than a budget no linear scan of these inputs comes near. */
function fast<T>(run: () => T, budgetMs = 1000): T {
  const started = performance.now();
  const result = run();
  const elapsed = performance.now() - started;
  assert.ok(elapsed < budgetMs, `took ${Math.round(elapsed)} ms`);
  return result;
}

import { referencePattern, referenceTokens } from "../src/repo/file-references.js";
const bare = (path: string) => referencePattern(referenceTokens(path, { ancestors: false }));

describe("CodeQL hardening", () => {
  it("widens glob character classes like the old regex, in linear time", () => {
    const old = (glob: string) => glob.replace(/\[[^\]]*\]/g, "?");
    for (const glob of ["a/[bc]/*.ts", "[a][b]", "x[y", "[[]]", "a]b[c]d[", "no classes", "[", "]["]) {
      assert.equal(widenCharacterClasses(glob), old(glob), glob);
    }
    fast(() => widenCharacterClasses("[".repeat(200_000)));
  });

  it("finds brace expansions like the old regex, in linear time", () => {
    const old = (path: string) => /\{[^}]*(?:,|\.\.)[^}]*\}/.test(path);
    for (const path of ["a/{b,c}.ts", "a{1..3}.ts", "{a}.ts", "{{a,b}", "a,b}", "{a}{b,c}", "{a}b,c}", "{{}}", "plain.ts"]) {
      assert.equal(nodeTestGlobForPath(path) === undefined, old(path), path);
    }
    fast(() => nodeTestGlobForPath("{{".repeat(100_000)));
  });

  it("renders and unwraps GitHub expressions like the old regexes, in linear time", () => {
    const context = { matrix: { node: "22" } };
    assert.equal(renderCommand("node-${{ matrix.node }} ${{ matrix.node}}}", context).rendered, "node-22 22}");
    assert.equal(renderCommand("a } ${{ matrix.node }}", context).rendered, "a } 22");
    assert.equal(renderCommand("${{ x } ${{ matrix.node }}", context).rendered, "${{ x } 22");
    fast(() => renderCommand("${{{{".repeat(50_000), context));
    assert.equal(evaluateCondition("${{ matrix.node == '22' }}", context).expression, "matrix.node == '22'");
    assert.equal(evaluateCondition("  ${{}}  ", context).expression, "");
    // Spaces before something other than the closing `}}`: the old `\s*\}\}$` retried from every space.
    const long = fast(() => evaluateCondition(`\${{ matrix.node == '22'${" ".repeat(100_000)}x }}`, context));
    assert.equal(long.result, "UNRESOLVED", "too long to model is never read as FALSE");
    assert.equal(evaluateCondition("${{ matrix.node != '20'   }}", context).result, "TRUE");
  });

  it("reads a step's first command and its expressions like the old regexes, in linear time", () => {
    assert.deepEqual(firstCommandTokens("  npm ci  &&  npm test | tee log"), ["npm", "ci"]);
    assert.deepEqual(firstCommandTokens("a||b"), ["a"]);
    fast(() => firstCommandTokens(`a${" ".repeat(100_000)}b`));
    const evidence = { file: ".github/workflows/ci.yml", text: "run" };
    const ids = (command: string) => expressionReferences(command, evidence).map((node) => node.identifier);
    assert.deepEqual(ids("node ${{ matrix.node }} ${{secrets.TOKEN}} ${{ }} ${{}}"), ["matrix.node", "secrets.TOKEN", " "]);
    fast(() => ids(`\${{${" ".repeat(100_000)}x`));
  });

  it("reads runner flags without exponential backtracking", () => {
    const flags = " -- -".repeat(30);
    const workflow = `jobs:\n  a:\n    runs-on: x\n    steps:\n      - run: diffci${flags} observe\n      - run: node${flags}x\n`;
    fast(() => workflowMayRunTests(workflow));
    assert.equal(workflowMayRunTests("jobs:\n  a:\n    runs-on: x\n    steps:\n      - run: node --import tsx --test\n"), true);
    fast(() => discoverGateChecks({ check: `tsx${flags}x`, test: `node${flags}x` }));
  });

  it("counts a directory name after whitespace, not after the letter s", () => {
    const target = "scripts/hotfixWorkflow/index.ts";
    const pattern = bare(target);
    assert.equal(contentNamesPath(`log("cwd: scripts"); run('index.ts');`, "packages/ui/src/build.ts", target, pattern, false), true);
    assert.equal(contentNamesPath(`export const entry = 'index.ts'; const sscripts = 1;`, "packages/ui/src/build.ts", target, pattern, false), false);
  });
});
