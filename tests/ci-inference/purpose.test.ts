// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The two false TEST classifications from CI_REPRODUCTION_SAMPLE_01, as regression tests, plus the
 * true positives that must survive the fix.
 *
 * Both false positives came from `/\b(jest|vitest|mocha|ava)\b/` applied to a whole command line. They
 * are the reason purpose is now derived from the executable position and from script bodies the
 * repository declares — never from a substring.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { establishesPurpose, firstCommandTokens, normalizeExecutable, packageManagerCommand, purposeOfLine } from "../../src/ci-inference/purpose.js";

/** `packageManagerCommand` takes normalised tokens, never a raw line — this is the one call site every
 *  test below shares, so a line's assignments and its package-manager semantics are always asked about
 *  through the same pipeline the source code itself uses. */
const pmc = (line: string) => packageManagerCommand(normalizeExecutable(line).tokens);

const NO_SCRIPTS = () => undefined;

test("jest's issue-closing command is NOT a test operation", () => {
  const line = `gh issue close $ISSUE --comment "As noted in the [Bug Report template](https://github.com/jestjs/jest/blob/main/.github/ISSUE_TEMPLATE/bug.yml), all bug reports requires a minimal reproduction."`;
  const verdict = purposeOfLine(line, NO_SCRIPTS);
  assert.notEqual(verdict.purpose, "test", "a URL containing `jest` must not make this a TEST operation");
  assert.equal(verdict.basis, "NONE");
  assert.equal(establishesPurpose(verdict), false, "and it must not license a plan");
});

test("webpack's patch-applying command is NOT a test operation", () => {
  for (const line of ["git apply test/patches/jest-worker+30.4.1.patch", "git apply test/patches/jest-runner+30.4.2.patch"]) {
    const verdict = purposeOfLine(line, NO_SCRIPTS);
    assert.notEqual(verdict.purpose, "test", `a patch filename must not make \`${line}\` a TEST operation`);
    assert.equal(establishesPurpose(verdict), false);
  }
});

test("a test runner in EXECUTABLE position is a test operation", () => {
  for (const line of ["jest --ci", "vitest run", "mocha spec/", "node ./node_modules/.bin/jest --ci", "npx vitest"]) {
    const verdict = purposeOfLine(line, NO_SCRIPTS);
    assert.equal(verdict.purpose, "test", line);
    assert.equal(verdict.basis, "EXECUTABLE_POSITION", line);
  }
});

test("a script resolves through its BODY, which is how webpack's integration suite becomes visible", () => {
  // webpack declares `cover:integration:a`; its name says nothing, its body runs jest.
  const scripts: Record<string, string> = { "cover:integration:a": "nyc --reporter=json jest --ci --testPathPattern=integration" };
  const verdict = purposeOfLine("yarn cover:integration:a --ci --cacheDirectory .jest-cache", (n) => scripts[n]);

  assert.equal(verdict.purpose, "test");
  assert.equal(verdict.basis, "SCRIPT_BODY");
  assert.match(verdict.evidence, /cover:integration:a/);
});

test("a COMPOUND line still yields its purpose — argv failure must not erase semantics", () => {
  // The exact shape that cost webpack its TEST purpose across all 31 job instances.
  const scripts: Record<string, string> = { "cover:integration:a": "jest --ci" };
  const line = "yarn cover:integration:a --ci --cacheDirectory .jest-cache || yarn cover:integration:a --ci --cacheDirectory .jest-cache -f";

  assert.deepEqual(firstCommandTokens(line).slice(0, 2), ["yarn", "cover:integration:a"], "only the first command is read");
  assert.equal(purposeOfLine(line, (n) => scripts[n]).purpose, "test", "the `||` must not delete the purpose");
});

test("a conventional script NAME counts only when the repository declares that script", () => {
  const declared = purposeOfLine("npm run test:coverage -- --ci", (n) => (n === "test:coverage" ? "some-opaque-wrapper --run" : undefined));
  assert.equal(declared.purpose, "test");
  assert.equal(declared.basis, "SCRIPT_NAME", "the body was unrecognised, so the declared name carries it");

  const undeclared = purposeOfLine("npm run test:coverage", NO_SCRIPTS);
  assert.equal(undeclared.basis, "NONE", "a name proves nothing about a script the repository does not declare");
});

test("install operations are recognised from the package manager, including yarn's mutating forms", () => {
  for (const line of ["npm ci --legacy-peer-deps", "yarn", "yarn --immutable", "yarn add -D webpack@5", "yarn up @babel/*@^7", "pnpm install"]) {
    assert.equal(purposeOfLine(line, NO_SCRIPTS).purpose, "install", line);
  }
});

test("script recursion terminates rather than hanging on a cycle", () => {
  const scripts: Record<string, string> = { a: "npm run b", b: "npm run a" };
  const verdict = purposeOfLine("npm run a", (n) => scripts[n]);
  assert.equal(verdict.purpose, "unknown", "a cycle resolves to unknown, not to a stack overflow");
});

test("no basis exists for `the text mentioned a framework somewhere`", () => {
  const verdict = purposeOfLine("echo 'we use jest here'", NO_SCRIPTS);
  assert.equal(verdict.basis, "NONE");
  assert.equal(establishesPurpose(verdict), false);
});

test("a coverage wrapper delegates to the runner it wraps", () => {
  for (const line of ["nyc --reporter=json jest --ci", "c8 vitest run", "cross-env NODE_ENV=test jest", "istanbul cover mocha"]) {
    const verdict = purposeOfLine(line, NO_SCRIPTS);
    assert.equal(verdict.purpose, "test", line);
    assert.equal(verdict.basis, "EXECUTABLE_POSITION", line);
  }
});

test("a wrapper with nothing recognisable inside it stays unknown", () => {
  assert.equal(purposeOfLine("nyc --reporter=json ./scripts/custom.sh", NO_SCRIPTS).basis, "NONE");
});

test("babel's real test command is recognised through the interpreter", () => {
  const verdict = purposeOfLine("node ./node_modules/.bin/jest --ci", NO_SCRIPTS);
  assert.equal(verdict.purpose, "test");
  assert.equal(verdict.basis, "EXECUTABLE_POSITION");
});

/**
 * SEMANTIC_REPAIR_02. Every line REGRESSION_01's adjudication traced a phantom `script-N` block to
 * (docs/evidence/regression-01/adjudication.md), reproduced here as the single classifier both
 * `purposeOfLine` and `infer.ts` must now agree on. None of these is a script invocation — they are
 * yarn's own bare-install form, an install subcommand, and a built-in command — and none may reach
 * `resolveScript`.
 */
test("packageManagerCommand never classifies a yarn flag or built-in as a script", () => {
  const cases: Array<[string, "install" | "builtin"]> = [
    ["yarn --frozen-lockfile", "install"], // webpack's basic-install-0 — script-83
    ["yarn --immutable", "install"], // jest's test-leak-install-0 — script-34
    ["yarn install", "install"], // babel's test-node-version25-install-0 — script-32
    ["yarn link webpack --frozen-lockfile", "builtin"], // webpack's basic-unknown-2 — script-84
  ];
  for (const [line, kind] of cases) {
    const pm = pmc(line);
    assert.equal(pm?.kind, kind, line);
    assert.equal(pm?.scriptName, undefined, `${line} must never produce a script name`);
  }
});

test("packageManagerCommand still recognises a genuine script invocation, with or without `run`", () => {
  assert.deepEqual(pmc("yarn build")?.kind, "script");
  assert.equal(pmc("yarn build")?.scriptName, "build");
  assert.equal(pmc("yarn run build")?.scriptName, "build");
  assert.equal(pmc("npm run test:coverage")?.scriptName, "test:coverage");
  // webpack's real test step, unaffected by the built-in list: not a recognised builtin, so still a
  // script candidate — resolveScript is what correctly reports whether the repository declares it.
  assert.equal(pmc("yarn cover:integration:a --ci")?.scriptName, "cover:integration:a");
});

/**
 * SEMANTIC_REPAIR_02, step 2. Boundaries pre-registered before implementation: multiple assignments
 * work, a quoted assignment value never fragments into argv, an assignment AFTER the executable is an
 * argument and stays put, an assignment-only line invents no executable, and every yarn built-in case
 * already covered stays a built-in once assignments are stripped in front of it.
 */
test("normalizeExecutable strips leading KEY=value assignments, and only those", () => {
  assert.deepEqual(normalizeExecutable("yarn jest packages/jest-runtime"), {
    assignments: [],
    tokens: ["yarn", "jest", "packages/jest-runtime"],
  });

  // Jest's real line: a quoted value containing whitespace must be consumed as ONE assignment, not
  // fragmented into extra tokens that could be mistaken for flags or arguments.
  const quoted = normalizeExecutable('NODE_OPTIONS="--experimental-vm-modules --no-warnings" yarn jest packages/jest-runtime');
  assert.deepEqual(quoted.assignments, ['NODE_OPTIONS="--experimental-vm-modules --no-warnings"']);
  assert.deepEqual(quoted.tokens, ["yarn", "jest", "packages/jest-runtime"]);

  // Multiple assignments in a row.
  const multi = normalizeExecutable("FOO=bar BAZ=qux yarn jest");
  assert.deepEqual(multi.assignments, ["FOO=bar", "BAZ=qux"]);
  assert.deepEqual(multi.tokens, ["yarn", "jest"]);

  // An assignment AFTER the executable is an ARGUMENT, not an environment prefix — never stripped.
  const trailing = normalizeExecutable("yarn jest FOO=bar");
  assert.deepEqual(trailing.assignments, []);
  assert.deepEqual(trailing.tokens, ["yarn", "jest", "FOO=bar"]);

  // Assignment-only: no executable to invent from the last KEY.
  assert.deepEqual(normalizeExecutable("FOO=bar"), { assignments: ["FOO=bar"], tokens: [] });

  // Every previously-confirmed built-in case, unaffected: no leading assignment, nothing to strip.
  assert.deepEqual(normalizeExecutable("yarn link webpack --frozen-lockfile").tokens, ["yarn", "link", "webpack", "--frozen-lockfile"]);
});

test("an assignment-prefixed package-manager script is classified exactly like its bare form", () => {
  const bare = pmc("yarn jest packages/jest-runtime");
  const prefixed = pmc('NODE_OPTIONS="--experimental-vm-modules --no-warnings" yarn jest packages/jest-runtime');
  assert.deepEqual(prefixed, bare, "an environment prefix must not change the package-manager verdict");
  assert.equal(prefixed?.kind, "script");
  assert.equal(prefixed?.scriptName, "jest");
});

/**
 * babel-loader's naming-policy question, resolved: the fix is recognising Node's OWN test runner as an
 * EXECUTABLE_POSITION signal (the strongest basis), not widening SCRIPT_NAME_PURPOSE's `/^test(:|$)/i`
 * to admit hyphenated names. That pattern is deliberately left untouched - `test-data`, `test-helper`,
 * `test-build` are all real, plausible npm script names where "test" is an ADJECTIVE modifying a NOUN
 * ("data for tests", "a helper for tests"), not the verb "run tests", and nothing about the SPELLING
 * distinguishes them from `test-only` or `test-unit`. Recognising the runner it actually invokes does not
 * have that ambiguity: `node --test` means one thing regardless of what any script happens to be called.
 */
test("node --test is recognised as EXECUTABLE_POSITION test purpose", () => {
  for (const line of ["node --test test/**/*.test.js", "node --test", "node --test-only test/foo.test.js", "node --test-name-pattern=foo test/"]) {
    const verdict = purposeOfLine(line, NO_SCRIPTS);
    assert.equal(verdict.purpose, "test", line);
    assert.equal(verdict.basis, "EXECUTABLE_POSITION", line);
  }
});

test("an ordinary node invocation without --test is unaffected", () => {
  const verdict = purposeOfLine("node ./scripts/generate.js", NO_SCRIPTS);
  assert.notEqual(verdict.purpose, "test");
});

test("babel-loader's real test script resolves to TEST through its declared body, not its name", () => {
  const scripts: Record<string, string> = { "test-only": "node --test test/**/*.test.js" };
  const verdict = purposeOfLine("yarn test-only", (n) => scripts[n]);
  assert.equal(verdict.purpose, "test");
  assert.equal(verdict.basis, "SCRIPT_BODY", "the body resolved it - the name was never consulted");
});

test("SCRIPT_NAME_PURPOSE is deliberately NOT widened to hyphenated names — the naming-policy decision", () => {
  // A declared script whose body this engine cannot follow (an opaque wrapper) and whose NAME is
  // hyphenated must stay unknown. If this ever starts passing, SCRIPT_NAME_PURPOSE was widened without
  // the ambiguity (test-data / test-helper / test-build) being resolved first.
  const scripts: Record<string, string> = { "test-data": "some-custom-seed-tool --fixtures" };
  const verdict = purposeOfLine("yarn test-data", (n) => scripts[n]);
  assert.notEqual(verdict.purpose, "test", "a hyphenated name alone must not license TEST purpose");
});

test("jest's real three-level script chain resolves to TEST through an assignment prefix", () => {
  // The exact chain nodejs.yml#test-runtime-vm-modules runs: jest-runtime-vm-modules-ci ->
  // jest-runtime-vm-modules -> `NODE_OPTIONS="..." yarn jest packages/jest-runtime` -> jest's own "jest"
  // script, which is a real executable position. Before normalizeExecutable existed, the middle link
  // broke the chain: `yarn` was never identified as the package manager, so `jest` was never reached as
  // a script name, and this job never received TEST purpose at all — REGRESSION_01's PARTIAL_REPRODUCTION
  // (test-leak wins instead) is what that invisibility caused downstream, in the planner.
  const scripts: Record<string, string> = {
    "jest-runtime-vm-modules-ci": "yarn jest-runtime-vm-modules --color --config jest.config.ci.mjs --coverage",
    "jest-runtime-vm-modules": 'NODE_OPTIONS="--experimental-vm-modules --no-warnings" yarn jest packages/jest-runtime',
    jest: "node ./packages/jest-cli/bin/jest.js",
  };
  const verdict = purposeOfLine("yarn jest-runtime-vm-modules-ci --max-workers 4", (n) => scripts[n]);
  assert.equal(verdict.purpose, "test");
  assert.equal(verdict.basis, "SCRIPT_BODY");
});

test("a package-manager built-in never establishes purpose by name, same as before the fix", () => {
  // Unchanged behaviour: `purposeOfLine` already left `yarn link webpack` at NONE, because it never
  // committed to a purpose for an undeclared candidate name. The fix is entirely in what `infer.ts` does
  // with the SAME classification, not in what purpose this line has.
  const verdict = purposeOfLine("yarn link webpack --frozen-lockfile", NO_SCRIPTS);
  assert.equal(verdict.purpose, "unknown");
  assert.equal(verdict.basis, "NONE");
});

/**
 * LAYER 2 guards: inference must CONSUME the structural verdict, never rediscover purpose from text.
 *
 * Removing substring authority from one module while a consumer re-derives it downstream would recreate
 * defect 28 exactly where it is hardest to see. These assert the old authority is gone from the source,
 * not merely bypassed.
 */
import { readFileSync as read } from "node:fs";

test("infer.ts contains no substring-based purpose rule", () => {
  const source = read("src/ci-inference/infer.ts", "utf8");
  assert.doesNotMatch(source, /\/\b\(jest\|vitest\|mocha\|ava\)\b\/\.test/, "the deleted rule must not return");
  assert.doesNotMatch(source, /function kindOfRunLine/, "dead code encoding the old authority is one call from reinstating it");
  assert.doesNotMatch(source, /function kindOfScript/);
  assert.match(source, /purposeOfLine\(line, lookupScript\)/, "purpose must be consumed from the structural module");
});

test("willExecute is three-valued: UNRESOLVED yields undefined, never false", () => {
  const source = read("src/ci-inference/infer.ts", "utf8");
  assert.doesNotMatch(source, /const willExecute = condition \? condition\.result === "TRUE" : true/, "defect 29 must not return");
  assert.match(source, /condition\.result === "FALSE" \? false : undefined/, "UNRESOLVED must fall through to undefined");
});

test("operations carry executionRepresentation and purposeBasis", () => {
  const source = read("src/ci-inference/infer.ts", "utf8");
  assert.match(source, /executionRepresentation,/);
  assert.match(source, /purposeBasis: verdict\.basis,/, "PurposeBasis must reach the receipt for the eventual learning layer");
});

test("SEMANTIC_REPAIR_02: infer.ts has no second, disagreeing script-invocation regex", () => {
  const source = read("src/ci-inference/infer.ts", "utf8");
  assert.doesNotMatch(source, /const SCRIPT_RUN/, "the deleted second parser must not return");
  assert.match(
    source,
    /packageManagerCommand\(normalizeExecutable\(joined\)\.tokens\)/,
    "resolveScript must be gated by the SAME classifier purpose.ts uses, on the SAME normalised tokens",
  );
  assert.doesNotMatch(source, /resolveScript\(repoPath, scriptMatch/, "resolveScript must never be called from a regex match infer.ts derived on its own");
});
