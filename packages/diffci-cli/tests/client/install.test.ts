import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { addDiffciPackageScripts, detectPackageManager, installDiffci, installPlan } from "../../src/client/install.js";

function fixture(pkg: object = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "diffci-install-"));
  writeFileSync(join(dir, "package.json"), `${JSON.stringify(pkg)}\n`, "utf8");
  return dir;
}

describe("DiffCI dependency installation", () => {
  it("adds stable package scripts without replacing existing commands and is idempotent", () => {
    const dir = fixture({ scripts: { test: "node --test", "diffci:check": "custom-check" } });
    try {
      assert.deepEqual(addDiffciPackageScripts(dir), {
        added: ["diffci:verify", "diffci:observe"],
        kept: ["diffci:check"],
      });
      assert.deepEqual(addDiffciPackageScripts(dir), {
        added: [],
        kept: ["diffci:verify", "diffci:check", "diffci:observe"],
      });
      const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { scripts: Record<string, string> };
      assert.deepEqual(manifest.scripts, {
        test: "node --test",
        "diffci:check": "custom-check",
        "diffci:verify": "diffci verify --changed --json",
        "diffci:observe": "diffci observe --no-send",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prefers the packageManager declaration and creates an exact pnpm dev-dependency command", () => {
    const dir = fixture({ packageManager: "pnpm@10.17.1" });
    try {
      writeFileSync(join(dir, "package-lock.json"), "{}\n", "utf8");
      assert.equal(detectPackageManager(dir), "pnpm");
      assert.deepEqual(installPlan(dir, "1.2.3", "linux"), {
        manager: "pnpm",
        command: "pnpm",
        args: ["add", "--save-dev", "--save-exact", "--ignore-scripts", "@diffci.com/diffci@1.2.3"],
        packageSpec: "@diffci.com/diffci@1.2.3",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects lockfiles, defaults to npm, and invokes Windows package-manager shims through cmd.exe", () => {
    const yarnDir = fixture();
    const npmDir = fixture();
    try {
      writeFileSync(join(yarnDir, "yarn.lock"), "", "utf8");
      assert.equal(detectPackageManager(yarnDir), "yarn");
      assert.match(installPlan(npmDir, "2.0.0", "win32").command.toLowerCase(), /(?:cmd|cmd\.exe)$/);
      assert.deepEqual(installPlan(npmDir, "2.0.0", "win32").args, [
        "/d", "/s", "/c", "npm.cmd install --save-dev --save-exact --ignore-scripts @diffci.com/diffci@2.0.0",
      ]);
    } finally {
      rmSync(yarnDir, { recursive: true, force: true });
      rmSync(npmDir, { recursive: true, force: true });
    }
  });

  it("refuses ambiguous lockfiles instead of modifying the wrong dependency graph", () => {
    const dir = fixture();
    try {
      writeFileSync(join(dir, "package-lock.json"), "{}\n", "utf8");
      writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
      assert.throws(() => detectPackageManager(dir), /multiple package-manager lockfiles/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("performs a real npm install, preserves the manifest, writes the lockfile, and is idempotent", () => {
    const parent = mkdtempSync(join(tmpdir(), "diffci-install-e2e-"));
    const packageDir = join(parent, "package");
    const consumerDir = join(parent, "consumer");
    mkdirSync(packageDir);
    mkdirSync(consumerDir);
    try {
      writeFileSync(join(packageDir, "package.json"), `${JSON.stringify({ name: "@diffci.com/diffci", version: "9.8.7", main: "index.js" })}\n`, "utf8");
      writeFileSync(join(packageDir, "index.js"), "export {};\n", "utf8");
      writeFileSync(join(consumerDir, "package.json"), `${JSON.stringify({ name: "consumer", private: true, scripts: { test: "node --test" }, dependencies: { yaml: "2.9.0" } }, null, 2)}\n`, "utf8");

      const pack = process.platform === "win32"
        ? execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm.cmd pack --json"], { cwd: packageDir, encoding: "utf8" })
        : execFileSync("npm", ["pack", "--json"], { cwd: packageDir, encoding: "utf8" });
      const tarball = join(packageDir, (JSON.parse(pack) as Array<{ filename: string }>)[0]!.filename);

      for (let attempt = 0; attempt < 2; attempt++) {
        const { result } = installDiffci(consumerDir, "9.8.7", undefined, tarball);
        assert.equal(result.status, 0, result.stderr);
      }

      const manifest = JSON.parse(readFileSync(join(consumerDir, "package.json"), "utf8")) as {
        scripts: Record<string, string>;
        dependencies: Record<string, string>;
        devDependencies: Record<string, string>;
      };
      assert.equal(manifest.scripts.test, "node --test");
      assert.equal(manifest.dependencies.yaml, "2.9.0");
      assert.match(manifest.devDependencies["@diffci.com/diffci"], /^file:/);
      const lock = JSON.parse(readFileSync(join(consumerDir, "package-lock.json"), "utf8")) as { packages?: Record<string, unknown> };
      assert.ok(lock.packages?.["node_modules/@diffci.com/diffci"]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
