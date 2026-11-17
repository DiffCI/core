import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { assertSubject, slsaProvenance } from "../scripts/attach-release-provenance.mjs";

const tarball = Buffer.from("package tarball bytes");
const sha512 = createHash("sha512").update(tarball).digest("hex");

function attestations(subject: unknown) {
  const payload = Buffer.from(JSON.stringify({ subject })).toString("base64");
  return {
    attestations: [
      { predicateType: "https://github.com/npm/attestation/tree/main/specs/publish/v0.1", bundle: { dsseEnvelope: { payload: "e30=" } } },
      { predicateType: "https://slsa.dev/provenance/v1", bundle: { dsseEnvelope: { payload } } },
    ],
  };
}

test("picks the SLSA provenance and accepts a matching tarball", () => {
  const { statement } = slsaProvenance(attestations([{ name: "pkg:npm/%40diffci.com/diffci@1.2.3", digest: { sha512 } }]));
  assert.equal(assertSubject(statement, "1.2.3", tarball), sha512);
});

test("rejects provenance for another version or another tarball", () => {
  const { statement } = slsaProvenance(attestations([{ name: "pkg:npm/%40diffci.com/diffci@1.2.3", digest: { sha512 } }]));
  assert.throws(() => assertSubject(statement, "1.2.4", tarball), /does not match/);
  assert.throws(() => assertSubject(statement, "1.2.3", Buffer.from("other")), /does not match/);
});

test("fails when npm has no SLSA provenance", () => {
  assert.throws(() => slsaProvenance({ attestations: [] }), /no SLSA v1 provenance/);
});
