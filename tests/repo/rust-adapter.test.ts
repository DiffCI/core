import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { analyzeRepository } from "../../src/repo/analyzer.js";
import { hydrateDependencyGraph } from "../../src/repo/graph.js";
import type { DependencyGraph } from "../../src/repo/types.js";
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
  return { id: `path+${root}/${directory}#${name}@0.1.0`, name, manifest_path: join(root, directory, "Cargo.toml"), targets, dependencies: [], features: {} };
}

function metadata(root: string, packages: CargoPackage[], extra: Record<string, unknown> = {}) {
  return JSON.stringify({ workspace_root: root, workspace_members: packages.map(pkg => pkg.id), packages, resolve: { nodes: packages.map(pkg => ({ id: pkg.id, dependencies: [] })) }, ...extra });
}

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
    assert.deepEqual(result.blockers, []);
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
    assert.deepEqual(result.blockers, []);
    assert.equal(result.testPackages["parent/tests/api.rs"], "parent");
    assert.equal(result.testPackages["parent/nested/tests/api.rs"], "child");
    assert.equal(result.testPackages["parent/nested/src/lib.rs"], "child");
    assert.ok(result.edges.some(edge => edge.from === "parent/Cargo.toml" && edge.to === "parent/nested/Cargo.toml"));
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

test("Cargo dependency edges select the changed crate and transitive normal/dev/optional dependents", () => {
  const names = ["leaf", "consumer", "app", "other"];
  const files: Record<string, string> = { "Cargo.toml": '[workspace]\nmembers = ["leaf", "consumer", "app", "other"]\n' };
  for (const name of names) Object.assign(files, { [`${name}/Cargo.toml`]: manifest(name), [`${name}/src/lib.rs`]: '#[cfg(feature = "extra")] pub fn optional() {}', [`${name}/tests/api.rs`]: "#[test] fn works() {}" });
  const root = fixture(files);
  try {
    const packages = names.map(name => pkg(root, name, name, [target(root, `${name}/src/lib.rs`, name), target(root, `${name}/tests/api.rs`, "api", "test")]));
    const dependencies = { leaf: [], consumer: [packages[0]!.id], app: [packages[1]!.id], other: [] };
    const output = metadata(root, packages, { resolve: { nodes: packages.map(p => ({ id: p.id, dependencies: dependencies[p.name as keyof typeof dependencies] })) } });
    const result = analyzeRustMetadata({ repoPath: root, files: Object.keys(files), profile: analyzeRepository({ repoPath: root }) }, output);
    assert.deepEqual(result.blockers, []);
    const tests = new Set(result.testFiles);
    const graph = hydrateDependencyGraph({ nodes: result.sourcePaths.map(path => ({ path, isSource: true, isAsset: false, isTest: tests.has(path), isEntryPoint: false })), edges: result.edges } as unknown as DependencyGraph, root);
    assert.deepEqual(graph.transitiveDependentsOf("leaf/src/lib.rs").filter(path => tests.has(path)), ["app/src/lib.rs", "app/tests/api.rs", "consumer/src/lib.rs", "consumer/tests/api.rs", "leaf/tests/api.rs"]);
    assert.deepEqual(graph.transitiveDependentsOf("app/src/lib.rs").filter(path => tests.has(path)), ["app/tests/api.rs"]);
    assert.deepEqual(graph.transitiveDependentsOf("other/Cargo.toml").filter(path => tests.has(path)), ["other/src/lib.rs", "other/tests/api.rs"]);
    const noResolve = analyzeRustMetadata({ repoPath: root, files: Object.keys(files), profile: analyzeRepository({ repoPath: root }) }, metadata(root, packages, { resolve: null }));
    assert.ok(noResolve.blockers.some(reason => reason.includes("dependency resolution is missing")));
    const unknownDep = analyzeRustMetadata({ repoPath: root, files: Object.keys(files), profile: analyzeRepository({ repoPath: root }) }, metadata(root, packages, { resolve: { nodes: packages.map(p => ({ id: p.id, dependencies: ["unknown"] })) } }));
    assert.ok(unknownDep.blockers.some(reason => reason.includes("dependency resolution is missing")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Cargo build scripts, proc macros and feature-gated targets retain full validation", () => {
  const files = { "Cargo.toml": manifest("app"), "src/lib.rs": "", "build.rs": "fn main() {}" };
  const root = fixture(files);
  try {
    const context = { repoPath: root, files: Object.keys(files), profile: analyzeRepository({ repoPath: root }) };
    const p = pkg(root, "", "app");
    const build = analyzeRustMetadata(context, metadata(root, [{ ...p, targets: [...p.targets, target(root, "build.rs", "build-script-build", "custom-build", false)] }]));
    assert.ok(build.blockers.some(reason => reason.includes("Cargo build scripts")));
    const procMacro = analyzeRustMetadata(context, metadata(root, [{ ...p, targets: [target(root, "src/lib.rs", "app", "proc-macro")] }]));
    assert.ok(procMacro.blockers.some(reason => reason.includes("procedural macros")));
    const features = analyzeRustMetadata(context, metadata(root, [{ ...p, targets: [{ ...p.targets[0]!, "required-features": ["extra"] }] }]));
    assert.ok(features.blockers.some(reason => reason.includes("targets requiring features")));
    const unified = analyzeRustMetadata(context, metadata(root, [{ ...p, dependencies: [{ name: "dependency", features: ["extra"], uses_default_features: true }] }]));
    assert.ok(unified.blockers.some(reason => reason.includes("feature unification")));
    const forwarded = analyzeRustMetadata(context, metadata(root, [{ ...p, features: { default: ["dependency/extra"] } }]));
    assert.ok(forwarded.blockers.some(reason => reason.includes("feature unification")));
    const noDefault = analyzeRustMetadata(context, metadata(root, [{ ...p, dependencies: [{ name: "dependency", features: [], uses_default_features: false }] }]));
    assert.ok(noDefault.blockers.some(reason => reason.includes("feature unification")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Rust includes model literal crate-local inputs and reject external or computed paths", () => {
  const files = { "Cargo.toml": '[workspace]\nmembers = ["app", "other"]\n', "app/Cargo.toml": manifest("app"),
    "app/src/lib.rs": 'const A: &str = include_str /* nested /* comment */ comment */ ! (r#"../data.txt"#);',
    "app/data.txt": "hello", "other/Cargo.toml": manifest("other"), "other/src/lib.rs": "", "other/data.txt": "outside" };
  const root = fixture(files);
  try {
    const context = { repoPath: root, files: Object.keys(files), profile: analyzeRepository({ repoPath: root }) };
    const output = metadata(root, [pkg(root, "app", "app"), pkg(root, "other", "other")]);
    const literal = analyzeRustMetadata(context, output);
    assert.deepEqual(literal.blockers, []);
    assert.deepEqual(literal.assetPaths, ["app/data.txt"]);
    assert.ok(literal.edges.some(edge => edge.from === "app/src/lib.rs" && edge.to === "app/data.txt"));
    for (const source of ['const A: &str = include_str!("../../other/data.txt");', 'include!(concat!(env!("OUT_DIR"), "/generated.rs"));', '#[path = "../../other/src/lib.rs"] mod external;', 'use std::include_str as renamed; const A: &str = renamed!("../../other/data.txt");', 'const A: &str = include_str!("missing.txt");']) {
      writeFileSync(join(root, "app/src/lib.rs"), source);
      assert.ok(analyzeRustMetadata(context, output).blockers.some(reason => /Rust (?:runtime inputs|include outside)/.test(reason)), source);
    }
    writeFileSync(join(root, "app/src/lib.rs"), '// include!("outside.rs");\nconst TEXT: &str = r###"include_str!(\"missing\")"###;\n');
    assert.deepEqual(analyzeRustMetadata(context, output).blockers, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Rust runtime reads and non-rs included code cannot hide cross-crate inputs", () => {
  const files = { "Cargo.toml": '[workspace]\nmembers=["app", "other"]\n', "app/Cargo.toml": manifest("app"), "app/src/lib.rs": "",
    "app/src/body.inc": 'const VALUE: &str = include_str!("../../other/src/lib.rs");', "other/Cargo.toml": manifest("other"), "other/src/lib.rs": "" };
  const root = fixture(files);
  try {
    const context = { repoPath: root, files: Object.keys(files), profile: analyzeRepository({ repoPath: root }) };
    const output = metadata(root, [pkg(root, "app", "app"), pkg(root, "other", "other")]);
    for (const source of ['include!("body.inc");', 'fn read() { std::fs::read_to_string("../other/src/lib.rs").unwrap(); }', 'use std::fs as filesystem; fn read() { filesystem::read("../other/src/lib.rs").unwrap(); }', 'fn exists() -> bool { std::path::Path::new("../other/src/lib.rs").is_file() }']) {
      writeFileSync(join(root, "app/src/lib.rs"), source);
      assert.ok(analyzeRustMetadata(context, output).blockers.some(reason => /Rust (?:runtime inputs|include code)/.test(reason)), source);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("registry dependencies, symlinked modules and discovery-excluded Rust sources fail closed", (t) => {
  const files = { "Cargo.toml": manifest("app"), "src/lib.rs": "mod helper;", "src/helper.rs": "pub fn helper() {}" };
  const root = fixture(files);
  try {
    const context = { repoPath: root, files: Object.keys(files), profile: analyzeRepository({ repoPath: root }) };
    const app = pkg(root, "", "app");
    const external = { ...pkg(root, "registry/glob", "glob"), source: "registry+https://github.com/rust-lang/crates.io-index" };
    const registry = analyzeRustMetadata(context, metadata(root, [app, external], { workspace_members: [app.id] }));
    assert.ok(registry.blockers.some(reason => reason.includes("opaque runtime inputs")));
    const hidden = analyzeRustMetadata({ ...context, files: context.files.filter(file => file !== "src/helper.rs") }, metadata(root, [app]));
    assert.ok(hidden.blockers.some(reason => reason.includes("Incomplete Rust source inventory")));
    try { symlinkSync(join(root, "src/helper.rs"), join(root, "src/alias.rs")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") { t.diagnostic("symlink privilege unavailable"); return; } throw error; }
    const alias = analyzeRustMetadata(context, metadata(root, [app]));
    assert.ok(alias.blockers.some(reason => reason.includes("Incomplete Rust source inventory")));
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
    assert.equal(spawnSync("cargo", ["generate-lockfile", "--offline"], { cwd: root, encoding: "utf8", windowsHide: true }).status, 0);
    const lock = readFileSync(join(root, "Cargo.lock"), "utf8");
    const result = rustAdapter.analyze({ repoPath: root, files: [...Object.keys(files), "Cargo.lock"], profile: analyzeRepository({ repoPath: root }) });
    assert.deepEqual(result.blockers, []);
    assert.equal(result.testPackages[`${child}/tests/check.rs`], "child");
    assert.equal(readFileSync(join(root, "Cargo.toml"), "utf8"), files["Cargo.toml"]);
    assert.equal(readFileSync(join(root, "Cargo.lock"), "utf8"), lock);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Cargo executable maps a single crate", { skip: !cargoAvailable }, () => {
  const files = { "Cargo.toml": manifest("single"), "src/lib.rs": "#[cfg(test)] mod tests { #[test] fn works() {} }", "tests/api.rs": "#[test] fn works() {}" };
  const root = fixture(files);
  try {
    assert.equal(spawnSync("cargo", ["generate-lockfile", "--offline"], { cwd: root, encoding: "utf8", windowsHide: true }).status, 0);
    const lock = readFileSync(join(root, "Cargo.lock"), "utf8");
    const result = rustAdapter.analyze({ repoPath: root, files: [...Object.keys(files), "Cargo.lock"], profile: analyzeRepository({ repoPath: root }) });
    assert.deepEqual(result.blockers, []);
    assert.deepEqual(result.testPackages, { "src/lib.rs": "single", "tests/api.rs": "single" });
    assert.equal(readFileSync(join(root, "Cargo.lock"), "utf8"), lock);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Cargo executable includes optional and dev-dependencies without changing Cargo.lock", { skip: !cargoAvailable }, () => {
  const files = { "Cargo.toml": '[workspace]\nmembers=["leaf", "consumer", "app"]\nresolver="2"\n',
    "leaf/Cargo.toml": manifest("leaf"), "leaf/src/lib.rs": "pub fn leaf() {}",
    "consumer/Cargo.toml": manifest("consumer") + '\n[dependencies]\nleaf = { path = "../leaf", optional = true }\n', "consumer/src/lib.rs": '#[cfg(feature="leaf")] pub fn consumer() { leaf::leaf(); }',
    "app/Cargo.toml": manifest("app") + '\n[dev-dependencies]\nconsumer = { path = "../consumer" }\n', "app/src/lib.rs": "" };
  const root = fixture(files);
  try {
    assert.equal(spawnSync("cargo", ["generate-lockfile", "--offline"], { cwd: root, encoding: "utf8", windowsHide: true }).status, 0);
    const lock = readFileSync(join(root, "Cargo.lock"), "utf8");
    const result = rustAdapter.analyze({ repoPath: root, files: [...Object.keys(files), "Cargo.lock"], profile: analyzeRepository({ repoPath: root }) });
    assert.deepEqual(result.blockers, []);
    assert.ok(result.edges.some(edge => edge.from === "consumer/Cargo.toml" && edge.to === "leaf/Cargo.toml"));
    assert.ok(result.edges.some(edge => edge.from === "app/Cargo.toml" && edge.to === "consumer/Cargo.toml"));
    assert.equal(readFileSync(join(root, "Cargo.lock"), "utf8"), lock);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Cargo configuration cannot silently change the metadata command or build context", () => {
  const files = { "Cargo.toml": manifest("app"), "src/lib.rs": "", ".cargo/config.toml": '[build]\nrustc-wrapper = "./wrapper"\n' };
  const root = fixture(files);
  try {
    const context = { repoPath: root, files: Object.keys(files), profile: analyzeRepository({ repoPath: root }) };
    assert.ok(rustAdapter.analyze(context).blockers.some(reason => reason.includes("Custom Cargo configuration")));
    assert.ok(analyzeRustMetadata(context, metadata(root, [pkg(root, "", "app")])).blockers.some(reason => reason.includes("Custom Cargo configuration")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Cargo feature-unified unit tests keep the full original invocation", { skip: !cargoAvailable }, () => {
  const files = { "Cargo.toml": '[workspace]\nmembers=["a", "b"]\nresolver="2"\n',
    "a/Cargo.toml": manifest("a") + '\n[features]\nextra=[]\n', "a/src/lib.rs": '#[cfg(all(test, feature="extra"))]\n#[test]\nfn feature_unified_test() {}\n',
    "b/Cargo.toml": manifest("b") + '\n[dependencies]\na={path="../a",features=["extra"]}\n', "b/src/lib.rs": "" };
  const root = fixture(files);
  try {
    assert.equal(spawnSync("cargo", ["generate-lockfile", "--offline"], { cwd: root, encoding: "utf8", windowsHide: true }).status, 0);
    const full = spawnSync("cargo", ["test", "--offline", "--locked", "--", "--list"], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 60_000 });
    assert.equal(full.status, 0, full.stderr);
    assert.match(full.stdout, /feature_unified_test: test/);
    const result = rustAdapter.analyze({ repoPath: root, files: [...Object.keys(files), "Cargo.lock"], profile: analyzeRepository({ repoPath: root }) });
    assert.ok(result.blockers.some(reason => reason.includes("feature unification")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
