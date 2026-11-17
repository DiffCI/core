import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  const members = (extra.workspace_members as string[] | undefined) ?? packages.map(pkg => pkg.id);
  return JSON.stringify({ workspace_root: root, workspace_members: members, workspace_default_members: members, packages, resolve: { nodes: packages.map(pkg => ({ id: pkg.id, dependencies: [] })) }, ...extra });
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

test("an excluded nested Cargo package cannot silently become part of its parent, and blocks only if something depends on it", () => {
  const files = { "Cargo.toml": manifest("root"), "src/lib.rs": "", "excluded/Cargo.toml": manifest("excluded"),
    "excluded/src/lib.rs": "", "excluded/tests/api.rs": "" };
  const root = fixture(files);
  try {
    const result = analyzeRustMetadata({ repoPath: root, files: Object.keys(files), profile: analyzeRepository({ repoPath: root }) }, metadata(root, [pkg(root, "", "root")]));
    // No package depends on it, so its files stay unmodelled (a change to them keeps the full suite)
    // without blocking the repository.
    assert.deepEqual(result.blockers, []);
    assert.ok(!result.sourcePaths.includes("excluded/src/lib.rs"));
    assert.ok(!result.testFiles.includes("excluded/tests/api.rs"));
    const excluded = pkg(root, "excluded", "excluded");
    const used = analyzeRustMetadata({ repoPath: root, files: Object.keys(files), profile: analyzeRepository({ repoPath: root }) }, metadata(root, [pkg(root, "", "root"), excluded], { workspace_members: [`path+${root}/#root@0.1.0`] }));
    assert.ok(used.blockers.some(reason => reason.includes("Cargo manifests outside workspace membership") && reason.includes("excluded/Cargo.toml")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Cargo maps a checkout reached through a symlinked directory", (t) => {
  const files = {
    "Cargo.toml": manifest("example"), "src/lib.rs": "#[cfg(test)] mod tests {}",
    "tests/api.rs": "#[test] fn test_api() {}",
  };
  const root = fixture(files);
  const links = mkdtempSync(join(tmpdir(), "diffci-rust-link-"));
  const linked = join(links, "repo");
  try {
    try {
      if (process.platform === "win32") symlinkSync(root, linked, "junction");
      else symlinkSync(root, linked);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES" || process.platform === "win32") {
        t.diagnostic("symlink privilege unavailable; skipping symlinked-checkout coverage");
        return;
      }
      throw error;
    }
    const physical = realpathSync(root);
    const p = pkg(physical, "", "example", [target(physical, "src/lib.rs", "example"), target(physical, "tests/api.rs", "api", "test")]);
    const result = analyzeRustMetadata({
      repoPath: linked, files: Object.keys(files), profile: analyzeRepository({ repoPath: linked }),
    }, metadata(physical, [p]));
    assert.deepEqual(result.blockers, []);
    assert.deepEqual(result.testPackages, { "src/lib.rs": "example", "tests/api.rs": "example" });
    assert.deepEqual(result.testFiles, ["src/lib.rs", "tests/api.rs"]);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(links, { recursive: true, force: true }); }
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

test("workspace build scripts are scoped to their crate; proc macros and feature-gated targets", () => {
  const files: Record<string, string> = { "Cargo.toml": '[workspace]\nmembers = ["gen", "leaf", "other"]\n' };
  for (const name of ["gen", "leaf", "other"]) Object.assign(files, { [`${name}/Cargo.toml`]: manifest(name), [`${name}/src/lib.rs`]: "", [`${name}/tests/api.rs`]: "#[test] fn works() {}" });
  files["gen/build.rs"] = 'fn main() { println!("cargo:rerun-if-changed=build.rs"); let _ = std::fs::read_dir("."); }';
  const root = fixture(files);
  try {
    const context = { repoPath: root, files: Object.keys(files), profile: analyzeRepository({ repoPath: root }) };
    const packages = ["gen", "leaf", "other"].map(name => pkg(root, name, name, [target(root, `${name}/src/lib.rs`, name), target(root, `${name}/tests/api.rs`, "api", "test")]));
    packages[0]!.targets.push(target(root, "gen/build.rs", "build-script-build", "custom-build", false));
    const build = analyzeRustMetadata(context, metadata(root, packages));
    assert.deepEqual(build.blockers, []);
    assert.ok(build.sourcePaths.includes("gen/build.rs"));
    const tests = new Set(build.testFiles);
    const graph = hydrateDependencyGraph({ nodes: build.sourcePaths.map(path => ({ path, isSource: true, isAsset: false, isTest: tests.has(path), isEntryPoint: false })), edges: build.edges } as unknown as DependencyGraph, root);
    // The build-script crate runs for any Rust change; crates without one still narrow.
    assert.deepEqual(graph.transitiveDependentsOf("leaf/src/lib.rs").filter(path => tests.has(path)), ["gen/src/lib.rs", "gen/tests/api.rs", "leaf/tests/api.rs"]);
    assert.deepEqual(graph.transitiveDependentsOf("gen/build.rs").filter(path => tests.has(path)), ["gen/src/lib.rs", "gen/tests/api.rs"]);
    assert.ok(!graph.transitiveDependentsOf("leaf/src/lib.rs").includes("other/tests/api.rs"));
    const procMacro = analyzeRustMetadata(context, metadata(root, [packages[0]!, { ...packages[1]!, targets: [target(root, "leaf/src/lib.rs", "leaf", "proc-macro")] }, packages[2]!]));
    assert.deepEqual(procMacro.blockers, []);
    const featureTarget = analyzeRustMetadata(context, metadata(root, [packages[0]!, { ...packages[1]!, targets: [{ ...packages[1]!.targets[0]!, "required-features": ["extra"] }] }, packages[2]!]));
    assert.ok(featureTarget.blockers.some(reason => reason.includes("targets requiring features")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("feature requests need Cargo's own feature resolution, not a repository-wide blocker", () => {
  const files = { "Cargo.toml": '[workspace]\nmembers = ["a", "b"]\n', "a/Cargo.toml": manifest("a"), "a/src/lib.rs": "", "b/Cargo.toml": manifest("b"), "b/src/lib.rs": "" };
  const root = fixture(files);
  try {
    const context = { repoPath: root, files: Object.keys(files), profile: analyzeRepository({ repoPath: root }) };
    const a = pkg(root, "a", "a"), b = pkg(root, "b", "b");
    const plain = analyzeRustMetadata(context, metadata(root, [a, b]));
    assert.deepEqual(plain.blockers, []);
    assert.deepEqual(plain.rustFeatureCoverage, { deficits: {}, units: [] });
    const requested = [a, { ...b, dependencies: [{ name: "a", features: ["extra"], uses_default_features: true }] }];
    for (const variant of [requested, [{ ...a, features: { default: ["serde?/std"] } }, b], [a, { ...b, dependencies: [{ name: "a", features: [], uses_default_features: false }] }]]) {
      assert.ok(analyzeRustMetadata(context, metadata(root, variant)).blockers.includes("Cargo feature resolution is unavailable; full validation required"));
    }
    const resolve = { nodes: [{ id: a.id, dependencies: [] }, { id: b.id, dependencies: [a.id] }] };
    const trees: Record<string, string> = {
      "a": `a v0.1.0 (${root}/a)|\n`,
      "b": `b v0.1.0 (${root}/b)|\na v0.1.0 (${root}/a)|extra\n`,
      "a b": `a v0.1.0 (${root}/a)|extra\n\nb v0.1.0 (${root}/b)|\na v0.1.0 (${root}/a)|extra (*)\n`,
    };
    const asked: string[][] = [];
    const resolver = (units: string[][]) => {
      asked.push(...units);
      return { workspace: trees["a b"]!, units: units.map(crates => ({ crates, tree: trees[crates.join(" ")]! })) };
    };
    const resolved = analyzeRustMetadata(context, metadata(root, requested, { resolve }), resolver);
    assert.deepEqual(resolved.blockers, []);
    assert.deepEqual(asked.map(unit => unit.join(" ")).sort(), ["a", "a b", "b"]);
    // Testing `a` alone drops `extra`; `b` alone, or `a` with its dependent `b`, keeps it.
    assert.deepEqual(resolved.rustFeatureCoverage, { deficits: { a: ["a v0.1.0"] }, units: [{ crates: ["a", "b"], covers: ["a v0.1.0"] }, { crates: ["b"], covers: ["a v0.1.0"] }] });
    const failed = analyzeRustMetadata(context, metadata(root, requested, { resolve }), () => undefined);
    assert.ok(failed.blockers.some(reason => reason.includes("feature resolution is unavailable")));
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
      assert.ok(analyzeRustMetadata(context, output).blockers.some(reason => /Rust (?:computed includes|include outside)/.test(reason)), source);
    }
    writeFileSync(join(root, "app/src/lib.rs"), '// include!("outside.rs");\nconst TEXT: &str = r###"include_str!(\"missing\")"###;\n');
    assert.deepEqual(analyzeRustMetadata(context, output).blockers, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("byte and C raw strings cannot hide an include or path attribute", () => {
  const files = { "Cargo.toml": '[workspace]\nmembers = ["app", "other"]\n', "app/Cargo.toml": manifest("app"), "app/src/lib.rs": "",
    "other/Cargo.toml": manifest("other"), "other/src/lib.rs": "" };
  const root = fixture(files);
  try {
    const context = { repoPath: root, files: Object.keys(files), profile: analyzeRepository({ repoPath: root }) };
    const output = metadata(root, [pkg(root, "app", "app"), pkg(root, "other", "other")]);
    // A raw string takes no escapes, so its closing quote follows the backslash. The trailing comment
    // keeps the quote count even, as an editor or rustfmt would leave it.
    for (const prefix of ["br", "cr", "br#", "cr#"]) {
      const close = prefix.endsWith("#") ? '"#' : '"';
      for (const hidden of ['include!(concat!(env!("OUT_DIR"), "/generated.rs"));', '#[path = "../../other/src/lib.rs"] mod external;']) {
        writeFileSync(join(root, "app/src/lib.rs"), `pub const P: &[u8] = ${prefix}"\\${close};\n${hidden}\n// "\n`);
        assert.ok(analyzeRustMetadata(context, output).blockers.some(reason => reason.includes("Rust computed includes or path attributes")), `${prefix}: ${hidden}`);
      }
    }
    writeFileSync(join(root, "app/src/lib.rs"), 'pub const P: &[u8] = br#"include_str!("missing") and \\"#;\npub const C: &core::ffi::CStr = cr"\\";\n');
    assert.deepEqual(analyzeRustMetadata(context, output).blockers, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Rust runtime reads of another crate become dependencies; non-rs included code still falls back", () => {
  const files = { "Cargo.toml": '[workspace]\nmembers=["app", "other", "third"]\n', "app/Cargo.toml": manifest("app"), "app/src/lib.rs": "",
    "app/src/body.inc": 'const VALUE: &str = include_str!("../../other/src/lib.rs");', "other/Cargo.toml": manifest("other"), "other/src/lib.rs": "",
    "third/Cargo.toml": manifest("third"), "third/src/lib.rs": "" };
  const root = fixture(files);
  try {
    const context = { repoPath: root, files: Object.keys(files), profile: analyzeRepository({ repoPath: root }) };
    const output = metadata(root, [pkg(root, "app", "app"), pkg(root, "other", "other"), pkg(root, "third", "third")]);
    writeFileSync(join(root, "app/src/lib.rs"), 'include!("body.inc");');
    assert.ok(analyzeRustMetadata(context, output).blockers.some(reason => reason.includes("Rust include code with a non-Rust extension")));
    const reads = (source: string) => {
      writeFileSync(join(root, "app/src/lib.rs"), source);
      const result = analyzeRustMetadata(context, output);
      assert.deepEqual(result.blockers, [], source);
      return result.edges.filter(edge => edge.from === "app/Cargo.toml" && edge.to !== "app/src/lib.rs").map(edge => edge.to).sort();
    };
    for (const source of ['fn read() { std::fs::read_to_string("../other/src/lib.rs").unwrap(); }',
      'use std::fs as filesystem; fn read() { filesystem::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../other/src/lib.rs")).unwrap(); }',
      'fn exists() -> bool { std::path::Path::new("../other/src/lib.rs").is_file() }', 'fn list() { let _ = glob::glob("../other/**/*.rs"); }']) {
      assert.deepEqual(reads(source), ["other/Cargo.toml"], source);
    }
    assert.deepEqual(reads('fn all() { let _ = std::fs::read_dir(".."); }'), ["other/Cargo.toml", "third/Cargo.toml"]);
    assert.deepEqual(reads('fn build() { std::process::Command::new("cargo").arg("build").status().unwrap(); }'), ["other/Cargo.toml", "third/Cargo.toml"]);
    assert.deepEqual(reads('fn build() { std::process::Command::new(env!("CARGO")).status().unwrap(); }'), ["other/Cargo.toml", "third/Cargo.toml"]);
    // Paths built in code that climb out of the crate can reach any crate without a literal naming it
    // (review on #92): they depend on every workspace crate, like code that runs Cargo.
    for (const source of [
      'use std::path::Path; fn scan() { let p = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("other").join("src").join("lib.rs"); std::fs::read_to_string(p).unwrap(); }',
      'use std::path::Path; fn scan() { let p = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("other/src/lib.rs"); std::fs::read_to_string(p).unwrap(); }',
      'use std::path::Path; fn scan() { let root = Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(1).unwrap(); for entry in std::fs::read_dir(root).unwrap() { let _ = entry; } }',
      'fn scan(name: &str) { std::fs::read_to_string(format!("{}/../{}/src/lib.rs", env!("CARGO_MANIFEST_DIR"), name)).unwrap(); }',
      'use std::path::PathBuf; fn scan() { let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR")); p.pop(); p.push("other"); let _ = std::fs::read_dir(p); }',
    ]) assert.deepEqual(reads(source), ["other/Cargo.toml", "third/Cargo.toml"], source);
    // Crate-local paths built from the manifest directory, and tree `parent()` without paths, still narrow.
    assert.deepEqual(reads('use std::path::Path; fn fixture() { std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("data.bin")).unwrap(); }'), []);
    assert.deepEqual(reads('struct Node; impl Node { fn parent(&self) -> Option<&Node> { None } } fn up(n: &Node) { let _ = n.parent(); let mut v = vec![1]; v.pop(); }'), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ordinary Rust code no longer blocks: fs, process, unsafe, extern crate and metadata fields", () => {
  const source = `extern crate alloc;
use std::fs::{self, File};
use std::io::Read;
use std::process;
pub struct Entry { pub metadata: u64, pub include: bool }
pub fn load(path: &std::path::Path) -> std::io::Result<String> {
    if !path.exists() || !path.is_file() { process::exit(2); }
    let mut text = String::new();
    File::open(path)?.read_to_string(&mut text)?;
    let _ = fs::metadata(path)?.len();
    Ok(text)
}
pub fn first(bytes: &[u8]) -> u8 { unsafe { *bytes.get_unchecked(0) } }
extern "C" { fn abs(input: i32) -> i32; }
pub fn magnitude(value: i32) -> i32 { unsafe { abs(value) } }
#[cfg(test)]
mod tests {
    #[test] fn reads_fixture() { assert!(std::fs::read_to_string("tests/data/input.txt").is_ok()); }
    #[test] fn content_type() { assert_eq!("application/json", "application/json"); }
}
`;
  const files = { "Cargo.toml": '[workspace]\nmembers=["app", "other"]\n', "app/Cargo.toml": manifest("app"), "app/src/lib.rs": source,
    "app/tests/data/input.txt": "x", "other/Cargo.toml": manifest("other"), "other/src/lib.rs": "" };
  const root = fixture(files);
  try {
    const result = analyzeRustMetadata({ repoPath: root, files: Object.keys(files), profile: analyzeRepository({ repoPath: root }) }, metadata(root, [pkg(root, "app", "app"), pkg(root, "other", "other")]));
    assert.deepEqual(result.blockers, []);
    assert.ok(!result.edges.some(edge => edge.from === "app/Cargo.toml" && edge.to === "other/Cargo.toml"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("registry dependencies narrow; local outside path dependencies, symlinked modules and discovery-excluded Rust sources fail closed", (t) => {
  const files = { "Cargo.toml": manifest("app"), "src/lib.rs": "mod helper;", "src/helper.rs": "pub fn helper() {}" };
  const root = fixture(files);
  try {
    const context = { repoPath: root, files: Object.keys(files), profile: analyzeRepository({ repoPath: root }) };
    const app = pkg(root, "", "app");
    const external = { ...pkg(root, "registry/glob", "glob"), source: "registry+https://github.com/rust-lang/crates.io-index" };
    // Locked registry dependencies, including build scripts and procedural macros, do not block.
    const serdeDerive = { ...pkg(root, "registry/serde_derive", "serde_derive", [target(root, "registry/serde_derive/src/lib.rs", "serde_derive", "proc-macro")]), source: "registry+https://github.com/rust-lang/crates.io-index" };
    const libc = { ...pkg(root, "registry/libc", "libc", [target(root, "registry/libc/src/lib.rs", "libc"), target(root, "registry/libc/build.rs", "build-script-build", "custom-build", false)]), source: "registry+https://github.com/rust-lang/crates.io-index" };
    const registry = analyzeRustMetadata(context, metadata(root, [app, external, serdeDerive, libc], { workspace_members: [app.id] }));
    assert.deepEqual(registry.blockers, []);
    // A local path dependency outside the workspace has no modelled ownership.
    const local = analyzeRustMetadata(context, metadata(root, [app, pkg(root, "../vendor/local", "local")], { workspace_members: [app.id] }));
    assert.ok(local.blockers.includes("Local Cargo path dependencies outside the workspace require full validation: local"));
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

test("Cargo feature-unified unit tests are recorded per crate instead of blocking the repository", { skip: !cargoAvailable }, () => {
  const files = { "Cargo.toml": '[workspace]\nmembers=["a", "b", "c"]\nresolver="2"\n',
    "a/Cargo.toml": manifest("a") + '\n[features]\nextra=[]\n', "a/src/lib.rs": '#[cfg(all(test, feature="extra"))]\n#[test]\nfn feature_unified_test() {}\n',
    "b/Cargo.toml": manifest("b") + '\n[dependencies]\na={path="../a",features=["extra"]}\n', "b/src/lib.rs": "",
    "c/Cargo.toml": manifest("c"), "c/src/lib.rs": "#[cfg(test)] mod tests { #[test] fn works() {} }" };
  const root = fixture(files);
  try {
    assert.equal(spawnSync("cargo", ["generate-lockfile", "--offline"], { cwd: root, encoding: "utf8", windowsHide: true }).status, 0);
    const full = spawnSync("cargo", ["test", "--offline", "--locked", "--", "--list"], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 60_000 });
    assert.equal(full.status, 0, full.stderr);
    assert.match(full.stdout, /feature_unified_test: test/);
    const result = rustAdapter.analyze({ repoPath: root, files: [...Object.keys(files), "Cargo.lock"], profile: analyzeRepository({ repoPath: root }) });
    assert.deepEqual(result.blockers, []);
    // Testing `a` alone would drop its `extra` feature; `b` sees `a` exactly as the full run does.
    assert.deepEqual(result.rustFeatureCoverage, { deficits: { a: ["a v0.1.0"] }, units: [{ crates: ["a", "b"], covers: ["a v0.1.0"] }, { crates: ["b"], covers: ["a v0.1.0"] }] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("symlinks outside module trees and linked non-Rust files do not block", (t) => {
  const files = { "Cargo.toml": '[workspace]\nmembers=["app"]\n', "app/Cargo.toml": manifest("app"), "app/src/lib.rs": "", "LICENSE": "MIT", "docs/guide.md": "" };
  const root = fixture(files);
  try {
    const context = { repoPath: root, files: Object.keys(files), profile: analyzeRepository({ repoPath: root }) };
    const output = metadata(root, [pkg(root, "app", "app")]);
    try {
      symlinkSync(join(root, "LICENSE"), join(root, "app/src/LICENSE"));
      symlinkSync(join(root, "docs"), join(root, "website"), process.platform === "win32" ? "junction" : undefined);
    } catch (error) {
      if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) { t.diagnostic("symlink privilege unavailable"); return; }
      throw error;
    }
    assert.deepEqual(analyzeRustMetadata(context, output).blockers, []);
    symlinkSync(join(root, "docs"), join(root, "app/src/linked"), process.platform === "win32" ? "junction" : undefined);
    assert.ok(analyzeRustMetadata(context, output).blockers.some(reason => reason.includes("Incomplete Rust source inventory")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Cargo configuration blocks only build-changing keys, wherever Cargo reads it", () => {
  const outer = mkdtempSync(join(tmpdir(), "diffci-rust-config-"));
  const root = join(outer, "repo");
  const saved = { CARGO_HOME: process.env.CARGO_HOME, RUSTDOCFLAGS: process.env.RUSTDOCFLAGS, CARGO_BUILD_TARGET: process.env.CARGO_BUILD_TARGET };
  try {
    const home = join(outer, "cargo-home");
    mkdirSync(home, { recursive: true });
    process.env.CARGO_HOME = home;
    delete process.env.RUSTDOCFLAGS; delete process.env.CARGO_BUILD_TARGET;
    const files = { "Cargo.toml": manifest("app"), "src/lib.rs": "", ".cargo/config.toml": '[alias]\nxtask = "run -p xtask --"\n[term]\ncolor = "always"\n' };
    for (const [file, content] of Object.entries(files)) { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), content); }
    const context = { repoPath: root, files: Object.keys(files), profile: analyzeRepository({ repoPath: root }) };
    const blocked = () => rustAdapter.analyze(context).blockers.some(reason => reason.includes("Custom Cargo configuration"));
    assert.deepEqual(analyzeRustMetadata(context, metadata(root, [pkg(root, "", "app")])).blockers, []);
    writeFileSync(join(home, "config.toml"), '[net]\nretry = 3\n[profile.test]\ndebug = false\n');
    assert.equal(blocked(), false);
    writeFileSync(join(home, "config.toml"), '[build]\nrustflags = ["--cfg", "custom"]\n');
    assert.equal(blocked(), true);
    rmSync(join(home, "config.toml"));
    mkdirSync(join(outer, ".cargo"));
    writeFileSync(join(outer, ".cargo/config.toml"), '[target.x86_64-unknown-linux-gnu]\nrunner = "qemu"\n');
    assert.equal(blocked(), true);
    rmSync(join(outer, ".cargo"), { recursive: true });
    for (const key of ["RUSTDOCFLAGS", "CARGO_BUILD_TARGET"] as const) {
      process.env[key] = key === "RUSTDOCFLAGS" ? "--cfg docsrs" : "wasm32-unknown-unknown";
      assert.equal(blocked(), true, key);
      delete process.env[key];
    }
    writeFileSync(join(root, ".cargo/config.toml"), '[build]\nrustc-wrapper = "./wrapper"\n');
    assert.ok(analyzeRustMetadata(context, metadata(root, [pkg(root, "", "app")])).blockers.some(reason => reason.includes("Custom Cargo configuration")));
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(outer, { recursive: true, force: true });
  }
});

test("a realistic Cargo workspace now narrows: build script, local derive crate, feature requests and file I/O", { skip: !cargoAvailable }, () => {
  const files: Record<string, string> = {
    "Cargo.toml": '[workspace]\nmembers = ["core", "derive", "cli", "server", "codegen"]\nresolver = "2"\n',
    "core/Cargo.toml": manifest("core") + '\n[features]\ndefault = ["std"]\nstd = []\nserde = []\n',
    "core/src/lib.rs": 'pub fn parse(text: &str) -> usize { text.len() }\n#[cfg(test)] mod tests { #[test] fn parses() { assert_eq!(super::parse("ab"), 2); } }\n',
    "derive/Cargo.toml": manifest("derive") + '\n[lib]\nproc-macro = true\n',
    "derive/src/lib.rs": 'extern crate proc_macro;\nuse proc_macro::TokenStream;\n#[proc_macro_derive(Named)]\npub fn named(_input: TokenStream) -> TokenStream { TokenStream::new() }\n',
    "cli/Cargo.toml": manifest("cli") + '\n[dependencies]\ncore = { path = "../core", default-features = false, features = ["serde"] }\nderive = { path = "../derive" }\n',
    "cli/src/lib.rs": 'use std::{fs, process};\npub fn run(path: &str) -> usize { match fs::read_to_string(path) { Ok(text) => core::parse(&text), Err(_) => process::exit(2) } }\npub fn first(bytes: &[u8]) -> u8 { unsafe { *bytes.get_unchecked(0) } }\n',
    "cli/tests/run.rs": '#[test] fn runs() { assert_eq!(cli::first(b"x"), b\'x\'); }\n',
    "server/Cargo.toml": manifest("server") + '\n[dependencies]\ncore = { path = "../core" }\n',
    "server/src/lib.rs": 'pub fn serve() -> usize { core::parse("ok") }\n#[cfg(test)] mod tests { #[test] fn serves() { assert_eq!(super::serve(), 2); } }\n',
    "codegen/Cargo.toml": manifest("codegen"), "codegen/build.rs": 'fn main() { println!("cargo:rerun-if-changed=build.rs"); }\n',
    "codegen/src/lib.rs": "#[cfg(test)] mod tests { #[test] fn generated() {} }\n",
  };
  const root = fixture(files);
  try {
    assert.equal(spawnSync("cargo", ["generate-lockfile", "--offline"], { cwd: root, encoding: "utf8", windowsHide: true }).status, 0);
    const result = rustAdapter.analyze({ repoPath: root, files: [...Object.keys(files), "Cargo.lock"], profile: analyzeRepository({ repoPath: root }) });
    assert.deepEqual(result.blockers, []);
    const tests = new Set(result.testFiles);
    const graph = hydrateDependencyGraph({ nodes: result.sourcePaths.map(path => ({ path, isSource: true, isAsset: false, isTest: tests.has(path), isEntryPoint: false })), edges: result.edges } as unknown as DependencyGraph, root);
    // A change to the server crate selects it and the build-script crate, not cli or core.
    assert.deepEqual(graph.transitiveDependentsOf("server/src/lib.rs").filter(path => tests.has(path)), ["codegen/src/lib.rs"]);
    assert.deepEqual(graph.transitiveDependentsOf("derive/src/lib.rs").filter(path => tests.has(path)), ["cli/src/lib.rs", "cli/tests/run.rs", "codegen/src/lib.rs"]);
    // cli asks for core without defaults; server keeps them. Testing either alone changes core's
    // features; a change to core selects core with all its dependents, which Cargo resolves exactly
    // like the full run.
    assert.deepEqual(result.rustFeatureCoverage?.deficits, { cli: ["core v0.1.0"], core: ["core v0.1.0"], server: ["core v0.1.0"] });
    assert.deepEqual(result.rustFeatureCoverage?.units, [{ crates: ["cli", "codegen", "core", "server"], covers: ["core v0.1.0"] }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("only crates plain cargo test covers are test targets (root package or default-members)", { skip: !cargoAvailable }, () => {
  for (const layout of ["root-package", "default-members"] as const) {
    const files: Record<string, string> = layout === "root-package"
      ? { "Cargo.toml": manifest("root") + '\n[workspace]\nmembers = ["member"]\n', "src/lib.rs": "#[cfg(test)] mod tests { #[test] fn root() {} }" }
      : { "Cargo.toml": '[workspace]\nmembers = ["root", "member"]\ndefault-members = ["root"]\nresolver = "2"\n', "root/Cargo.toml": manifest("root"), "root/src/lib.rs": "#[cfg(test)] mod tests { #[test] fn root() {} }" };
    Object.assign(files, { "member/Cargo.toml": manifest("member"), "member/src/lib.rs": "", "member/tests/api.rs": "#[test] fn member() {}" });
    const root = fixture(files);
    try {
      assert.equal(spawnSync("cargo", ["generate-lockfile", "--offline"], { cwd: root, encoding: "utf8", windowsHide: true }).status, 0);
      const full = spawnSync("cargo", ["test", "--offline", "--locked", "--", "--list"], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 60_000 });
      assert.equal(full.status, 0, full.stderr);
      assert.doesNotMatch(full.stdout, /member: test/, layout);
      const result = rustAdapter.analyze({ repoPath: root, files: [...Object.keys(files), "Cargo.lock"], profile: analyzeRepository({ repoPath: root }) });
      assert.deepEqual(result.blockers, [], layout);
      assert.deepEqual(Object.values(result.testPackages), ["root"], layout);
      assert.ok(result.sourcePaths.includes("member/src/lib.rs"), layout);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("Cargo metadata without default members falls back", () => {
  const files = { "Cargo.toml": manifest("app"), "src/lib.rs": "" };
  const root = fixture(files);
  try {
    const app = pkg(root, "", "app");
    const output = JSON.stringify({ ...JSON.parse(metadata(root, [app])), workspace_default_members: undefined });
    const result = analyzeRustMetadata({ repoPath: root, files: Object.keys(files), profile: analyzeRepository({ repoPath: root }) }, output);
    assert.ok(result.blockers.some(reason => reason.includes("without default workspace members")));
    assert.deepEqual(result.testFiles, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
