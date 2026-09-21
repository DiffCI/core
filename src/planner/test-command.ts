/**
 * Turning a selection of test files into a command the TARGET repository could actually run
 * (Phase 01, 2026-08-26).
 *
 * WHY THIS EXISTS. `selective-commands.ts` describes one repository: this one. It splits paths on
 * `ops/` and `scripts/` prefixes and emits `tsx --conditions react-server --test <paths>` - DiffCI's
 * own runner, carrying a `react-server` condition inherited from DentalPresence's Next.js layout.
 * Pointed at an external repository it produces a command that is confidently wrong. Measured on the
 * Phase 01 baseline: for `unjs/h3`, DiffCI narrowed five commits to exactly `test/security.test.ts` -
 * a correct selection - and then proposed
 *
 *     tsx --conditions react-server --test test/security.test.ts
 *
 * for a vitest suite. The same shape came out for `typeorm/typeorm`, a mocha repository. Analysis
 * that is portable and execution that is not is worse than neither, because the selection looks
 * right.
 *
 * WHAT REPLACES IT. Every input here comes from the target repository's own declarations: which
 * frameworks it depends on or invokes, which runner configs it has and which globs they claim, and
 * which package manager its lockfile implies. Nothing is inferred from directory names.
 *
 * WHEN IT CANNOT TELL, IT REFUSES. A repository with no recognisable framework, or selected files no
 * config or framework will claim, yields no command and a stated reason - which leaves the caller to
 * fall back to the full suite. Guessing a runner would produce a plan that silently runs nothing and
 * reports success, which is the same failure this phase fixed in discovery.
 */
import type { PackageManager, RepositoryProfile } from "../repo/types.js";
import type { TestRunnerConfig } from "../repo/test-discovery.js";
import { matchesGlob } from "../repo/test-discovery.js";
import { END_TO_END_FRAMEWORKS, type KnownTestFramework } from "../repo/test-framework.js";
import type { CommandSpec } from "./types.js";

export interface SelectiveTestCommandGroup {
  /** Stable identifier for the group - the runner, plus the config file when one applies. */
  runnerId: string;
  label: string;
  commandSpec: CommandSpec;
  paths: string[];
}

export interface SelectiveTestCommandPlan {
  commands: CommandSpec[];
  groups: SelectiveTestCommandGroup[];
  /** Selected paths no group could claim. Non-empty means the plan does not cover the selection. */
  unroutedPaths: string[];
  /** Set when no complete plan could be produced. The caller must treat this as "cannot run a
   * subset" and fall back, never as "there is nothing to run". */
  refusalReason?: string;
}

interface RunnerInvocation {
  binary: string;
  leadingArgs: string[];
  configFlag?: string;
  /** How the runner takes the list of files. Most accept them positionally; cypress wants a single
   * comma-separated `--spec`, and getting that wrong produces a command that runs the wrong specs
   * rather than one that fails loudly. */
  pathStyle?: "positional" | "comma-separated-spec-flag";
}

/** How each runner takes a list of test files, and whether it accepts a config file. */
const RUNNER_INVOCATION: Record<KnownTestFramework, RunnerInvocation> = {
  vitest: { binary: "vitest", leadingArgs: ["run"], configFlag: "--config" },
  jest: { binary: "jest", leadingArgs: [], configFlag: "--config" },
  mocha: { binary: "mocha", leadingArgs: [], configFlag: "--config" },
  ava: { binary: "ava", leadingArgs: [] },
  tap: { binary: "tap", leadingArgs: [] },
  "node:test": { binary: "node", leadingArgs: ["--test"] },
  jasmine: { binary: "jasmine", leadingArgs: [] },
  "bun:test": { binary: "bun", leadingArgs: ["test"] },
  playwright: { binary: "playwright", leadingArgs: ["test"], configFlag: "--config" },
  cypress: { binary: "cypress", leadingArgs: ["run"], configFlag: "--config-file", pathStyle: "comma-separated-spec-flag" },
};

/**
 * How to reach a locally-installed binary with each package manager. Every one of these resolves to
 * the same `node_modules/.bin` entry; the package-manager-native form is used because it is what the
 * repository's own contributors and CI would type, and because pnpm's default layout makes the raw
 * path non-obvious.
 */
function execPrefix(packageManager: PackageManager, binary: string): { executable: string; args: string[] } {
  switch (packageManager) {
    case "pnpm":
      return { executable: "pnpm", args: ["exec", binary] };
    case "yarn":
      return { executable: "yarn", args: ["run", binary] };
    case "bun":
      return { executable: "bunx", args: [binary] };
    case "npm":
    case "unknown":
    default:
      return { executable: "npx", args: ["--no-install", binary] };
  }
}

/** Runners that are the runtime itself rather than an installed dependency, so they are invoked
 * directly rather than through a package manager's binary resolution. */
function isDirectlyInvoked(framework: KnownTestFramework): boolean {
  return framework === "node:test" || framework === "bun:test";
}

function frameworkOfConfig(config: TestRunnerConfig): KnownTestFramework {
  return config.runner;
}

function buildCommand(
  framework: KnownTestFramework,
  packageManager: PackageManager,
  configFile: string | undefined,
  paths: string[],
): CommandSpec {
  const invocation = RUNNER_INVOCATION[framework];
  const configArgs = configFile && invocation.configFlag ? [invocation.configFlag, configFile] : [];
  const pathArgs =
    invocation.pathStyle === "comma-separated-spec-flag" ? ["--spec", paths.join(",")] : [...paths];

  if (isDirectlyInvoked(framework)) {
    return { executable: invocation.binary, args: [...invocation.leadingArgs, ...configArgs, ...pathArgs] };
  }
  const prefix = execPrefix(packageManager, invocation.binary);
  return { executable: prefix.executable, args: [...prefix.args, ...invocation.leadingArgs, ...configArgs, ...pathArgs] };
}

/**
 * Routes each selected test to the runner configuration that claims it, then emits one command per
 * group. A repository with `vitest.config.ts` and `vitest.e2e.config.ts` gets two commands, because
 * running an e2e suite under the unit config is not the same job - the family distinction that
 * test-discovery.ts already models is carried through to execution rather than flattened.
 */
export function planSelectiveTestCommands(
  profile: RepositoryProfile,
  selectedPaths: readonly string[],
): SelectiveTestCommandPlan {
  const blockers = profile.adapterBlockers ?? profile.adapters?.flatMap((adapter) => adapter.blockers) ?? [];
  if (blockers.length) return { commands: [], groups: [], unroutedPaths: [...selectedPaths], refusalReason: blockers.join("; ") };
  const goPaths = selectedPaths.filter((path) => path.endsWith(".go"));
  if (goPaths.length) {
    const packages = profile.goTestPackages ?? {};
    const unclaimed = goPaths.filter((path) => !Object.hasOwn(packages, path));
    if (unclaimed.length) return { commands: [], groups: [], unroutedPaths: unclaimed, refusalReason: "Go test files require verified package metadata" };
    const jsPlan = planSelectiveTestCommands(profile, selectedPaths.filter((path) => !path.endsWith(".go")));
    if (jsPlan.refusalReason) return jsPlan;
    const targets = [...new Set(goPaths.map((path) => packages[path]))].sort();
    if (targets.some((target) => target !== "." && (!target.startsWith("./") || target.split("/").includes("..") || /[\\\r\n]/.test(target)))) {
      return { commands: [], groups: [], unroutedPaths: goPaths, refusalReason: "Invalid Go package target" };
    }
    const commandSpec: CommandSpec = {
      executable: "go", args: ["test", "-mod=readonly", "-json", "-count=1", ...targets],
      env: { ...profile.goTestEnvironment, GOTOOLCHAIN: "local", GOPROXY: "off", GOSUMDB: "off", GOWORK: "off" },
    };
    const group: SelectiveTestCommandGroup = { runnerId: "go:test", label: "Go package tests", paths: [...goPaths].sort(), commandSpec };
    return { commands: [...jsPlan.commands, commandSpec], groups: [...jsPlan.groups, group], unroutedPaths: [] };
  }
  const paths = [...selectedPaths].sort();
  if (paths.length === 0) return { commands: [], groups: [], unroutedPaths: [] };

  const frameworks = profile.testUniverse?.declaredFrameworks ?? [];
  const configs = profile.testRunnerConfigs ?? [];

  if (frameworks.length === 0 && configs.length === 0) {
    return {
      commands: [],
      groups: [],
      unroutedPaths: paths,
      refusalReason:
        "Repository declares no recognised test framework; DiffCI cannot construct a command that would run a subset of its tests",
    };
  }

  const remaining = new Set(paths);
  const groups: SelectiveTestCommandGroup[] = [];

  // A config with explicit include globs is the strongest statement a repository makes about which
  // command runs which files, so those claims are honoured first.
  for (const config of configs) {
    if (config.includes.length === 0) continue;
    const claimed = paths.filter((p) => remaining.has(p) && config.includes.some((glob) => matchesGlob(p, glob)));
    if (claimed.length === 0) continue;
    for (const p of claimed) remaining.delete(p);
    const framework = frameworkOfConfig(config);
    groups.push({
      runnerId: `${framework}:${config.file}`,
      label: `${framework} (${config.file})`,
      commandSpec: buildCommand(framework, profile.packageManager, config.file, claimed),
      paths: claimed,
    });
  }

  // Everything else goes to the repository's primary framework under its default configuration. A
  // repository with both vitest and playwright has two real frameworks; routing an unclaimed unit
  // test to the e2e runner would produce a command that runs nothing, so e2e runners are only ever
  // chosen when the repository declares nothing else.
  if (remaining.size > 0) {
    const unitFrameworks = frameworks.filter((f) => !END_TO_END_FRAMEWORKS.has(f));
    const primary =
      unitFrameworks[0] ?? frameworks[0] ?? (configs[0] ? frameworkOfConfig(configs[0]) : undefined);
    if (primary === undefined) {
      return {
        commands: groups.map((g) => g.commandSpec),
        groups,
        unroutedPaths: Array.from(remaining).sort(),
        refusalReason: "No framework claims the remaining selected tests",
      };
    }
    const rest = Array.from(remaining).sort();
    groups.push({
      runnerId: primary,
      label: `${primary} (default configuration)`,
      commandSpec: buildCommand(primary, profile.packageManager, undefined, rest),
      paths: rest,
    });
  }

  return { commands: groups.map((g) => g.commandSpec), groups, unroutedPaths: [] };
}

function shellEscape(arg: string): string {
  return arg.replace(/([\s'"\\$|&;<>(){}\[\]*?#~`])/g, "\\$1");
}

export function commandSpecToString(spec: CommandSpec): string {
  const environment = Object.entries(spec.env ?? {}).map(([key, value]) => `${shellEscape(key)}=${shellEscape(value)}`);
  return [...environment, spec.executable, ...spec.args.map(shellEscape)].join(" ");
}
