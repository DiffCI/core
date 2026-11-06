// SPDX-License-Identifier: MIT
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { checkPlan } from "../../src/client/check-plan.js";
import { parseJunit } from "../../src/client/enforce-misses.js";

const plan = { version: "5.0.0", mode: "SELECTIVE", safety: { fallbackRequired: false }, selectedTests: ["tests/a.test.js"], skippedTests: ["packages/web/tests/a.test.js"] };
const tc = (file: string, name = "fails", failed = true) => `<testcase file="${file}" name="${name}">${failed ? '<failure/>' : ''}</testcase>`;
const xml = (cases: string) => `<testsuite name="suite">${cases}</testsuite>`;

describe("maintainer review regressions", () => {
  it("does not claim a new miss without base results", () => {
    const r = checkPlan(plan, xml(tc(plan.skippedTests[0])));
    assert.equal(r.summary.missed, 0);
    assert.equal(r.summary.possibleMisses, 1);
  });
  it("separates old and new failures by testcase, not just file", () => {
    const r = checkPlan(plan, xml(tc(plan.skippedTests[0], "old") + tc(plan.skippedTests[0], "new")), {
      baseResults: xml(tc(plan.skippedTests[0], "old") + tc(plan.skippedTests[0], "new", false)),
    });
    assert.equal(r.preExisting[0]?.name, "old");
    assert.equal(r.missed[0]?.name, "new");
    assert.equal(r.summary.preExisting, 1);
    assert.equal(r.summary.missed, 1);
  });
  it("does not let duplicate names or unnamed cases hide a newly broken occurrence", () => {
    const file = plan.skippedTests[0];
    const repeated = xml(tc(file, "same") + tc(file, "same", false));
    const duplicate = checkPlan(plan, repeated, { baseResults: repeated });
    assert.equal(duplicate.summary.preExisting, 0);
    assert.equal(duplicate.summary.possibleMisses, 1);
    const unnamed = xml(`<testcase file="${file}"><failure/></testcase>`);
    assert.equal(checkPlan(plan, unnamed, { baseResults: unnamed }).summary.preExisting, 0);
  });
  it("never lets unknown base failures or suite errors suppress current evidence", () => {
    const input = xml(tc("unknown.js") + '<error/>');
    const r = checkPlan(plan, input, { baseResults: input });
    assert.equal(r.summary.unattributed, 2);
    assert.equal(r.summary.preExisting, 0);
    assert.throws(() => checkPlan(plan, xml(tc(plan.selectedTests[0])), { baseResults: "<testsuite>" }));
  });
  it("maps Windows absolute paths without guessing across drives or sibling roots", () => {
    const options = { repoRoot: "C:/repo", root: "packages/web" };
    assert.equal(checkPlan(plan, xml(tc("C:/repo/packages/web/tests/a.test.js")), options).summary.possibleMisses, 1);
    for (const file of ["C:/repo-other/tests/a.test.js", "D:/repo/tests/a.test.js", "C:/repo/../tests/a.test.js"]) {
      assert.equal(checkPlan(plan, xml(tc(file)), options).summary.unattributed, 1);
    }
  });
  it("uses reporter root even when the repository has a selected same-suffix file", () => {
    const r = checkPlan(plan, xml(tc("tests/a.test.js")), { root: "packages/web", repoRoot: "/repo" });
    assert.equal(r.possibleMisses[0]?.file, plan.skippedTests[0]);
    assert.equal(r.summary.selected, 0);
  });
  it("maps absolute checkout paths and gives testcase files precedence", () => {
    const input = `<testsuite file="/wrong/suite.js">${tc("/repo/packages/web/tests/a.test.js")}</testsuite>`;
    assert.equal(checkPlan(plan, input, { repoRoot: "/repo" }).possibleMisses[0]?.file, plan.skippedTests[0]);
    assert.equal(parseJunit(input, "/repo")[0]?.file, plan.skippedTests[0]);
  });
  it("accepts schema hints but not namespaced elements", () => {
    const input = `<testsuite xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="junit.xsd">${tc(plan.selectedTests[0])}</testsuite>`;
    assert.equal(checkPlan(plan, input).summary.selected, 1);
    assert.equal(parseJunit(input, "/repo")[0]?.failed, true);
    assert.throws(() => checkPlan(plan, '<testsuite xmlns="urn:junit"><testcase name="x"/></testsuite>'));
  });
  it("preserves suite crashes beside ordinary failures and accepts suite-only crashes", () => {
    for (const cases of [tc(plan.selectedTests[0]), ""]) {
      const input = `<testsuite errors="1"><error message="beforeAll"/>${cases}</testsuite>`;
      const r = checkPlan(plan, input);
      assert.equal(r.summary.unattributed, 1);
      assert.equal(r.summary.selected, cases ? 1 : 0);
      assert.equal(parseJunit(input, "/repo").filter(c => c.failed).length, cases ? 2 : 1);
    }
  });
  it("both commands ignore fake failures in CDATA and reject truncated XML", () => {
    const input = xml(`<system-out><![CDATA[${tc(plan.selectedTests[0])}]]></system-out>${tc(plan.selectedTests[0], "passes", false)}`);
    assert.equal(parseJunit(input, "/repo").filter(c => c.failed).length, 0);
    assert.throws(() => parseJunit('<testsuite><testcase file="a" name="broken"><failure/>', "/repo"));
  });
});

describe("second maintainer review regressions", () => {
  it("reports a suite crash already in the window baseline as pre-existing", async () => {
    const { classifyFailures } = await import("../../src/client/enforce-misses.js");
    const fullRun = parseJunit('<testsuite name="s"><error message="setup crashed"/></testsuite>', "/repo");
    const [failure] = classifyFailures({ fullRun, rerun: undefined, baseline: [fullRun[0]!.id], pullRequests: [] });
    assert.equal(failure!.classification, "pre-existing");
    const [fresh] = classifyFailures({ fullRun, rerun: undefined, baseline: [], pullRequests: [] });
    assert.equal(fresh!.classification, "unattributed");
  });
  it("keeps a suite crash unattributed instead of blaming selected receipts", async () => {
    const { buildMissReport } = await import("../../src/client/enforce-misses.js");
    const report = buildMissReport({
      fullRun: parseJunit('<testsuite><error message="setup crashed at /tmp/123"/></testsuite>', "/repo"),
      rerun: undefined, baseline: [], headSha: "head", producedAt: "now", window: { from_sha: "base", source: "detector-record" },
      pullRequests: [{ number: 7, mergeSha: "merge", headSha: "pr", receipt: { artifact: "receipt", report: { schema: "diffci.verification.v1", selection: "selected", selected_tests: ["tests/other.js"] } } }],
    });
    assert.equal(report.failures[0].classification, "unattributed");
    assert.deepEqual(report.open_unsafe_misses, []);
  });
  it("retains stored enforcement ids when file identity comes from a suite or classname", async () => {
    const input = '<testsuite name="suite" file="tests/a.test.js"><testcase name="old" classname="tests/a.test.js"><failure/></testcase></testsuite>';
    assert.equal(parseJunit(input, "/repo")[0].id, " > suite > old");
    const { buildMissReport } = await import("../../src/client/enforce-misses.js");
    const report = buildMissReport({
      fullRun: parseJunit(input, "/repo"), rerun: undefined, baseline: [" > suite > old"],
      headSha: "head", producedAt: "now", window: { from_sha: "base", source: "detector-record" },
      pullRequests: [{ number: 7, mergeSha: "merge", headSha: "pr", receipt: { artifact: "receipt", report: { schema: "diffci.verification.v1", selection: "selected", selected_tests: ["tests/other.js"] } } }],
    });
    assert.equal(report.failures[0].classification, "pre-existing");
    assert.deepEqual(report.open_unsafe_misses, []);
    assert.equal(parseJunit(xml(tc("tests/../tests/a.test.js")), "/repo")[0].id, "tests/../tests/a.test.js > suite > fails");
  });
  it("treats absent base identities as uncertain rather than proven new failures", () => {
    const r = checkPlan(plan, xml(tc(plan.skippedTests[0])), { baseResults: xml(tc("unmapped.js", "other", false)) });
    assert.equal(r.summary.missed, 0);
    assert.equal(r.summary.possibleMisses, 1);
  });
  it("maps base identities from a separate checkout, including path-valued suite names", () => {
    const report = (checkout: string) => `<testsuite name="${checkout}/packages/web/tests/a.test.js"><testcase file="${checkout}/packages/web/tests/a.test.js" classname="${checkout}/packages/web/tests/a.test.js" name="old"><failure/></testcase></testsuite>`;
    const r = checkPlan(plan, report("/head"), { repoRoot: "/head", baseRepoRoot: "/base", baseResults: report("/base") });
    assert.equal(r.summary.preExisting, 1);
    assert.equal(r.summary.missed, 0);
  });
  it("does not collapse distinct invalid path-valued labels into one base identity", () => {
    const report = (label: string) => `<testsuite name="${label}"><testcase file="${plan.skippedTests[0]}" name="fails"><failure/></testcase></testsuite>`;
    const r = checkPlan(plan, report("../head.test.js"), { baseResults: report("../base.test.js") });
    assert.equal(r.summary.preExisting, 0);
    assert.equal(r.summary.possibleMisses, 1);
  });
  it("accepts conventional spellings of the reporter root", () => {
    for (const root of ["./packages/web", "packages/web/", "packages\\web"]) {
      assert.equal(checkPlan(plan, xml(tc("tests/a.test.js")), { root }).summary.possibleMisses, 1);
    }
  });
  it("does not charge repeated passing metadata against the failure budget", () => {
    const input = `<testsuite name="${'s'.repeat(32768)}">${'<testcase name="passes"/>'.repeat(300)}</testsuite>`;
    assert.equal(checkPlan(plan, input, { baseResults: input }).summary.failedTests, 0);
  });
  it("distinguishes missing, conflicting and unknown file metadata", () => {
    assert.match(checkPlan(plan, xml('<testcase name="no metadata"><failure/></testcase>')).unattributed[0].reason, /No file/);
    const r = checkPlan(plan, `<testsuite file="${plan.skippedTests[0]}"><testsuite file="${plan.selectedTests[0]}"><testcase name="conflict"><failure/></testcase></testsuite></testsuite>`);
    assert.equal(r.unattributed[0].candidates?.length, 2);
    assert.match(r.unattributed[0].reason, /multiple/);
  });
});
