// SPDX-License-Identifier: MIT
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { checkPlan } from "../../src/client/check-plan.js";

const selectedFile = "tests/selected.test.js";
const missedFile = "tests/missed.test.js";
function plan(selectedTests = [selectedFile], skippedTests = [missedFile], mode: "SELECTIVE" | "FULL" = "SELECTIVE") {
  return { version: "5.0.0", mode, selectedTests, skippedTests, safety: { fallbackRequired: mode === "FULL" } };
}
const attr = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const failingCase = (file: string, name = "fails", kind = "failure") => `<testcase file="${attr(file)}" name="${attr(name)}"><${kind} message="synthetic"/></testcase>`;
const report = (...cases: string[]) => `<testsuites><testsuite name="synthetic suite">${cases.join("")}</testsuite></testsuites>`;
const passingReport = report('<testcase name="passes"/>');
const fixture = (name: string) => readFileSync(new URL(`./fixtures/check-plan/${name}`, import.meta.url), "utf8");

describe("checkPlan failure attribution", () => {
  it("separates missed and selected failures from passing and skipped cases", () => {
    const result = checkPlan(plan(), report(
      failingCase(selectedFile, "selected failure"), failingCase(missedFile, "missed error", "error"),
      '<testcase name="passes"/>', `<testcase file="${missedFile}" name="skips"><skipped/></testcase>`,
    ));
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.mode, "SELECTIVE");
    assert.equal(result.fullFallback, false);
    assert.deepEqual(result.summary, { failedTests: 2, missed: 0, preExisting: 0, possibleMisses: 1, selected: 1, unattributed: 0 });
    assert.equal(result.possibleMisses[0].file, missedFile);
    assert.equal(result.selected[0].file, selectedFile);
  });

  it("accepts the analyzeCheckout wrapper and a passing report", () => {
    const wrapped = { advisoryOnly: true, base: "base-revision", head: "head-revision", plan: plan() };
    assert.deepEqual(checkPlan(wrapped, passingReport).summary, { failedTests: 0, missed: 0, preExisting: 0, possibleMisses: 0, selected: 0, unattributed: 0 });
  });

  it("prefers the explicit file over a classname that names a selected file", () => {
    const result = checkPlan(plan(), report(`<testcase name="explicit file wins" file="${missedFile}" classname="${selectedFile}"><failure/></testcase>`));
    assert.equal(result.possibleMisses[0]?.file, missedFile);
    assert.equal(result.summary.unattributed, 0);
  });

  it("inherits an enclosing suite file through nested suites", () => {
    const xml = `<testsuites><testsuite file="${missedFile}" errors="1"><testsuite name="nested"><testcase name="nested failure"><error/></testcase></testsuite></testsuite></testsuites>`;
    const result = checkPlan(plan(), xml);
    assert.equal(result.possibleMisses[0]?.file, missedFile);
    assert.equal(result.summary.failedTests, 1);
  });

  it("uses path-valued classname and suite names when explicit file attributes are absent", () => {
    const xml = `<testsuites><testsuite name="${missedFile}"><testcase name="suite path"><failure/></testcase></testsuite><testsuite name="label"><testcase classname="${selectedFile}" name="class path"><failure/></testcase></testsuite></testsuites>`;
    const result = checkPlan(plan(), xml);
    assert.deepEqual(result.summary, { failedTests: 2, missed: 0, preExisting: 0, possibleMisses: 1, selected: 1, unattributed: 0 });
  });

  it("does not choose between conflicting classname and suite paths", () => {
    const xml = `<testsuite name="${missedFile}"><testcase classname="${selectedFile}" name="ambiguous"><failure/></testcase></testsuite>`;
    const result = checkPlan(plan(), xml);
    assert.equal(result.summary.unattributed, 1);
    assert.equal(result.summary.selected, 0);
    assert.ok(result.unattributed[0].reason);
  });

  for (const file of ["./tests/selected.test.js", "tests\\selected.test.js"]) {
    it(`maps an unambiguous reporter path ${JSON.stringify(file)}`, () => {
      const result = checkPlan(plan(), report(failingCase(file)));
      assert.equal(result.selected[0]?.file, selectedFile);
      assert.equal(result.summary.unattributed, 0);
    });
  }

  it("does not infer a repository root from an absolute suffix", () => {
    const result = checkPlan(plan(["tests/a.test.js"], ["packages/ui/tests/a.test.js"]), report(failingCase("C:\\agent\\repo\\packages\\ui\\tests\\a.test.js")));
    assert.equal(result.summary.unattributed, 1);
    assert.equal(result.summary.selected, 0);
    assert.equal(result.summary.possibleMisses, 0);
  });

  for (const file of ["selected.test.js", "another/tests/selected.test.js", "../tests/selected.test.js", "tests/../tests/selected.test.js", "https://example.test/tests/selected.test.js", "tests/unknown.test.js", "/agent/repository/tests/selected.test.js", "C:\\agent\\repository\\tests\\selected.test.js", "/repo/packages/new/tests/selected.test.js", "tests/selected.test.js/", "tests/selected.test.js/.", "tests/selected.test.js//"]) {
    it(`keeps an unsafe or unknown path unattributed: ${JSON.stringify(file)}`, () => {
      const result = checkPlan(plan(), report(`<testcase name="unmapped" file="${attr(file)}" classname="${selectedFile}"><failure/></testcase>`));
      assert.equal(result.summary.unattributed, 1);
      assert.equal(result.summary.selected, 0);
    });
  }

  it("never extracts identity from a testcase title or stack text", () => {
    const result = checkPlan(plan(), report(`<testcase name="${selectedFile}" classname="describe labels"><failure>at ${selectedFile}:5:2</failure></testcase>`));
    assert.equal(result.summary.unattributed, 1);
  });

  it("decodes XML attribute entities without losing path or test-name characters", () => {
    const file = "tests/a & b.test.js";
    const name = 'handles <xml> & "quotes"';
    const result = checkPlan(plan([], [file]), report(failingCase(file, name)));
    assert.equal(result.possibleMisses[0]?.file, file);
    assert.equal(result.possibleMisses[0]?.name, name);
  });

  it("preserves distinct duplicate-name cases while counting each failing case once", () => {
    const one = `<testcase file="${missedFile}" name="same"><failure/><failure/><error/></testcase>`;
    const result = checkPlan(plan(), report(one, one));
    assert.deepEqual(result.summary, { failedTests: 2, missed: 0, preExisting: 0, possibleMisses: 2, selected: 0, unattributed: 0 });
    assert.equal(result.possibleMisses.length, 2);
  });

  it("does not let a skipped marker hide a failure on the same case", () => {
    const result = checkPlan(plan(), report(`<testcase name="contradictory" file="${missedFile}"><skipped/><failure/></testcase>`));
    assert.equal(result.summary.possibleMisses, 1);
  });

  it("states FULL fallback explicitly while retaining unattributed failures", () => {
    const result = checkPlan(plan([selectedFile, missedFile], [], "FULL"), report(failingCase(selectedFile), failingCase(missedFile), failingCase("tests/unknown.test.js")));
    assert.equal(result.mode, "FULL");
    assert.equal(result.fullFallback, true);
    assert.deepEqual(result.possibleMisses, []);
    assert.deepEqual(result.summary, { failedTests: 3, missed: 0, preExisting: 0, possibleMisses: 0, selected: 2, unattributed: 1 });
  });
});

describe("checkPlan XML validation", () => {
  it("ignores apparent XML tags in comments and CDATA", () => {
    const fake = failingCase(missedFile);
    const xml = `<testsuites><!-- ${fake} --><testsuite><system-out><![CDATA[${fake}]]></system-out><testcase name="passes"/></testsuite></testsuites>`;
    assert.equal(checkPlan(plan(), xml).summary.failedTests, 0);
  });

  it("finds failures even when aggregate headers are missing or undercount them", () => {
    assert.equal(checkPlan(plan(), report(failingCase(missedFile))).summary.possibleMisses, 1);
    assert.equal(checkPlan(plan(), `<testsuite tests="0" failures="0" errors="0">${failingCase(missedFile)}</testsuite>`).summary.possibleMisses, 1);
  });

  it("counts descendant testcases when checking nested suite totals", () => {
    const xml = `<testsuites tests="2"><testsuite tests="2"><testsuite tests="1">${failingCase(missedFile)}</testsuite><testcase name="passes"/></testsuite></testsuites>`;
    assert.equal(checkPlan(plan(), xml).summary.possibleMisses, 1);
  });

  it("bounds inherited failure metadata before it can expand a small report", () => {
    const xml = `<testsuite name="${"s".repeat(32 * 1024)}">${failingCase(selectedFile).repeat(257)}</testsuite>`;
    assert.ok(Buffer.byteLength(xml, "utf8") < 16 * 1024 * 1024);
    assert.throws(() => checkPlan(plan(), xml), /metadata exceeds the 16 MiB limit/);
  });

  for (const [label, xml] of [
    ["empty input", ""], ["whitespace input", " \n"],
    ["empty suite", '<testsuites tests="0" failures="0" errors="0"/>'],
    ["non-JUnit input", "<document/>"],
    ["mismatched tags", "<testsuites><testsuite></testsuites>"],
    ["truncated input", '<testsuite><testcase name="broken'],
    ["multiple roots", passingReport + passingReport],
    ["trailing garbage", passingReport + "garbage"],
    ["unescaped entity", '<testsuite><testcase name="a & b"/></testsuite>'],
    ["unknown entity", '<testsuite><testcase name="&unknown;"/></testsuite>'],
    ["invalid character reference", '<testsuite><testcase name="&#0;"/></testsuite>'],
    ["duplicate attribute", '<testsuite><testcase name="one" name="two"/></testsuite>'],
    ["qualified file metadata", `<testsuite xmlns:x="urn:reporter" file="${selectedFile}"><testcase name="ambiguous" x:file="${missedFile}"><failure/></testcase></testsuite>`],
    ["qualified failure count", '<testsuite xmlns:x="urn:reporter" x:failures="1"><testcase name="passes"/></testsuite>'],
    ["XML 1.1", '<?xml version="1.1"?><testsuite><testcase name="passes"/></testsuite>'],
    ["non-UTF8 declaration", '<?xml version="1.0" encoding="UTF-16"?><testsuite><testcase name="passes"/></testsuite>'],
    ["external entity declaration", '<!DOCTYPE testsuite [<!ENTITY ext SYSTEM "file:///nonexistent-junit-entity">]><testsuite><testcase name="&ext;"/></testsuite>'],
    ["suite inside a testcase", '<testsuite><testcase name="bad"><testsuite/></testcase></testsuite>'],
    ["excessive nesting", '<testsuites>' + '<testsuite>'.repeat(129) + '<testcase name="passes"/>' + '</testsuite>'.repeat(129) + '</testsuites>'],
    ["negative failure count", '<testsuite failures="-1"><testcase name="passes"/></testsuite>'],
    ["negative test count", '<testsuite tests="-1"><testcase name="passes"/></testsuite>'],
    ["noninteger test count", '<testsuite tests="1.5"><testcase name="passes"/></testsuite>'],
    ["incomplete passing suite", '<testsuite tests="10"><testcase name="passes"/></testsuite>'],
    ["incomplete root test total", '<testsuites tests="2"><testsuite tests="1"><testcase name="passes"/></testsuite></testsuites>'],
    ["unrepresented failures", '<testsuite failures="1"><testcase name="passes"/></testsuite>'],
    ["unrepresented errors", '<testsuite errors="1"><testcase name="passes"/></testsuite>'],
  ]) {
    it(`rejects ${label}`, () => assert.throws(() => checkPlan(plan(), xml)));
  }
});

describe("checkPlan plan validation", () => {
  const invalid: Array<[string, unknown]> = [
    ["null", null], ["array", []], ["missing plan fields", {}],
    ["unknown version", { ...plan(), version: "6.0.0" }],
    ["unknown mode", { ...plan(), mode: "SKIP" }],
    ["missing safety", { ...plan(), safety: undefined }],
    ["missing fallback flag", { ...plan(), safety: {} }],
    ["selective fallback contradiction", { ...plan(), safety: { fallbackRequired: true } }],
    ["full fallback contradiction", { ...plan([], [], "FULL"), safety: { fallbackRequired: false } }],
    ["FULL with skipped tests", plan([selectedFile], [missedFile], "FULL")],
    ["non-array selection", { ...plan(), selectedTests: selectedFile }],
    ["non-string path", { ...plan(), selectedTests: [7] }],
    ["empty path", plan([""])],
    ["escaping path", plan(["../selected.test.js"])],
    ["absolute plan path", plan(["/repo/tests/selected.test.js"])],
    ["duplicate selected path", plan([selectedFile, selectedFile])],
    ["normalized duplicate", plan([selectedFile, `./${selectedFile}`])],
    ["duplicate skipped path", plan([], [missedFile, missedFile])],
    ["overlapping selection", plan([selectedFile], [selectedFile])],
    ["normalized overlap", plan([selectedFile], ["tests\\selected.test.js"])],
    ["unrecognized wrapper", { result: plan() }],
    ["non-advisory wrapper", { advisoryOnly: false, base: "base", head: "head", plan: plan() }],
    ["wrapper without revisions", { advisoryOnly: true, plan: plan() }],
  ];
  for (const [label, input] of invalid) {
    it(`rejects ${label}`, () => assert.throws(() => checkPlan(input, passingReport)));
  }
});

describe("checkPlan genuine reporter fixtures", () => {
  const failingFiles = ["tests/hook-error.test.js", "tests/load-error.test.js", "tests/multiple-errors.test.js", "tests/space & failure.test.js"];
  for (const name of ["vitest-default.xml", "vitest-explicit.xml"]) {
    it(`maps all five failed cases in ${name}`, () => {
      const result = checkPlan(plan(["tests/pass.test.js"], failingFiles), fixture(name));
      assert.deepEqual(result.summary, { failedTests: 5, missed: 0, preExisting: 0, possibleMisses: 5, selected: 0, unattributed: 0 });
      assert.deepEqual([...new Set(result.possibleMisses.map((failure) => failure.file))].sort(), [...failingFiles].sort());
      assert.equal(result.possibleMisses.filter((failure) => failure.file === "tests/space & failure.test.js").length, 2);
      assert.equal(result.possibleMisses.filter((failure) => failure.file === "tests/multiple-errors.test.js").length, 1);
    });
  }

  it("keeps Jest's default describe labels unattributed without guessing from stacks", () => {
    const result = checkPlan(plan(["tests/pass.test.js"], failingFiles), fixture("jest-junit-default.xml"));
    assert.deepEqual(result.summary, { failedTests: 4, missed: 0, preExisting: 0, possibleMisses: 0, selected: 0, unattributed: 4 });
  });

  it("reads Jest's explicit files, load errors and hook failures despite lower declared counts", () => {
    const result = checkPlan(plan(["tests/pass.test.js"], failingFiles), fixture("jest-junit-explicit.xml"));
    assert.deepEqual(result.summary, { failedTests: 6, missed: 0, preExisting: 0, possibleMisses: 6, selected: 0, unattributed: 0 });
    assert.equal(result.possibleMisses.filter((failure) => failure.file === "tests/load-error.test.js").length, 2);
    assert.equal(result.possibleMisses.filter((failure) => failure.file === "tests/multiple-errors.test.js").length, 1);
  });

  it("covers the same genuine failures when the selection is corrected or FULL", () => {
    for (const mode of ["SELECTIVE", "FULL"] as const) {
      const result = checkPlan(plan(failingFiles, [], mode), fixture("jest-junit-explicit.xml"));
      assert.deepEqual(result.summary, { failedTests: 6, missed: 0, preExisting: 0, possibleMisses: 0, selected: 6, unattributed: 0 });
      assert.equal(result.fullFallback, mode === "FULL");
    }
  });
});
