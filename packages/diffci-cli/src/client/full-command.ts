import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readRepositoryConfig } from "@diffci.com/core/repo/repo-config";
import { analyzeRepository } from "@diffci.com/core/repo/analyzer";
import { commandSpecToString, planSelectiveTestCommands } from "@diffci.com/core/planner/test-command";

/** Rebuild the complete plan locally; never join arbitrary report commands. */
export function inferWorkspaceComparison(repoPath: string, proposed: readonly string[], selectedTests: readonly string[]): { full?: string; selected?: string; reason: string } {
  const profile = analyzeRepository({ repoPath });
  if (!profile.workspaceTestPackages?.length) return { reason: "No declared workspace test suites" };
  const scripts = profile.packageJson.scripts;
  if (scripts.pretest || scripts.posttest) return { reason: "Root lifecycle hooks cannot be omitted" };
  const npm = profile.packageManager === "npm" && !scripts.test;
  const pnpm = profile.packageManager === "pnpm" && scripts.test === "pnpm -r run test";
  if (!npm && !pnpm) return { reason: "Workspace full validation scope is not recognized" };
  const plan = planSelectiveTestCommands(profile, selectedTests);
  if (plan.refusalReason || !plan.commands.length) return { reason: plan.refusalReason ?? "No workspace commands" };
  const expected = plan.commands.map(commandSpecToString);
  if (JSON.stringify(expected) !== JSON.stringify(proposed)) return { reason: "Report commands differ from the verified workspace plan" };
  // This deliberately limited shell vocabulary works on both cmd.exe and sh.
  // Unusual names require structured execution rather than guessed escaping.
  if (plan.commands.some(command => command.env || !/^[\w-]+$/.test(command.executable) || command.args.some(arg => !/^[\w./:@=-]+$/.test(arg)))) return { reason: "Workspace command contains unsupported shell arguments" };
  const full = npm ? profile.workspaceTestPackages.map(suite => `npm test --workspace=${suite.packageRoot} -- --run`).join(" && ") : "pnpm test";
  const selected = plan.commands.map(command => [command.executable, ...command.args].join(" ")).join(" && ");
  if (full.length > 6000 || selected.length > 6000) return { reason: "Complete workspace chain exceeds the safe shell command length" };
  return { full, selected, reason: "Verified workspace plan with full auxiliary validation retained" };
}

export interface FullCommandDecision {
  command?: string;
  reason: string;
}

/** Automatic timing must retain the non-selected phases of the declared test script. */
export function inferComparableSelectedCommand(repoPath: string, proposed: string, selectedTests: readonly string[]): FullCommandDecision {
  const selected = inferSelectedCommand(repoPath, proposed, selectedTests);
  if (!selected.command) return selected;
  const packagePath = join(repoPath, "package.json");
  if (!existsSync(packagePath)) return selected;
  let scripts: Record<string, unknown>;
  try { scripts = JSON.parse(readFileSync(packagePath, "utf8")).scripts ?? {}; }
  catch { return { reason: "package.json could not be read" }; }
  const script = scripts.test;
  const refusal = { reason: "Cannot prove equal validation scope for automatic timing; use explicit matched commands with verify-savings" };
  if (typeof script !== "string" || scripts.pretest || scripts.posttest) return refusal;
  if (!/\bvitest run(?:\s|$)/.test(selected.command)) {
    // Existing direct runner support remains available; compound scripts need a phase adapter.
    return /[&|;\r\n]/.test(script) ? refusal : selected;
  }
  const phases = script.split(/\s*&&\s*/);
  const runtime = phases.map((phase, index) => ({ index, match: /^vitest(?: run)?( --typecheck)?$/.exec(phase.trim()) }))
    .filter(phase => phase.match);
  if (runtime.length !== 1) return refusal;
  const target = runtime[0]!;
  // Only simple package-script invocations are retained. Shell programs, pipelines,
  // environment assignments, runner flags and multiple suites need an explicit adapter.
  if (phases.some((phase, index) => index !== target.index && !/^(?:npm|pnpm|yarn|bun) (?:run )?[\w:-]+$/.test(phase.trim()))) return refusal;
  phases[target.index] = selected.command + (target.match![1] ?? "");
  return { command: phases.join(" && "), reason: "Selected Vitest files with all declared test phases preserved" };
}

/** Preserve the repository's TypeScript test loader for selected node:test files. */
export function inferSelectedCommand(repoPath: string, proposed: string, selectedTests: readonly string[]): FullCommandDecision {
  if (!/^node --test(?:\s|$)/.test(proposed) || !selectedTests.some(path => /\.(?:ts|tsx|mts|cts)$/.test(path))) {
    return { command: proposed, reason: "DiffCI proposed command" };
  }
  const packagePath = join(repoPath, "package.json");
  if (!existsSync(packagePath)) return { reason: "TypeScript tests require a declared test loader" };
  let script: unknown;
  try { script = JSON.parse(readFileSync(packagePath, "utf8")).scripts?.test; }
  catch { return { reason: "package.json could not be read" }; }
  if (typeof script !== "string") return { reason: "TypeScript tests require a declared test script" };
  const runners = [...script.matchAll(/\btsx(?:\s+--conditions\s+[\w,-]+)?\s+--test\b/g)];
  if (runners.length !== 1) return { reason: "Cannot identify one TypeScript node:test runner in the test script" };
  return {
    command: proposed.replace(/^node --test/, `npx --no-install ${runners[0][0]}`),
    reason: "TypeScript node:test runner from package.json test script",
  };
}

/** Choose the repository's conventional full test command without executing anything. */
export function inferFullCommand(repoPath: string): FullCommandDecision {
  if (existsSync(join(repoPath, "pom.xml"))) {
    const config = readRepositoryConfig(repoPath);
    if (config.configurationError) return { reason: `DiffCI configuration error: ${config.configurationError}` };
    const goal = config.maven?.goal ?? "test";
    const profiles = config.maven?.profiles?.length ? ` -P ${config.maven.profiles.join(",")}` : "";
    return {
      command: `mvn${profiles} ${goal}`,
      reason: config.maven ? "Maven goal and profiles from DiffCI configuration" : "Maven default goal: test; confirm this matches CI",
    };
  }

  const packagePath = join(repoPath, "package.json");
  if (existsSync(packagePath)) {
    let pkg: { scripts?: { test?: unknown }; packageManager?: unknown };
    try { pkg = JSON.parse(readFileSync(packagePath, "utf8")); }
    catch { return { reason: "package.json could not be read" }; }
    if (typeof pkg.scripts?.test !== "string" || !pkg.scripts.test.trim()) {
      return { reason: "package.json has no test script" };
    }
    const manager = typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0] : undefined;
    if (manager === "pnpm" || manager === "yarn" || manager === "bun") {
      return { command: `${manager} test`, reason: `package.json test script via ${manager}` };
    }
    if (manager && manager !== "npm") return { reason: `unsupported package manager: ${manager}` };
    if (existsSync(join(repoPath, "pnpm-lock.yaml"))) return { command: "pnpm test", reason: "package.json test script with pnpm lockfile" };
    if (existsSync(join(repoPath, "yarn.lock"))) return { command: "yarn test", reason: "package.json test script with Yarn lockfile" };
    if (existsSync(join(repoPath, "bun.lock")) || existsSync(join(repoPath, "bun.lockb"))) return { command: "bun test", reason: "package.json test script with Bun lockfile" };
    return { command: "npm test", reason: "package.json test script" };
  }

  if (existsSync(join(repoPath, "go.mod"))) return { command: "go test ./...", reason: "root Go module" };
  return { reason: "no supported full test command could be inferred" };
}
