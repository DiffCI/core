// Property-based fuzzing of the parsers that read repository-controlled text: workflow commands, `${{ }}`
// expressions, `if:` conditions, globs, file references and package scripts. A repository under analysis
// chooses this text, so no input may crash these functions or make them slow (2026-11-17: CodeQL found 25
// slow or unsafe regexes here). Where a function replaced a regex for speed, it must still agree with it.
//
// A failure prints the seed and the shrunk counterexample; rerun with `FC_SEED=<seed>` to reproduce it.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fc from "fast-check";

import { evaluateCondition, renderCommand, resolveExpression } from "../../src/ci-inference/expression.js";
import { firstCommandTokens } from "../../src/ci-inference/purpose.js";
import { expressionReferences } from "../../src/ci-inference/resolve.js";
import { discoverGateChecks, expandsBetweenDoubleQuotes } from "../../src/planner/pipeline-steps.js";
import { nodeTestGlobForPath } from "../../src/planner/test-command.js";
import { contentNamesPath, referencePattern, referenceTokens, widenCharacterClasses } from "../../src/repo/file-references.js";
import { workflowMayRunTests } from "../../src/repo/workflow-test-steps.js";

const seed = process.env.FC_SEED === undefined ? undefined : Number(process.env.FC_SEED);
const runs = (numRuns: number) => ({ numRuns, ...(seed === undefined ? {} : { seed }) });

/** Strings built from the pieces a parser's regexes care about, so generated inputs reach the hard cases. */
const pieces = (...tokens: string[]) => fc.array(fc.constantFrom(...tokens), { maxLength: 40 }).map((parts) => parts.join(""));

/** A long run of one awkward token around arbitrary text: the shape of every slow-regex input found so far. */
const hostile = fc
  .tuple(
    fc.string({ maxLength: 20 }),
    fc.constantFrom(" ", "\t", "-- -", " -x", "${{", "{{", "[", "{", "/", "&&", "||", "=", "\\", "'", '"', "`", "}}"),
    fc.integer({ min: 50_000, max: 150_000 }),
    fc.string({ maxLength: 20 }),
  )
  .map(([before, token, count, after]) => before + token.repeat(count) + after);

/** Any text a repository could hold: arbitrary Unicode, or a long hostile run. */
const anyText = fc.oneof(fc.string({ unit: "grapheme", maxLength: 200 }), hostile);

/** Fails if `call` throws or takes over `budgetMs`. Linear scans of these inputs take a few ms; a quadratic one takes seconds. */
function quickly(call: () => unknown, budgetMs = 1000): boolean {
  const started = performance.now();
  call();
  const elapsed = performance.now() - started;
  if (elapsed > budgetMs) throw new Error(`took ${Math.round(elapsed)} ms`);
  return true;
}

const context = { matrix: { node: "22", os: "ubuntu" } };

describe("fuzz: repository text never crashes or hangs a parser", () => {
  it("workflow commands, expressions and conditions", () => {
    fc.assert(fc.property(anyText, (text) => quickly(() => {
      renderCommand(text, context);
      evaluateCondition(text, context);
      expressionReferences(text, { file: ".github/workflows/ci.yml", text: "run" });
      firstCommandTokens(text);
    })), runs(150));
  });

  it("workflow files and package scripts", () => {
    // Hostile text inside a well-formed workflow: DiffCI's own step and script readers. A whole malformed
    // document is left out on purpose: the `yaml` parser itself (2.9.1) is superlinear on a long run of `"`
    // (1.7 s at 80,000), which is the library's behaviour, not DiffCI's (found by this test, 2026-11-17).
    fc.assert(fc.property(anyText, (text) => quickly(() => {
      workflowMayRunTests(`jobs:\n  a:\n    runs-on: x\n    steps:\n      - run: ${JSON.stringify(text)}\n`);
      discoverGateChecks({ test: text, check: `tsc && ${text}`, lint: `node ${text} --test` });
    })), runs(100));
  });

  it("paths, globs and file references", () => {
    const target = "scripts/hotfixWorkflow/index.ts";
    const pattern = referencePattern(referenceTokens(target, { ancestors: false }));
    fc.assert(fc.property(anyText, (text) => quickly(() => {
      nodeTestGlobForPath(text);
      widenCharacterClasses(text);
      contentNamesPath(text, "packages/ui/src/build.ts", target, pattern, false);
      contentNamesPath(text, ".github/workflows/ci.yml", target, pattern, true);
    })), runs(100));
  });
});

describe("fuzz: linear rewrites agree with the regexes they replaced", () => {
  it("glob character classes", () => {
    fc.assert(fc.property(pieces("[", "]", "a", "/", "*", "!"), (glob) => {
      assert.equal(widenCharacterClasses(glob), glob.replace(/\[[^\]]*\]/g, "?"));
    }), runs(1000));
  });

  it("brace expansion", () => {
    fc.assert(fc.property(pieces("{", "}", ",", ".", "a", "/"), (path) => {
      assert.equal(nodeTestGlobForPath(path) === undefined, /\{[^}]*(?:,|\.\.)[^}]*\}/.test(path));
    }), runs(1000));
  });

  it("`${{ }}` substitution", () => {
    fc.assert(fc.property(pieces("$", "{", "}", " ", "matrix.node", "matrix.os", "x", "${{", "}}"), (line) => {
      const old = line.replace(/\$\{\{([^}]*)\}\}/g, (_match, body: string) => resolveExpression(body, context).value);
      assert.equal(renderCommand(line, context).rendered, old);
    }), runs(1000));
  });

  it("`${{ }}` references", () => {
    fc.assert(fc.property(pieces("$", "{", "}", " ", "\t", "matrix.node", "secrets.T", "x", "${{", "}}"), (command) => {
      const old = [...command.matchAll(/\$\{\{\s*([^}]+?)\s*\}\}/g)].map((match) => match[1]);
      const ids = expressionReferences(command, { file: "ci.yml", text: "run" }).map((node) => node.identifier);
      assert.deepEqual(ids, old);
    }), runs(1000));
  });

  it("`if:` unwrapping", () => {
    fc.assert(fc.property(pieces("$", "{", "}", " ", "${{", "}}", "a", "==", "'b'"), (expression) => {
      const old = expression.trim().replace(/^\$\{\{\s*|\s*\}\}$/g, "").trim();
      assert.equal(evaluateCondition(expression, context).expression, old);
    }), runs(1000));
  });

  it("double-quoted expansion in a script part (#300)", () => {
    fc.assert(fc.property(pieces("\"", "$", "`", "a", " ", "'"), (part) => {
      assert.equal(expandsBetweenDoubleQuotes(part), /"[^"]*[$`][^"]*"/.test(part));
    }), runs(1000));
  });

  it("first command of a step", () => {
    fc.assert(fc.property(pieces(" ", "\t", "|", "&", ";", "a", "b"), (line) => {
      const [first = ""] = line.trim().split(/\s*(?:\|\||&&|\||;)\s*/);
      assert.deepEqual(firstCommandTokens(line), first.split(/\s+/).filter(Boolean));
    }), runs(1000));
  });
});
