// SPDX-License-Identifier: AGPL-3.0-only
/**
 * What an operation is FOR, derived from structure rather than from text that happens to contain a
 * framework's name.
 *
 * CI_REPRODUCTION_SAMPLE_01 produced two false TEST classifications on two unrelated repositories, from
 * the same rule (`infer.ts:63`, `/\b(jest|vitest|mocha|ava)\b/` applied to the whole command line):
 *
 *   gh issue close $ISSUE --comment "…https://github.com/jestjs/jest/blob/…"   → classified TEST
 *   git apply test/patches/jest-worker+30.4.1.patch                            → classified TEST
 *
 * One is an issue-closing command, the other applies a patch. In both the executable is not a test
 * runner at all; a *substring* of an argument was. So DiffCI planned an issue-triage job as jest's test
 * pipeline, and a Deno runtime job as webpack's.
 *
 * The rule this file replaces it with:
 *
 *   **Incidental text may not establish purpose. Only the executable position, or a script the
 *   repository itself declares, may.**
 *
 * Evidence strength is explicit, because "we recognised a command" and "we guessed from a filename" are
 * different claims and only one of them should license a plan.
 */

/** How a purpose was established. Ordered strongest first; `NONE` means nothing established it. */
export type PurposeBasis =
  /** The binary being invoked is a test runner / compiler / linter. The strongest signal available. */
  | "EXECUTABLE_POSITION"
  /** `npm run x` where the repository's own `scripts.x` body resolves to a recognised command. */
  | "SCRIPT_BODY"
  /** `npm run x` where `x` is declared by the repository and its NAME is conventional (`test:*`). */
  | "SCRIPT_NAME"
  | "NONE";

export type OperationPurpose = "install" | "build" | "lint" | "typecheck" | "test" | "security" | "generate" | "unknown";

export interface PurposeVerdict {
  purpose: OperationPurpose;
  basis: PurposeBasis;
  /** What was actually looked at, so a receipt can show the derivation rather than assert it. */
  evidence: string;
}

/** Shell operators that end one command and begin another. */
const COMMAND_SEPARATOR = /\s*(?:\|\||&&|\||;)\s*/;

/**
 * The tokens of the FIRST command on a line, even when the line as a whole is not safe argv.
 *
 * This is the layering rule made concrete: `yarn cover:integration:a --ci … || yarn … -f` cannot become
 * safe argv, and webpack's integration job therefore lost its TEST purpose entirely — 31 job instances
 * reporting `provides: ["INSTALL"]` while the real suite ran 57,666 tests. Failing to build argv is a
 * statement about the EXECUTOR. It must not delete what the step is for.
 */
export function firstCommandTokens(line: string): string[] {
  const [first = ""] = line.trim().split(COMMAND_SEPARATOR);
  return first.split(/\s+/).filter(Boolean);
}

/** `node_modules/.bin/jest` and `./scripts/x.js` reduce to `jest` and `x.js`. */
function basename(token: string): string {
  const cleaned = token.replace(/\\/g, "/");
  return cleaned.slice(cleaned.lastIndexOf("/") + 1);
}

/**
 * One `KEY=value` prefix, consumed as a single unit even when the value is quoted and contains
 * whitespace — `NODE_OPTIONS="--a --b"` must not fragment into `NODE_OPTIONS="--a` and `--b"` the way a
 * plain whitespace split would.
 */
const LEADING_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)/;

export interface NormalizedCommand {
  /** `KEY=value` prefixes stripped from the front, in order — execution environment, not identity. */
  assignments: string[];
  /** Tokens of what remains: the executable and its arguments. Empty for an assignment-only line. */
  tokens: string[];
}

/**
 * SEMANTIC_REPAIR_02, step 2. Leading shell environment assignments modify the execution environment;
 * they do not determine the executable identity. `NODE_OPTIONS="--experimental-vm-modules" yarn jest`
 * must expose the identical executable/package-manager semantics as `yarn jest` — jest's own
 * `jest-runtime-vm-modules` script is written exactly this way, and before this function existed neither
 * `executableChain` nor `packageManagerCommand` ever saw past the assignment to find `yarn` at all,
 * because `firstCommandTokens` is a plain whitespace split and the assignment became (a broken fragment
 * of) the line's first token.
 *
 * Operates on the RAW LINE, not on already-split tokens, specifically so a quoted value survives intact
 * — tokenising first and asking "is this token an assignment" second can never recover a value that
 * contained whitespace, because the damage (an extra, spurious token) is already done.
 *
 * LEADING ONLY: stops at the first token that is not itself an assignment, so `yarn jest FOO=bar` —
 * where `FOO=bar` is an ARGUMENT to jest, not an environment prefix — is untouched; this function never
 * scans past the first non-assignment token looking for one. An assignment-only line (nothing follows
 * the last assignment) yields empty `tokens`, never treating the last `KEY` as a program to run.
 */
export function normalizeExecutable(line: string): NormalizedCommand {
  const assignments: string[] = [];
  let rest = line.trimStart();
  for (let m = LEADING_ASSIGNMENT.exec(rest); m; m = LEADING_ASSIGNMENT.exec(rest)) {
    assignments.push(m[0]);
    rest = rest.slice(m[0].length).trimStart();
  }
  return { assignments, tokens: firstCommandTokens(rest) };
}

/** Runners invoked directly. Matched against the EXECUTABLE, never against arguments. */
const EXECUTABLE_PURPOSE: Array<[RegExp, OperationPurpose]> = [
  [/^(jest|vitest|mocha|ava|jasmine|tap|karma|cypress|playwright)(\.(js|cjs|mjs))?$/i, "test"],
  [/^(tsc|tsgo)$/i, "typecheck"],
  [/^(eslint|biome|oxlint|standard)$/i, "lint"],
  [/^(webpack|rollup|vite|esbuild|tsup|parcel)$/i, "build"],
];

/**
 * Node's OWN built-in test runner, stable since Node 20 - the one recognised runner that is a FLAG on a
 * generic interpreter rather than a program with its own name. Every other `EXECUTABLE_PURPOSE` entry is
 * matched against the executable position, which `executableChain` deliberately never inspects past
 * (flags are skipped, not read); `node --test` needs a check of its own for exactly that reason.
 *
 * Any `--test*` flag (`--test`, `--test-only`, `--test-name-pattern=...`, …) puts `node` in test-runner
 * mode per Node's own documented behaviour, so this does not require the bare `--test` flag specifically.
 */
const NODE_TEST_RUNNER = /^--test\b/;

function isNodeTestRunner(tokens: string[]): boolean {
  return /^node(\.exe)?$/i.test(basename(tokens[0] ?? "")) && tokens.slice(1).some((t) => NODE_TEST_RUNNER.test(t));
}

/** Package managers whose next tokens name a script rather than a program. */
const PACKAGE_MANAGER = /^(npm|yarn|pnpm|bun|corepack)$/i;

const INSTALL_SUBCOMMAND = /^(ci|install|i|add|up|upgrade)$/i;

/**
 * Every OTHER built-in verb yarn and pnpm recognise, none of them a script.
 *
 * `yarn <token>` and `pnpm <token>` fall back to `run <token>` only when `<token>` is not one of the
 * package manager's own commands — real yarn and pnpm always give the built-in priority over a
 * same-named script, so `yarn link` runs yarn's linker even in a repository that happens to declare a
 * script called `link`. `INSTALL_SUBCOMMAND` above is the subset of this surface that also means
 * `purpose: install`; this is everything else that still means "not a script", which SEMANTIC_REPAIR_02
 * needed once `infer.ts` started asking the same "is this a script?" question this file already answers.
 * `npm` and `bun` are unaffected: this codebase's grammar requires their literal `run` keyword, so they
 * are never ambiguous with a built-in the way the optional-`run` shorthand is.
 */
const PACKAGE_MANAGER_BUILTIN =
  /^(access|audit|autoclean|bin|cache|check|config|create|dedupe|deploy|dlx|doctor|env|exec|generate-lock-entry|global|help|import|info|init|licenses|link|list|ls|login|logout|node|outdated|owner|pack|patch|patch-commit|plugin|policies|prune|publish|rebuild|remove|root|self-update|server|set|setup|store|tag|team|unlink|unplug|version|why|whoami|workspace|workspaces)$/i;

/** Script NAMES the ecosystem uses conventionally. Acceptable only for a script the repo declares. */
const SCRIPT_NAME_PURPOSE: Array<[RegExp, OperationPurpose]> = [
  [/^test(:|$)/i, "test"],
  [/^(unit|e2e|spec|jest|vitest|mocha)$/i, "test"],
  [/^(build|compile|bundle|prepack|prepare)(:|$)/i, "build"],
  [/^(lint|eslint)(:|$)/i, "lint"],
  [/^(typecheck|tsc|types|check-types)(:|$)/i, "typecheck"],
  [/^(generate|codegen|prebuild)(:|$)/i, "generate"],
  [/^(audit|security)(:|$)/i, "security"],
];

/**
 * Commands that execute another command, contributing no purpose of their own.
 *
 * `nyc --reporter=json jest --ci` is a TEST operation; the coverage wrapper is bookkeeping around the
 * runner. Stopping at `nyc` is how webpack's `cover:integration:a` body would still have looked
 * purposeless after the substring rule was removed — the defect would have survived its own fix.
 */
const COMMAND_WRAPPER = /^(nyc|c8|istanbul|cross-env|dotenv|env-cmd|retry|nice|time|xvfb-run)$/i;

/** An interpreter whose first non-flag argument is the real program. */
const INTERPRETER = /^(node|npx|bunx|deno|ts-node|tsx)$/i;

/** `KEY=value` prefixes, as `cross-env` and bare shell assignments both produce. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Subcommands a wrapper takes before the program it wraps, e.g. `istanbul cover mocha`. */
const WRAPPER_SUBCOMMAND = /^(cover|exec|run)$/i;

/**
 * Walks past wrappers, interpreters, flags and assignments to the token that is really being run.
 *
 * Only ever advances while the tokens so far are *recognised* wrappers, interpreters or their
 * subcommands. It never scans arbitrary arguments — that is precisely the substring behaviour being
 * removed, and `git apply …jest-worker.patch` stops dead at `git` because `git` is not a wrapper.
 */
function executableChain(tokens: string[]): string[] {
  const chain: string[] = [];
  let afterWrapper = false;
  for (let i = 0; i < tokens.length && chain.length < 4; i += 1) {
    const token = tokens[i]!;
    if (token.startsWith("-") || ASSIGNMENT.test(token)) continue;
    const name = basename(token);
    if (afterWrapper && WRAPPER_SUBCOMMAND.test(name)) continue;
    chain.push(token);
    const isWrapper = COMMAND_WRAPPER.test(name) || INTERPRETER.test(name);
    if (!isWrapper) break;
    afterWrapper = true;
  }
  return chain;
}

function purposeOfExecutable(token: string): OperationPurpose | undefined {
  const name = basename(token);
  for (const [pattern, purpose] of EXECUTABLE_PURPOSE) if (pattern.test(name)) return purpose;
  return undefined;
}

/** What kind of package-manager command a line is, before anyone asks what it's FOR. */
export interface PackageManagerCommand {
  head: string;
  /** The first non-flag token after the package manager, when there is one — kept for receipts. */
  sub?: string;
  /**
   * `install`      — a dependency operation (`yarn`, `yarn ci`, `yarn add x`, bare flags only).
   * `builtin`      — a recognised non-script command (`yarn link`, `pnpm why`, …).
   * `script`       — `<pm> run <name>`, or `<pm> <name>` where `<name>` is neither of the above.
   * `unknown`      — a package manager with nothing after it this rule can classify (e.g. `yarn run`
   *                  alone, with no script name following).
   */
  kind: "install" | "builtin" | "script" | "unknown";
  /** Present only when `kind === "script"`. Existence in package.json is a SEPARATE question — this is
   *  the syntactic claim "this line's FORM invokes a script named X", nothing more. */
  scriptName?: string;
}

/**
 * SEMANTIC_REPAIR_02. The single parse of "is this a package-manager script invocation, and if so what
 * is its name" — every caller that needs that answer, `purposeOfLine` and `infer.ts` alike, must consume
 * THIS, never re-derive it. Before this repair `infer.ts` asked the identical question with its own
 * regex (`SCRIPT_RUN`), which had no `INSTALL_SUBCOMMAND` exclusion and no built-in awareness, so
 * `yarn --frozen-lockfile`, `yarn install` and `yarn link webpack` were each resolved as invocations of
 * scripts named `--frozen-lockfile`, `install` and `link` — correctly absent from every package.json,
 * and cited as a blocking prerequisite for an operation that was never a script call at all.
 *
 * Takes already-normalised tokens (`normalizeExecutable(line).tokens`), never a raw line. This function
 * is the package-manager SEMANTIC classifier; teaching it to also strip shell prefixes would start
 * turning it into a shell parser. Normalisation is a separate, earlier step both this and
 * `executableChain` consume — never re-derived independently by either.
 */
export function packageManagerCommand(tokens: string[]): PackageManagerCommand | undefined {
  if (tokens.length === 0) return undefined;
  const [head, ...rest] = tokens as [string, ...string[]];
  if (!PACKAGE_MANAGER.test(basename(head))) return undefined;

  // A package manager with NO non-flag argument is a bare install: `yarn` and `yarn --immutable` both
  // install, which is how jest and babel-loader begin. Requiring a subcommand missed them.
  const nonFlags = rest.filter((t) => !t.startsWith("-"));
  const sub = nonFlags[0];
  if (sub === undefined || INSTALL_SUBCOMMAND.test(sub)) {
    return { head, sub, kind: "install" };
  }

  // `run`/`run-script` explicitly requests a declared script and is never ambiguous with a built-in —
  // yarn and npm both accept it as a literal prefix regardless of what name follows.
  if (/^run(-script)?$/i.test(sub)) {
    const scriptName = nonFlags[1];
    return scriptName ? { head, sub, kind: "script", scriptName } : { head, sub, kind: "unknown" };
  }

  // Without `run`, yarn/pnpm shorthand `<pm> <token>` invokes a declared script named `<token>` UNLESS
  // `<token>` is itself one of the package manager's own built-ins, which always take priority over a
  // same-named script.
  if (PACKAGE_MANAGER_BUILTIN.test(sub)) {
    return { head, sub, kind: "builtin" };
  }

  return { head, sub, kind: "script", scriptName: sub };
}

/**
 * Resolves what a line is for.
 *
 * `lookupScript` returns the body of a script the repository declares, or undefined. It is injected so
 * this module never touches the filesystem and can be tested exhaustively.
 *
 * `depth` bounds script-to-script recursion; a cycle yields `unknown` rather than hanging.
 */
export function purposeOfLine(line: string, lookupScript: (name: string) => string | undefined, depth = 0): PurposeVerdict {
  // Normalised ONCE: leading `KEY=value` assignments stripped, so both the wrapper/interpreter walk and
  // the package-manager classifier see the same executable-identifying tokens, agreeing by construction
  // rather than by coincidence.
  const { tokens } = normalizeExecutable(line);
  if (tokens.length === 0) return { purpose: "unknown", basis: "NONE", evidence: "empty command" };

  // Node's native test runner: a flag, not a name, so it must be checked before the name-only walk below
  // ever discards it. `babel-loader`'s real test step is exactly this shape: `node --test test/**/*.js`.
  if (isNodeTestRunner(tokens)) {
    const flag = tokens.find((t) => NODE_TEST_RUNNER.test(t));
    return { purpose: "test", basis: "EXECUTABLE_POSITION", evidence: `\`node ${flag}\`` };
  }

  // Walk past coverage wrappers and interpreters: `nyc … jest`, `node ./node_modules/.bin/jest --ci`.
  for (const candidate of executableChain(tokens)) {
    const direct = purposeOfExecutable(candidate);
    if (direct) return { purpose: direct, basis: "EXECUTABLE_POSITION", evidence: `executable \`${basename(candidate)}\`` };
  }

  const pm = packageManagerCommand(tokens);
  if (pm?.kind === "install") {
    return { purpose: "install", basis: "EXECUTABLE_POSITION", evidence: `\`${[basename(pm.head), pm.sub].filter(Boolean).join(" ")}\`` };
  }

  if (pm?.kind === "script" && pm.scriptName) {
    const scriptName = pm.scriptName;
    const body = lookupScript(scriptName);
    if (body !== undefined && depth < 5) {
      const nested = purposeOfLine(body, lookupScript, depth + 1);
      if (nested.purpose !== "unknown") {
        return { purpose: nested.purpose, basis: "SCRIPT_BODY", evidence: `script \`${scriptName}\` → ${nested.evidence}` };
      }
    }
    // The repository declares this script, so its NAME is the repository's own statement of intent.
    // Only ever consulted for a script that exists - a name alone proves nothing about a script that
    // does not.
    if (body !== undefined) {
      for (const [pattern, purpose] of SCRIPT_NAME_PURPOSE) {
        if (pattern.test(scriptName)) return { purpose, basis: "SCRIPT_NAME", evidence: `declared script named \`${scriptName}\`` };
      }
    }
  }

  return { purpose: "unknown", basis: "NONE", evidence: `no recognised executable or declared script in \`${tokens.slice(0, 3).join(" ")}\`` };
}

/**
 * May this verdict license a plan?
 *
 * `SCRIPT_NAME` is admitted because the repository declared that script itself. `NONE` never is — and
 * the substring rule that produced both of the sample's false positives cannot even be expressed here,
 * because no basis corresponds to "the text mentioned a framework somewhere".
 */
export function establishesPurpose(verdict: PurposeVerdict): boolean {
  return verdict.purpose !== "unknown" && verdict.basis !== "NONE";
}
