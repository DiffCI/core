// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ACTION_INPUT_MODELING_01, prerequisite fix. `declaredPrerequisites`'s `carriesCommand` regex
 * (`infer.ts`) contained two literal U+0008 backspace BYTES where `\b` word-boundary escapes belonged —
 * a raw control character in a regex literal is a character to match, never satisfiable against an
 * identifier list, so the check was unconditionally false since it was written. Every unmodelled action
 * was reported `ARTIFACT`, never `ACTION_EXECUTION`, regardless of its declared `with:` keys.
 *
 * This is a standalone fix, not part of ACTION_INPUT_MODELING_01's own evidence: it does not touch how
 * any command gets extracted or executed, only how an unmodelled action's declared prerequisite is
 * LABELLED.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import { inferPipeline } from "../../src/ci-inference/infer.js";
import type { ObservedFact } from "../../src/ci-inference/schema.js";

const NOW = "2026-09-02T00:00:00.000Z";
const NONEXISTENT_REPO = "C:/__diffci-infer-test-fixture-does-not-exist__";

function fact(partial: Partial<ObservedFact> & Pick<ObservedFact, "kind" | "value">): ObservedFact {
  return { evidence: { file: ".github/workflows/ci.yml", text: partial.value }, ...partial };
}

test("infer.ts's carriesCommand regex contains no raw control bytes", () => {
  // The bug was invisible to every text-rendering path tried first; only a raw byte scan caught it.
  // Guard against it recurring the same way: assert directly on the source bytes, not on rendered text.
  const source = readFileSync("src/ci-inference/infer.ts", "utf8");
  const controlBytes = [...source].filter((c) => {
    const cp = c.codePointAt(0)!;
    return cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d; // allow tab/LF/CR only
  });
  assert.deepEqual(controlBytes, [], "no stray control bytes (e.g. a literal backspace mistaken for \\b) anywhere in infer.ts");
});

test("declaredPrerequisites: an unmodelled action with a command-carrying input is ACTION_EXECUTION", () => {
  const facts: ObservedFact[] = [
    fact({ kind: "workflow.step.run", value: "yarn test", attributes: { workflow: "ci.yml", job: "test", step: "0" } }),
    fact({
      kind: "workflow.step.uses",
      value: "some-org/some-retry-action@abc123",
      attributes: { workflow: "ci.yml", job: "test", step: "1", withKeys: "timeout_minutes,command" },
    }),
  ];
  const pipeline = inferPipeline(NONEXISTENT_REPO, "test/repo", "abc123", facts, NOW);
  const job = pipeline.jobs.find((j) => j.id === "ci.yml#test");
  const prereq = job?.prerequisites?.find((p) => p.identifier.startsWith("some-org/some-retry-action"));
  assert.equal(prereq?.kind, "ACTION_EXECUTION", "a declared `command` input must be recognised, not silently downgraded to ARTIFACT");
});

test("declaredPrerequisites: an unmodelled action with only artifact-shaped inputs stays ARTIFACT", () => {
  const facts: ObservedFact[] = [
    fact({ kind: "workflow.step.run", value: "yarn test", attributes: { workflow: "ci.yml", job: "test", step: "0" } }),
    fact({
      kind: "workflow.step.uses",
      value: "some-org/some-artifact-action@def456",
      attributes: { workflow: "ci.yml", job: "test", step: "1", withKeys: "name,path" },
    }),
  ];
  const pipeline = inferPipeline(NONEXISTENT_REPO, "test/repo", "abc123", facts, NOW);
  const job = pipeline.jobs.find((j) => j.id === "ci.yml#test");
  const prereq = job?.prerequisites?.find((p) => p.identifier.startsWith("some-org/some-artifact-action"));
  assert.equal(prereq?.kind, "ARTIFACT", "no command-shaped key means ARTIFACT, unchanged");
});

/**
 * ACTION_INPUT_MODELING_01. `nick-fields/retry` is the ONLY entry in `MODELLED_COMMAND_INPUT` — every
 * fail-closed test below proves the allowlist actually gates, not merely that this one action happens to
 * work.
 */
const withFact = (opts: { step: string; input: string; value: string; action: string; workflow?: string; job?: string }): ObservedFact => ({
  kind: "workflow.step.with",
  value: `${opts.input}=${opts.value}`,
  evidence: { file: ".github/workflows/ci.yml", text: opts.value },
  attributes: {
    workflow: opts.workflow ?? "ci.yml",
    job: opts.job ?? "test",
    step: opts.step,
    input: opts.input,
    action: opts.action,
    value: opts.value,
  },
});

test("an unlisted action's with.command produces NO operation — fail closed", () => {
  const facts: ObservedFact[] = [
    fact({ kind: "workflow.step.run", value: "yarn install", attributes: { workflow: "ci.yml", job: "test", step: "0" } }),
    fact({
      kind: "workflow.step.uses",
      value: "some-unlisted-org/some-action@v1",
      attributes: { workflow: "ci.yml", job: "test", step: "1", withKeys: "command" },
    }),
    withFact({ step: "1", input: "command", value: "rm -rf /", action: "some-unlisted-org/some-action@v1" }),
  ];
  const pipeline = inferPipeline(NONEXISTENT_REPO, "test/repo", "abc123", facts, NOW);
  const job = pipeline.jobs.find((j) => j.id === "ci.yml#test");
  assert.equal(job?.operations.length, 1, "only the run: step may become an operation");
  assert.ok(!job?.operations.some((o) => o.command.join(" ").includes("rm -rf")), "an unlisted action's input must never become argv");
});

test("nick-fields/retry with a DIFFERENT input key (no `command`) produces no operation", () => {
  const facts: ObservedFact[] = [
    fact({ kind: "workflow.step.run", value: "yarn install", attributes: { workflow: "ci.yml", job: "test", step: "0" } }),
    fact({
      kind: "workflow.step.uses",
      value: "nick-fields/retry@ad984534de44a9489a53aefd81eb77f87c70dc60",
      attributes: { workflow: "ci.yml", job: "test", step: "1", withKeys: "timeout_minutes,max_attempts" },
    }),
    withFact({ step: "1", input: "timeout_minutes", value: "10", action: "nick-fields/retry@ad984534de44a9489a53aefd81eb77f87c70dc60" }),
  ];
  const pipeline = inferPipeline(NONEXISTENT_REPO, "test/repo", "abc123", facts, NOW);
  const job = pipeline.jobs.find((j) => j.id === "ci.yml#test");
  assert.equal(job?.operations.length, 1, "the allowlisted action is present, but not its modelled input — still nothing to extract");
});

test("nick-fields/retry's with.command is extracted, ordered correctly, and provenance is inspectable", () => {
  const dir = mkdtempSync(join(tmpdir(), "diffci-action-input-modeling-"));
  try {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        scripts: {
          "jest-runtime-vm-modules-ci": "yarn jest-runtime-vm-modules --color --config jest.config.ci.mjs --coverage",
          "jest-runtime-vm-modules": 'NODE_OPTIONS="--experimental-vm-modules --no-warnings" yarn jest packages/jest-runtime',
          jest: "node ./packages/jest-cli/bin/jest.js",
        },
      }),
    );
    const RETRY_ACTION = "nick-fields/retry@ad984534de44a9489a53aefd81eb77f87c70dc60";
    const facts: ObservedFact[] = [
      fact({ kind: "workflow.step.run", value: "yarn --immutable", attributes: { workflow: "nodejs.yml", job: "test-runtime-vm-modules", step: "0" } }),
      fact({ kind: "workflow.step.run", value: "yarn build:js", attributes: { workflow: "nodejs.yml", job: "test-runtime-vm-modules", step: "1" } }),
      fact({
        kind: "workflow.step.uses",
        value: RETRY_ACTION,
        attributes: { workflow: "nodejs.yml", job: "test-runtime-vm-modules", step: "2", withKeys: "timeout_minutes,max_attempts,retry_on,command" },
      }),
      withFact({
        step: "2",
        input: "command",
        value: "yarn jest-runtime-vm-modules-ci --max-workers ${{ steps.cpu-cores.outputs.count }}",
        action: RETRY_ACTION,
        workflow: "nodejs.yml",
        job: "test-runtime-vm-modules",
      }),
      fact({
        kind: "workflow.step.run",
        value: "node ./scripts/mapCoverage.mjs",
        attributes: { workflow: "nodejs.yml", job: "test-runtime-vm-modules", step: "3" },
      }),
    ];
    const pipeline = inferPipeline(dir, "jestjs/jest", "9ab14fecc", facts, NOW);
    const job = pipeline.jobs.find((j) => j.id === "nodejs.yml#test-runtime-vm-modules");
    assert.ok(job, "the job must exist");
    assert.ok(job!.provides.includes("TEST"), "the previously invisible TEST operation must now be visible");

    const testOp = job!.operations.find((o) => o.kind === "test");
    assert.ok(testOp, "an operation with test purpose must exist");

    // PREDICTED, not assumed: purpose is established (the script chain resolves), but execution is NOT,
    // because `${{ steps.cpu-cores.outputs.count }}` is a `steps.*` expression this engine does not
    // model — a materially different, explicitly out-of-scope gap. This is webpack's `basic-unknown-1`
    // shape (purpose TEST + execution UNRESOLVED), not a defect in this phase's own work.
    assert.equal(testOp!.executionRepresentation, "UNRESOLVED", "the steps.* expression must not silently resolve");
    assert.equal(testOp!.purposeBasis, "SCRIPT_BODY", "purpose comes from the resolved script chain, not a guess");

    // Provenance: which action, which pinned ref, which input, what original value.
    const evidenceText = testOp!.evidence.map((e) => e.text).join(" | ");
    assert.match(evidenceText, /nick-fields\/retry@ad984534de44a9489a53aefd81eb77f87c70dc60/, "the action and its pinned ref must be inspectable");
    assert.match(evidenceText, /with\.command/, "which input carried the command must be inspectable");
    assert.match(evidenceText, /jest-runtime-vm-modules-ci/, "the original extracted value must be inspectable");

    // Ordering: the modelled operation must depend on the install step that precedes it, not be appended
    // after everything else regardless of position.
    const installOp = job!.operations.find((o) => o.kind === "install");
    assert.ok(installOp, "install must exist");
    assert.ok(testOp!.dependsOn.length > 0, "the modelled operation must have a real dependency chain, not float free of it");

    // The run: step AFTER the modelled uses: step (map coverage) is unaffected by this feature — it is
    // still its own, ordinary, unrelated operation.
    const mapCoverage = job!.operations.find((o) => o.command.join(" ").includes("mapCoverage"));
    assert.ok(mapCoverage, "a run: step after a modelled uses: step must still become its own operation");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
