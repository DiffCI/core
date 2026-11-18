// SPDX-License-Identifier: MIT
/** Berry eligibility and selection through committed synthetic repositories. */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { analyzeCheckout } from "../../src/analyze.js";
import { analyzeGitDelta } from "../../src/git/git-diff.js";
import { berryLockAffectedDependencies, berryNodeModulesConfig, berryRuntimeConfig } from "../../src/repo/yarn-berry-lockfile.js";

const manifest = JSON.stringify({ name: "fixture", private: true, type: "module", packageManager: "yarn@4.9.2", scripts: { test: "node --test" }, dependencies: { app: "^1.0.0" } });
const entry = (key: string, name: string, version: string, extra = "") => `${JSON.stringify(key)}:\n  version: ${version}\n  resolution: "${name}@npm:${version}"\n${extra}  languageName: node\n  linkType: hard\n`;
const lock = (version = "1.0.0") => `__metadata:\n  version: 8\n  cacheKey: 10c0\n` + entry("app@npm:^1.0.0", "app", "1.0.0", '  dependencies:\n    shared: "npm:~1.0.0"\n') + entry("shared@npm:^1.0.0, shared@npm:~1.0.0", "shared", version);
type Files = Record<string, string | undefined>;
const write = (dir: string, files: Files) => {
  for (const [path, value] of Object.entries(files)) {
    const file = join(dir, path);
    if (value === undefined) { rmSync(file, { force: true }); continue; }
    mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, value);
  }
};
const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
const commit = (dir: string) => { git(dir, "add", "."); git(dir, "commit", "-qm", "fixture"); return git(dir, "rev-parse", "HEAD"); };
async function fixture(initial: Files, changes: Files, check: (result: Awaited<ReturnType<typeof analyzeCheckout>>, dir: string, base: string, head: string) => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "diffci-berry-"));
  try {
    git(dir, "init", "-q"); git(dir, "config", "user.name", "Fixture"); git(dir, "config", "user.email", "fixture@example.invalid"); git(dir, "config", "commit.gpgsign", "false"); git(dir, "config", "core.autocrlf", "false");
    write(dir, { "package.json": manifest, "yarn.lock": lock(), ".yarnrc.yml": "nodeLinker: node-modules\n", ".gitignore": "node_modules/\n", "src/app.test.js": 'import test from "node:test"; import "app"; test("app", () => {});\n', "src/unrelated.test.js": 'import test from "node:test"; test("unrelated", () => {});\n', ...initial });
    const base = commit(dir); write(dir, changes); const head = commit(dir);
    await check(await analyzeCheckout({ repoPath: dir, base, head }), dir, base, head);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

it("Berry attributes a transitive bump through a grouped key's second descriptor", async () => {
  await fixture({}, { "yarn.lock": lock("1.0.1") }, (result) => {
    assert.equal(result.impact.fallbackRequired, false);
    assert.deepEqual(result.plan.selectedTests, ["src/app.test.js"]);
  });
});

it("Berry attributes a direct npm resolution bump", async () => {
  const direct = (v: string) => `__metadata:\n  version: 8\n` + entry("app@npm:^1.0.0", "app", v);
  await fixture({ "yarn.lock": direct("1.0.0") }, { "yarn.lock": direct("1.0.1") }, (result) => {
    assert.equal(result.impact.fallbackRequired, false);
    assert.deepEqual(result.plan.selectedTests, ["src/app.test.js"]);
  });
});

it("widens a transitive change to every declared root while excluding unrelated tests", async () => {
  const tree = (v: string) => lock(v) + entry("other@npm:^1.0.0", "other", "1.0.0");
  await fixture({ "package.json": JSON.stringify({ ...JSON.parse(manifest), dependencies: { app: "^1.0.0", other: "^1.0.0" } }), "yarn.lock": tree("1.0.0"), "src/other.test.js": 'import test from "node:test"; import "other"; test("other", () => {});\n' }, { "yarn.lock": tree("1.0.1") }, (result) => {
    assert.equal(result.impact.fallbackRequired, false);
    assert.deepEqual(result.plan.selectedTests, ["src/app.test.js", "src/other.test.js"]);
  });
});

for (const config of [undefined, "", "nodeLinker: pnp\n", "nodeLinker: pnpm\n", "[node-modules]", "nodeLinker: [", "nodeLinker: ${LINKER}\n"]) {
  it(`Berry keeps full fallback for unproven linker ${JSON.stringify(config)}`, async () => {
    await fixture({ ".yarnrc.yml": config }, { "yarn.lock": lock("1.0.1") }, (result) => assert.equal(result.plan.mode, "FULL"));
  });
}

for (const [name, broken] of [
  ["missing later descriptor", lock("1.0.1").replace(", shared@npm:~1.0.0", "")],
  ["workspace protocol", lock("1.0.1").replaceAll("shared@npm:", "shared@workspace:")],
  ["patch protocol", lock("1.0.1").replaceAll("shared@npm:", "shared@patch:")],
  ["malformed YAML", lock("1.0.1") + "bad: ["],
]) {
  it(`Berry keeps full fallback for ${name}`, async () => {
    await fixture({}, { "yarn.lock": broken }, (result) => assert.equal(result.plan.mode, "FULL"));
  });
}

const affected = (before: string, after: string, direct: Record<string, string> = { app: "^1.0.0" }) => berryLockAffectedDependencies(before, after, direct, direct, "fixture", "fixture");
it("indexes all grouped descriptors as the same reachable entry", () => {
  assert.deepEqual(affected(lock(), lock("1.0.1")), ["app"]);
  assert.deepEqual(affected(lock(), lock().replace("app@npm:^1.0.0", "app@npm:^1.0.0, app@npm:~1.0.0")), ["app"]);
});
for (const [version, cacheKey] of [[4, 7], [6, 8], [8, "10c0"]]) {
  it(`accepts format ${version} with its generated cache key and unprefixed dependency requests`, () => {
    const formatted = (v: string) => lock(v).replace("version: 8", `version: ${version}`).replace("cacheKey: 10c0", `cacheKey: ${cacheKey}`).replace('"npm:~1.0.0"', '"~1.0.0"');
    assert.deepEqual(affected(formatted("1.0.0"), formatted("1.0.1")), ["app"]);
  });
}
it("ignores comments and mapping order but preserves content and metadata changes", () => {
  assert.deepEqual(affected(lock(), "# comment\n" + lock().replaceAll("\n", "\r\n")), []);
  assert.equal(affected(lock(), lock().replace("10c0", "10c1")), undefined);
  const checksum = `  checksum: ${"a".repeat(128)}\n`;
  const before = lock().replace("  languageName: node", checksum + "  languageName: node");
  assert.deepEqual(affected(before, before.replace("a".repeat(128), "b".repeat(128))), ["app"]);
});

for (const [name, broken] of [
  ["duplicate selector", lock("1.0.1") + entry("app@npm:^1.0.0", "app", "1.0.0")],
  ["overlapping grouped selector", lock("1.0.1") + entry("shared@npm:~1.0.0", "shared", "1.0.1")],
  ["mixed names in a group", lock("1.0.1").replace(", shared@npm:~", ", wrong@npm:~")],
  ["missing unchanged edge", lock("1.0.1") + entry("unused@npm:^1.0.0", "unused", "1.0.0", '  dependencies:\n    absent: "npm:^1.0.0"\n')],
  ["unreachable change", lock() + entry("unused@npm:^1.0.0", "unused", "1.0.0")],
  ["alias edge", lock("1.0.1").replace('"npm:~1.0.0"', '"npm:other@~1.0.0"')],
  ["portal protocol", lock("1.0.1").replaceAll("shared@npm:", "shared@portal:")],
  ["unknown field", lock("1.0.1").replace("  languageName: node", "  futureSetting: true\n  languageName: node")],
  ["peer metadata", lock("1.0.1").replace("  languageName: node", '  peerDependencies:\n    peer: "*"\n  languageName: node')],
  ["soft npm link", lock("1.0.1").replace("linkType: hard", "linkType: soft")],
  ["mismatched resolution", lock("1.0.1").replace("app@npm:1.0.0", "wrong@npm:1.0.0")],
  ["unknown format", lock("1.0.1").replace("version: 8", "version: 99")],
  ["non-scalar cache key", lock("1.0.1").replace("cacheKey: 10c0", "cacheKey: [8]")],
  ["infinite cache key", lock("1.0.1").replace("cacheKey: 10c0", "cacheKey: .inf")],
  ["NaN cache key", lock("1.0.1").replace("cacheKey: 10c0", "cacheKey: .nan")],
  ["YAML tag", lock("1.0.1").replace("languageName: node", "languageName: !!str node")],
  ["YAML anchor", lock("1.0.1").replace("languageName: node", "languageName: &language node")],
  ["non-object YAML", "[1, 2, 3]"],
]) {
  it(`parser refuses ${name} on either revision`, () => {
    assert.equal(affected(lock(), broken), undefined);
    assert.equal(affected(broken, lock()), undefined);
  });
}

it("requires exact manifest requests and supports scoped npm requests", () => {
  assert.equal(affected(lock(), lock("1.0.1"), { app: "^2.0.0" }), undefined);
  const before = lock().replaceAll("app@npm:", "@scope/app@npm:");
  assert.deepEqual(affected(before, lock("1.0.1").replaceAll("app@npm:", "@scope/app@npm:"), { "@scope/app": "npm:^1.0.0" }), ["@scope/app"]);
});

const project = '"fixture@workspace:.":\n  version: 0.0.0-use.local\n  resolution: "fixture@workspace:."\n  dependencies:\n    app: "npm:^1.0.0"\n  languageName: unknown\n  linkType: soft\n';
it("validates the generated singleton project record without accepting workspace dependencies", () => {
  assert.deepEqual(affected(lock() + project, lock("1.0.1") + project), ["app"]);
  assert.equal(affected(lock() + project, lock("1.0.1") + project.replace("npm:^1.0.0", "npm:^2.0.0")), undefined);
  assert.equal(affected(lock(), lock("1.0.1") + project.replaceAll("workspace:.", "workspace:packages/app")), undefined);
});

it("does not guess configuration values or ignore environment overrides", () => {
  assert.equal(berryNodeModulesConfig("nodeLinker: node-modules", {}), true);
  for (const key of ["YARN_NODE_LINKER", "yarn_node_linker", "Yarn_Node_Linker", "YARN_RC_FILENAME", "YARN_PLUGINS"]) {
    for (const value of ["pnp", "node-modules", ""]) assert.equal(berryNodeModulesConfig("nodeLinker: node-modules", { [key]: value }), false);
  }
  for (const config of ["nodeLinker: node-modules\nnodeLinker: pnp", "nodeLinker: node-modules\nplugins: []", "nodeLinker: &mode node-modules", "nodeLinker: !!str node-modules", "nodeLinker: ${LINKER:-node-modules}", "---\nnodeLinker: node-modules\n---\nnodeLinker: pnp"]) assert.equal(berryNodeModulesConfig(config, {}), false);
});

it("retains full fallback when the actual planning process has a Yarn override", async () => {
  const saved = process.env.YARN_NODE_LINKER;
  process.env.YARN_NODE_LINKER = "pnp";
  try { await fixture({}, { "yarn.lock": lock("1.0.1") }, (result) => assert.equal(result.plan.mode, "FULL")); }
  finally { if (saved === undefined) delete process.env.YARN_NODE_LINKER; else process.env.YARN_NODE_LINKER = saved; }
});

for (const [name, initial, changes] of [
  ["linker change", {}, { ".yarnrc.yml": "nodeLinker: pnp\n" }],
  ["deleted linker proof", {}, { ".yarnrc.yml": undefined }],
  ["deleted alternate layout", { ".pnp.cjs": "// previous PnP" }, { ".pnp.cjs": undefined }],
  ["environment injection file", { ".env.yarn": "YARN_NODE_LINKER=pnp\n" }, {}],
  ["workspaces manifest", { "package.json": manifest.replace('"private":true', '"private":true,"workspaces":[]') }, {}],
  ["CI linker override", { ".github/workflows/test.yml": "jobs:\n  test:\n    env:\n      YARN_NODE_LINKER: pnp\n" }, {}],
  ["shell linker override", { "scripts/test.sh": "YARN_NODE_LINKER=pnp yarn install\n" }, {}],
  ["nested Yarn config", { "src/.yarnrc.yml": "nodeLinker: pnp\n" }, {}],
  ["undeclared import", { "src/undeclared.test.js": 'import "shared";\n' }, {}],
  ["simultaneous unrelated data", { "settings.json": '{"value":1}\n' }, { "settings.json": '{"value":2}\n' }],
] as Array<[string, Files, Files]>) {
  it(`retains full fallback for ${name}`, async () => {
    await fixture(initial, { "yarn.lock": lock("1.0.1"), ...changes }, (result) => assert.equal(result.plan.mode, "FULL"));
  });
}

it("selects raw lockfile readers even for a comment-only change", async () => {
  await fixture({ "src/lock.test.js": 'import { readFileSync } from "node:fs"; import test from "node:test"; test("lock", () => readFileSync("yarn.lock", "utf8"));\n' }, { "yarn.lock": "# comment\n" + lock() }, (result) => {
    assert.equal(result.impact.fallbackRequired, false);
    assert.deepEqual(result.plan.selectedTests, ["src/lock.test.js"]);
  });
});

it("refuses inherited configuration and untracked environment injection", () => {
  const parent = mkdtempSync(join(tmpdir(), "diffci-berry-config-"));
  const dir = join(parent, "checkout");
  try {
    write(dir, { ".yarnrc.yml": "nodeLinker: node-modules\n" });
    assert.equal(berryRuntimeConfig(dir), true);
    write(parent, { ".yarnrc.yml": "plugins: []\n" });
    assert.equal(berryRuntimeConfig(dir), false);
    rmSync(join(parent, ".yarnrc.yml"));
    write(dir, { ".env.yarn": "YARN_NODE_LINKER=pnp\n" });
    assert.equal(berryRuntimeConfig(dir), false);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

it("requires the actual checkout's linker proof even when committed settings are supported", async () => {
  await fixture({}, { "yarn.lock": lock("1.0.1") }, async (_result, dir, base, head) => {
    write(dir, { ".yarnrc.yml": "nodeLinker: pnp\n" });
    const result = await analyzeGitDelta({ repoPath: dir, baseSha: base, headSha: head });
    assert.ok(result.success);
    assert.equal(result.delta.analysis.lockfileChanged, true);
    assert.equal(result.delta.analysis.dependencyLockfile, undefined);
  });
});
