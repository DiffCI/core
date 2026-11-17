// Attaches the npm package and its signed SLSA provenance to the matching GitHub Release, so the release page
// carries what npm already verifies:
//   diffci-<version>.tgz              the exact tarball npm serves (sha512 checked against dist.integrity)
//   diffci-<version>.intoto.jsonl     the signed DSSE envelope of the SLSA v1 provenance statement
//   diffci-<version>.sigstore.json    the full Sigstore bundle (envelope + certificate + transparency log entry)
// The provenance is the one npm recorded when the release workflow ran `npm publish --provenance`; this script
// only copies it and checks that its subject is the tarball it attaches. OpenSSF Scorecard's Signed-Releases
// check reads release assets, and found none before this (2026-11-17).
//
// Usage: node scripts/attach-release-provenance.mjs <version> [<version> ...]   (needs `gh` and npm)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PACKAGE = "@diffci.com/diffci";
const SLSA_V1 = "https://slsa.dev/provenance/v1";

/** Picks the SLSA provenance bundle and returns it with its decoded in-toto statement. */
export function slsaProvenance(attestations) {
  const found = attestations?.attestations?.find((entry) => entry.predicateType === SLSA_V1);
  if (!found) throw new Error("npm has no SLSA v1 provenance for this version");
  const statement = JSON.parse(Buffer.from(found.bundle.dsseEnvelope.payload, "base64").toString("utf8"));
  return { bundle: found.bundle, statement };
}

/** Throws unless the statement's only subject is this package version with this tarball's sha512. */
export function assertSubject(statement, version, tarball) {
  const sha512 = createHash("sha512").update(tarball).digest("hex");
  const subjects = statement.subject ?? [];
  const expectedName = `pkg:npm/${encodeURIComponent("@diffci.com")}/diffci@${version}`;
  if (subjects.length !== 1 || subjects[0].name !== expectedName || subjects[0].digest?.sha512 !== sha512) {
    throw new Error(`provenance subject ${JSON.stringify(subjects)} does not match ${expectedName} sha512 ${sha512}`);
  }
  return sha512;
}

async function attach(version, dir) {
  // npm is a .cmd shim on Windows, which needs a shell; the arguments are fixed and contain no shell syntax.
  const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", cwd: dir, shell: process.platform === "win32" && cmd === "npm" }).trim();
  const response = await fetch(`https://registry.npmjs.org/-/npm/v1/attestations/${encodeURIComponent(PACKAGE)}@${version}`);
  if (!response.ok) throw new Error(`npm attestations for ${version}: HTTP ${response.status}`);
  const { bundle, statement } = slsaProvenance(await response.json());

  const packed = JSON.parse(run("npm", ["pack", `${PACKAGE}@${version}`, "--json", "--silent"]))[0];
  const tarball = readFileSync(path.join(dir, packed.filename));
  const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  if (integrity !== packed.integrity) throw new Error(`${packed.filename} integrity ${integrity} is not npm's ${packed.integrity}`);
  assertSubject(statement, version, tarball);

  const base = path.join(dir, `diffci-${version}`);
  writeFileSync(`${base}.tgz`, tarball);
  writeFileSync(`${base}.intoto.jsonl`, `${JSON.stringify(bundle.dsseEnvelope)}\n`);
  writeFileSync(`${base}.sigstore.json`, `${JSON.stringify(bundle, null, 2)}\n`);
  const repo = process.env.GITHUB_REPOSITORY ?? "DiffCI/core";
  run("gh", ["release", "upload", `v${version}`, "--repo", repo, "--clobber", `${base}.tgz`, `${base}.intoto.jsonl`, `${base}.sigstore.json`]);
  console.log(`v${version}: attached the tarball and its SLSA provenance`);
}

if (process.argv[1]?.endsWith("attach-release-provenance.mjs")) {
  const versions = process.argv.slice(2);
  if (versions.length === 0) throw new Error("Usage: node scripts/attach-release-provenance.mjs <version> [<version> ...]");
  for (const version of versions) await attach(version.replace(/^v/, ""), mkdtempSync(path.join(tmpdir(), "diffci-provenance-")));
}
