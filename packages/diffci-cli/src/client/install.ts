import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type SupportedPackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface InstallPlan {
  manager: SupportedPackageManager;
  command: string;
  args: string[];
  packageSpec: string;
}
export interface PackageScriptResult {
  added: string[];
  kept: string[];
}

const DIFFCI_SCRIPTS: Readonly<Record<string, string>> = {
  "diffci:verify": "diffci verify --changed --json",
  "diffci:check": "diffci check",
  "diffci:observe": "diffci observe --no-send",
};

const LOCKFILES: ReadonlyArray<readonly [SupportedPackageManager, string]> = [
  ["pnpm", "pnpm-lock.yaml"],
  ["yarn", "yarn.lock"],
  ["bun", "bun.lock"],
  ["bun", "bun.lockb"],
  ["npm", "package-lock.json"],
  ["npm", "npm-shrinkwrap.json"],
];

function declaredPackageManager(repoPath: string): SupportedPackageManager | undefined {
  const packagePath = join(repoPath, "package.json");
  if (!existsSync(packagePath)) throw new Error("--install requires a package.json in the repository root");
  const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as { packageManager?: unknown };
  if (typeof pkg.packageManager !== "string") return undefined;
  const name = pkg.packageManager.split("@", 1)[0] as SupportedPackageManager;
  if (["npm", "pnpm", "yarn", "bun"].includes(name)) return name;
  throw new Error(`unsupported packageManager ${JSON.stringify(pkg.packageManager)}; supported managers are npm, pnpm, yarn, and bun`);
}

export function detectPackageManager(repoPath: string): SupportedPackageManager {
  const declared = declaredPackageManager(repoPath);
  if (declared) return declared;

  const detected = new Set<SupportedPackageManager>();
  for (const [manager, lockfile] of LOCKFILES) {
    if (existsSync(join(repoPath, lockfile))) detected.add(manager);
  }
  if (detected.size > 1) {
    throw new Error(`multiple package-manager lockfiles found (${[...detected].join(", ")}); set packageManager in package.json to choose one`);
  }
  return detected.values().next().value ?? "npm";
}

export function installPlan(repoPath: string, version: string, platform = process.platform): InstallPlan {
  const manager = detectPackageManager(repoPath);
  const packageSpec = `@diffci.com/diffci@${version}`;
  const managerCommand = platform === "win32" ? `${manager}.cmd` : manager;
  const argsByManager: Record<SupportedPackageManager, string[]> = {
    npm: ["install", "--save-dev", "--save-exact", "--ignore-scripts", packageSpec],
    pnpm: ["add", "--save-dev", "--save-exact", "--ignore-scripts", packageSpec],
    yarn: ["add", "--dev", "--exact", "--ignore-scripts", packageSpec],
    bun: ["add", "--dev", "--exact", "--ignore-scripts", packageSpec],
  };
  const managerArgs = argsByManager[manager];
  if (platform === "win32") {
    // npm/pnpm/yarn/bun are .cmd shims on Windows. Node does not execute those reliably without
    // cmd.exe, so use its explicit /d /s /c form. Every token is generated here (not user input).
    return { manager, command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", [managerCommand, ...managerArgs].join(" ")], packageSpec };
  }
  return { manager, command: managerCommand, args: managerArgs, packageSpec };
}

export function installDiffci(
  repoPath: string,
  version: string,
  run: typeof spawnSync = spawnSync,
  packageSpecOverride?: string,
): { plan: InstallPlan; result: SpawnSyncReturns<string> } {
  const basePlan = installPlan(repoPath, version);
  const plan = packageSpecOverride === undefined
    ? basePlan
    : {
        ...basePlan,
        packageSpec: packageSpecOverride,
        args: basePlan.args.map((arg) => arg.replace(basePlan.packageSpec, packageSpecOverride)),
      };
  const result = run(plan.command, plan.args, {
    cwd: repoPath,
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
    windowsHide: true,
  }) as SpawnSyncReturns<string>;
  return { plan, result };
}

export function addDiffciPackageScripts(repoPath: string): PackageScriptResult {
  const packagePath = join(repoPath, "package.json");
  const source = readFileSync(packagePath, "utf8");
  const manifest = JSON.parse(source) as { scripts?: unknown };
  if (manifest.scripts !== undefined && (typeof manifest.scripts !== "object" || manifest.scripts === null || Array.isArray(manifest.scripts))) {
    throw new Error("package.json scripts must be an object before DiffCI scripts can be added");
  }

  const scripts = (manifest.scripts ?? {}) as Record<string, unknown>;
  const added: string[] = [];
  const kept: string[] = [];
  for (const [name, command] of Object.entries(DIFFCI_SCRIPTS)) {
    if (name in scripts) {
      kept.push(name);
      continue;
    }
    scripts[name] = command;
    added.push(name);
  }
  manifest.scripts = scripts;

  if (added.length > 0) {
    const newline = source.includes("\r\n") ? "\r\n" : "\n";
    writeFileSync(packagePath, `${JSON.stringify(manifest, null, 2)}${newline}`, "utf8");
  }
  return { added, kept };
}
