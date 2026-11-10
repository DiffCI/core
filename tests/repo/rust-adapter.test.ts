import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { analyzeRepository } from "../../src/repo/analyzer.js";
import { analyzeRustMetadata, parseCargoMetadata, rustAdapter, type CargoPackage } from "../../src/repo/adapters/rust.js";

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "diffci-rust-"));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  return root;
}

function target(root: string, source: string, name: string, kind = "lib", enabled = true) {
  return { name, kind: [kind], src_path: join(root, source), test: enabled, doctest: kind === "lib" && enabled };
}

function pkg(root: string, directory: string, name: string, targets = [target(root, `${directory ? `${directory}/` : ""}src/lib.rs`, name)]) {
  return { id: `path+${root}/${directory}#${name}@0.1.0`, name, manifest_path: join(root, directory, "Cargo.toml"), targets };
}

function metadata(root: string, packages: CargoPackage[], extra: Record<string, unknown> = {}) {
  return JSON.stringify({ workspace_root: root, workspace_members: packages.map(pkg => pkg.id), packages, ...extra });
}

const foundationBlocker = "Rust crate dependency analysis is not available; full validation required";
const manifest = (name: string) => `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2021"\n`;

test("Cargo maps a single crate's targets without guessing helper files as runnable tests", () => {
  const files = {
    "Cargo.toml": manifest("example"), "src/lib.rs": "#[cfg(test)] mod tests {}", "src/value.rs": "pub const VALUE: i32 = 1;",
    "tests/api.rs": "#[test] fn test_api() {}", "tests/common/mod.rs": "pub fn helper() {}",
    "examples/demo.rs": "fn main() {}", "benches/speed.rs": "fn main() {}", "src/main.rs": "fn main() {}",
  };
  const root = fixture(files);
  try {
    const p = pkg(root, "", "example", [target(root, "src/lib.rs", "example"), target(root, "src/main.rs", "example-cli", "bin"),
      target(root, "tests/api.rs", "api", "test"), target(root, "examples/demo.rs", "demo", "example", false), target(root, "benches/speed.rs", "speed", "bench")]);
    const result = analyzeRustMetadata({ repoPath: root, files: Object.keys(files), profile: analyzeRepository({ repoPath: root }) }, metadata(root, [p]));
    assert.deepEqual(result.blockers, [foundationBlocker]);
    assert.deepEqual(result.sourcePaths, Object.keys(files).sort());
    assert.deepEqual(result.testFiles, ["benches/speed.rs", "src/lib.rs", "src/main.rs", "tests/api.rs"]);
    assert.deepEqual(result.testPackages, { "src/lib.rs": "example", "src/main.rs": "example", "tests/api.rs": "example", "benches/speed.rs": "example" });
    assert.deepEqual(result.rustTestTargets?.["tests/api.rs"], { name: "api", kind: "test" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Cargo maps workspace members and gives nested packages precedence", () => {
  const files = {
    "Cargo.toml": '[workspace]\nmembers = ["parent", "parent/nested"]\nresolver = "2"\n',
    "parent/Cargo.toml": manifest("parent"), "parent/src/lib.rs": "", "parent/tests/api.rs": "",
    "parent/nested/Cargo.toml": manifest("child"), "parent/nested/src/lib.rs": "", "parent/nested/tests/api.rs": "",
  };
  const root = fixture(files);
  try {
    const packages = [pkg(root, "parent", "parent", [target(root, "parent/src/lib.rs", "parent"), target(root, "parent/tests/api.rs", "api", "test")]),
      pkg(root, "parent/nested", "child", [target(root, "parent/nested/src/lib.rs", "child"), target(root, "parent/nested/tests/api.rs", "api", "test")])];
    const result = analyzeRustMetadata({ repoPath: root, files: Object.keys(files), profile: analyzeRepository({ repoPath: root }) }, metadata(root, packages));
    assert.deepEqual(result.blockers, [foundationBlocker]);
    assert.equal(result.testPackages["parent/tests/api.rs"], "parent");
    assert.equal(result.testPackages["parent/nested/tests/api.rs"], "child");
    assert.equal(result.testPackages["parent/nested/src/lib.rs"], "child");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Cargo metadata cannot claim missing members, malformed targets or an empty workspace", () => {
  for (const output of ["not JSON", "{}", JSON.stringify({ workspace_root: tmpdir(), workspace_members: [], packages: [] }),
    JSON.stringify({ workspace_root: tmpdir(), workspace_members: ["missing"], packages: [] })]) {
    assert.throws(() => parseCargoMetadata(output));
  }
  const root = fixture({ "Cargo.toml": manifest("app"), "src/lib.rs": "" });
  try {
    const p = pkg(root, "", "app");
    assert.throws(() => parseCargoMetadata(metadata(root, [{ ...p, targets: [{ ...p.targets[0]!, test: undefined }] } as unknown as CargoPackage])));
    assert.throws(() => parseCargoMetadata(metadata(root, [p, p])));
    const invalid = analyzeRustMetadata({ repoPath: root, files: ["Cargo.toml", "src/lib.rs"], profile: analyzeRepository({ repoPath: root }) }, "{}");
    assert.ok(invalid.blockers.some(reason => /Invalid or incomplete/.test(reason)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Cargo blocks unowned Rust files and targets outside their owning package", () => {
  const files = { "Cargo.toml": '[workspace]\nmembers = ["app"]\n', "orphan.rs": "", "app/Cargo.toml": manifest("app"), "app/src/lib.rs": "" };
  const root = fixture(files);
  try {
    const context = { repoPath: root, files: Object.keys(files), profile: analyzeRepository({ repoPath: root }) };
    const p = pkg(root, "app", "app");
    const result = analyzeRustMetadata(context, metadata(root, [p]));
    assert.ok(result.blockers.some(reason => reason.includes("orphan.rs")));
    for (const path of [join(root, "missing.rs"), join(root, "..", "outside.rs"), join(root, "orphan.rs")]) {
      const invalid = analyzeRustMetadata(context, metadata(root, [{ ...p, targets: [{ ...p.targets[0]!, src_path: path }] }]));
      assert.ok(invalid.blockers.some(reason => /unavailable, external or differently owned/.test(reason)));
      assert.deepEqual(invalid.testFiles, []);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Rust detection is specific and missing root manifest falls back", () => {
  const root = fixture({ "package.json": "{}" });
  try {
    const context = { repoPath: root, files: ["package.json"], profile: analyzeRepository({ repoPath: root }) };
    assert.equal(rustAdapter.detect(context), false);
    assert.equal(rustAdapter.detect({ ...context, files: ["src/lib.rs"] }), true);
    assert.deepEqual(rustAdapter.analyze({ ...context, files: ["nested/Cargo.toml"] }).blockers, ["Rust support requires a root Cargo.toml"]);
    const unavailable = rustAdapter.analyze({ ...context, files: ["Cargo.toml"] });
    assert.ok(unavailable.blockers.some(reason => reason.startsWith("Cargo metadata unavailable")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an excluded nested Cargo package cannot silently become part of its parent", () => {
  const files = { "Cargo.toml": manifest("root"), "src/lib.rs": "", "excluded/Cargo.toml": manifest("excluded"),
    "excluded/src/lib.rs": "", "excluded/tests/api.rs": "" };
  const root = fixture(files);
  try {
    const result = analyzeRustMetadata({ repoPath: root, files: Object.keys(files), profile: analyzeRepository({ repoPath: root }) }, metadata(root, [pkg(root, "", "root")]));
    assert.ok(result.blockers.some(reason => reason.includes("Cargo manifests outside workspace membership") && reason.includes("excluded/Cargo.toml")));
    assert.ok(!result.sourcePaths.includes("excluded/src/lib.rs"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Cargo rejects symlink escapes and duplicate target source identities", (t) => {
  const files = { "Cargo.toml": manifest("root"), "src/lib.rs": "" };
  const root = fixture(files);
  const outside = fixture({ "escape.rs": "" });
  try {
    const context = { repoPath: root, files: Object.keys(files), profile: analyzeRepository({ repoPath: root }) };
    const p = pkg(root, "", "root");
    const duplicate = analyzeRustMetadata(context, metadata(root, [{ ...p, targets: [...p.targets, target(root, "src/lib.rs", "other", "bin")] }]));
    assert.ok(duplicate.blockers.some(reason => reason.includes("Multiple Cargo test targets")));
    try { symlinkSync(join(outside, "escape.rs"), join(root, "escape.rs")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") { t.diagnostic("symlink privilege unavailable; duplicate-target check completed"); return; }
      throw error;
    }
    const escaped = analyzeRustMetadata({ ...context, files: [...context.files, "escape.rs"] }, metadata(root, [{ ...p, targets: [target(root, "escape.rs", "escaped")] }]));
    assert.ok(escaped.blockers.some(reason => reason.includes("unavailable, external")));
    assert.deepEqual(escaped.testFiles, []);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

const cargoAvailable = spawnSync("cargo", ["--version"], { encoding: "utf8", windowsHide: true }).status === 0;
for (const nested of [false, true]) test(`Cargo executable maps ${nested ? "nested" : "two-member"} workspace without modifying manifests`, { skip: !cargoAvailable }, () => {
  const child = nested ? "parent/child" : "child";
  const files = { "Cargo.toml": `[workspace]\nmembers = ["parent", "${child}"]\nresolver = "2"\n`, "parent/Cargo.toml": manifest("parent"),
    "parent/src/lib.rs": "#[cfg(test)] mod tests { #[test] fn works() {} }", [`${child}/Cargo.toml`]: manifest("child"), [`${child}/src/lib.rs`]: "", [`${child}/tests/check.rs`]: "#[test] fn works() {}" };
  const root = fixture(files);
  try {
    const result = rustAdapter.analyze({ repoPath: root, files: Object.keys(files), profile: analyzeRepository({ repoPath: root }) });
    assert.deepEqual(result.blockers, [foundationBlocker]);
    assert.equal(result.testPackages[`${child}/tests/check.rs`], "child");
    assert.equal(readFileSync(join(root, "Cargo.toml"), "utf8"), files["Cargo.toml"]);
    assert.equal(existsSync(join(root, "Cargo.lock")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Cargo executable maps a single crate", { skip: !cargoAvailable }, () => {
  const files = { "Cargo.toml": manifest("single"), "src/lib.rs": "#[cfg(test)] mod tests { #[test] fn works() {} }", "tests/api.rs": "#[test] fn works() {}" };
  const root = fixture(files);
  try {
    const result = rustAdapter.analyze({ repoPath: root, files: Object.keys(files), profile: analyzeRepository({ repoPath: root }) });
    assert.deepEqual(result.blockers, [foundationBlocker]);
    assert.deepEqual(result.testPackages, { "src/lib.rs": "single", "tests/api.rs": "single" });
    assert.equal(existsSync(join(root, "Cargo.lock")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
