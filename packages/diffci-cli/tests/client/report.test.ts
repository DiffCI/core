/**
 * Phase 02 (2026-08-26): the report is a wire format, so its validator is part of the product.
 *
 * From Phase 03 the same function guards ingest, where the sender is a pinned action running in
 * somebody else's CI and can be any version, any age, or not DiffCI at all. The two rules that matter
 * are checked here: an unrecognised schema is rejected outright, and a document that CLAIMS to carry
 * file contents or credentials is rejected even though this producer never sets those flags - a
 * validator that only accepts what its own producer emits is not a validator.
 */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { OBSERVATION_SCHEMA, readTypeScriptProgramMetrics, redactPath, validateObservationReport } from "../../src/client/report.js";

const sha256 = (input: string): string => createHash("sha256").update(input).digest("hex");

describe("optional compiler telemetry", () => {
  const metrics = { sourceFileLoads: 3, sourceFileLoadMs: 1.5, failedSourceFileLoads: 0,
    bundledLibraryLoads: 1, bundledLibraryLoadMs: 0.5, otherDeclarationLoads: 1, otherDeclarationLoadMs: 0.5,
    implementationLoads: 1, implementationLoadMs: 0.5 };
  it("preserves measured fields without allowing paths, contents or extra producer fields", () => {
    assert.deepEqual(readTypeScriptProgramMetrics({ ...metrics, path: "private.ts", contents: "secret" }), metrics);
  });
  it("leaves unsupported, incomplete and invalid telemetry absent", () => {
    for (const input of [undefined, null, [], {}, { ...metrics, sourceFileLoads: 1.5 },
      { ...metrics, implementationLoadMs: Infinity }, { ...metrics, bundledLibraryLoadMs: -1 }])
      assert.equal(readTypeScriptProgramMetrics(input), undefined);
  });
});

function minimalReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: OBSERVATION_SCHEMA,
    producedAt: "2026-08-26T00:00:00.000Z",
    status: "OBSERVED",
    stage: "complete",
    payload: {
      includesFilePaths: true,
      includesFileContents: false,
      includesEnvironment: false,
      includesCredentials: false,
    },
    nonInterference: { worktreeUnchanged: true, reportWrittenOutsideRepository: true, workflowFindings: [] },
    ...overrides,
  };
}

describe("observation report validation", () => {
  it("accepts a well-formed report", () => {
    assert.equal(validateObservationReport(minimalReport()).ok, true);
  });

  it("rejects a schema it does not recognise", () => {
    const result = validateObservationReport(minimalReport({ schema: "diffci.observation.v2" }));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /unsupported schema/);
  });

  it("rejects a document that claims to carry file contents", () => {
    const result = validateObservationReport(
      minimalReport({
        payload: { includesFilePaths: true, includesFileContents: true, includesEnvironment: false, includesCredentials: false },
      }),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /file contents or credentials/);
  });

  it("rejects a document with no non-interference evidence", () => {
    const report = minimalReport();
    delete report.nonInterference;
    assert.equal(validateObservationReport(report).ok, false);
  });

  it("rejects an unknown status", () => {
    assert.equal(validateObservationReport(minimalReport({ status: "OK" })).ok, false);
  });

  it("rejects non-objects", () => {
    assert.equal(validateObservationReport(null).ok, false);
    assert.equal(validateObservationReport("{}").ok, false);
  });
});

describe("path redaction", () => {
  it("is stable for the same path and different for different paths", () => {
    assert.equal(redactPath("src/a.ts", sha256), redactPath("src/a.ts", sha256));
    assert.notEqual(redactPath("src/a.ts", sha256), redactPath("src/b.ts", sha256));
    assert.match(redactPath("src/a.ts", sha256), /^[0-9a-f]{12}$/);
  });
});
