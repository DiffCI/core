/**
 * Which test framework does this repository actually use, and what does that framework consider a
 * test file? (Phase 01, 2026-08-26.)
 *
 * WHY. Before this module, "is this a test?" was answered by DiffCI's own conventions - the
 * `.test.`/`.spec.` filename infix, plus any EXPLICIT `include` array found in a root vitest/jest
 * config. That is a description of DiffCI's own repository, not of repositories in general. The
 * Phase 01 baseline measured what it costs:
 *
 * - `immerjs/immer` - suites are `__tests__/base.js`, `__tests__/curry.js`, ... : zero test files
 *   discovered, graph confidence COMPLETE, 5 of 5 commits classified SELECTIVE.
 * - `sindresorhus/execa` - an ava repository whose tests are `test/*.js`: zero test files discovered.
 *
 * Both failed OPEN. An empty test universe reads downstream as "there is nothing to run", which is
 * the one failure mode this codebase consistently refuses to accept elsewhere.
 *
 * WHAT THIS DOES. It reads the repository's declared dependencies and its `package.json` scripts to
 * find which frameworks it uses, and contributes each framework's OWN DOCUMENTED DEFAULT include
 * globs. The globs below are the frameworks' published defaults, transcribed - not DiffCI's guesses
 * about where tests ought to live. A repository that declares an explicit `include`/`testMatch`
 * still has it honoured (src/repo/test-discovery.ts); this only supplies what a repository leaves
 * implicit by relying on its runner's defaults.
 *
 * OVER-INCLUSION IS THE DELIBERATE DIRECTION. Some of these defaults (ava's and mocha's `test/**`)
 * will count helper and fixture files inside a test directory as tests. That inflates the "all
 * tests" denominator, which makes savings estimates more conservative, and it makes more files
 * eligible to be selected. Under-inclusion does the opposite in both respects and is what silently
 * emptied the test universe above.
 */
/**
 * Frameworks the engine recognises.
 *
 * Extended 2026-08-26 with playwright, cypress, jasmine and bun:test. What is still NOT covered, so
 * the boundary is stated rather than discovered later: karma, testcafe, web-test-runner, and any
 * runner outside the Node/TypeScript ecosystem entirely (pytest, go test, cargo test, JUnit). A
 * repository using only an unrecognised framework declares nothing here, so its tests fall back to
 * the conventional `.test.`/`.spec.` globs - and if that finds nothing, the blind-spot rule in
 * ImpactAnalyzer forces FULL rather than proposing a selection against an empty universe.
 */
export type KnownTestFramework =
  | "vitest"
  | "jest"
  | "mocha"
  | "ava"
  | "tap"
  | "node:test"
  | "jasmine"
  | "bun:test"
  | "playwright"
  | "cypress";

/** End-to-end runners. They are real test frameworks, but a unit-test file that no config claims
 * should not be routed to one, so they are never chosen as a repository's primary runner. */
export const END_TO_END_FRAMEWORKS: ReadonlySet<KnownTestFramework> = new Set(["playwright", "cypress"]);

export interface DeclaredTestFrameworks {
  /** Frameworks the repository declares, in a stable order. Empty for a repository with none. */
  frameworks: KnownTestFramework[];
  /** How each was detected, for evidence - "dependency" or the script name that named it. */
  evidence: Record<string, string>;
}

/** Each framework's own published default include globs, transcribed. */
export const FRAMEWORK_DEFAULT_INCLUDES: Record<KnownTestFramework, readonly string[]> = {
  // vitest: `include` defaults to ['**\/*.{test,spec}.?(c|m)[jt]s?(x)']
  vitest: ["**/*.{test,spec}.?(c|m)[jt]s?(x)"],
  // jest: `testMatch` defaults to ["**\/__tests__\/**\/*.[jt]s?(x)", "**\/?(*.)+(spec|test).[jt]s?(x)"]
  jest: ["**/__tests__/**/*.[jt]s?(x)", "**/?(*.)+(spec|test).[jt]s?(x)"],
  // mocha: `spec` defaults to './test/*.{js,cjs,mjs}'; TypeScript repositories run the same layout
  // through a loader, so the TS extensions are included alongside.
  mocha: ["test/*.{js,cjs,mjs,ts,mts,cts}"],
  // ava: files defaults to test.js, test-*.js, test/**, **\/__tests__\/**, **\/*.spec.js,
  // **\/*.test.js (ava also accepts .cjs/.mjs/.ts under its own compilation step).
  ava: [
    "test.{js,cjs,mjs,ts}",
    "test-*.{js,cjs,mjs,ts}",
    "test/**/*.{js,cjs,mjs,ts}",
    "**/__tests__/**/*.{js,cjs,mjs,ts}",
    "**/*.spec.{js,cjs,mjs,ts}",
    "**/*.test.{js,cjs,mjs,ts}",
  ],
  // tap: defaults to test/ and tap-snapshots/, plus *.test.* anywhere.
  tap: ["test/**/*.{js,cjs,mjs,ts,mts,cts}", "**/*.test.{js,cjs,mjs,ts,mts,cts}"],
  // node:test: the runner's own default discovery is **\/*.test.?(c|m)[jt]s plus files under a
  // test/ directory.
  "node:test": ["**/*.test.?(c|m)[jt]s", "test/**/*.{js,cjs,mjs,ts,mts,cts}"],
  // jasmine: `spec_files` defaults to "**\/*[sS]pec.?(m)js", resolved under `spec_dir` ("spec").
  jasmine: ["spec/**/*[sS]pec.?(m)js", "**/*[sS]pec.{js,mjs,ts}"],
  // bun test: discovers *.test.{js,jsx,ts,tsx}, *_test.*, *.spec.* and *_spec.*
  "bun:test": ["**/*.{test,spec}.{js,jsx,ts,tsx}", "**/*_{test,spec}.{js,jsx,ts,tsx}"],
  // playwright: `testMatch` defaults to **\/*.@(spec|test).?(c|m)[jt]s?(x)
  playwright: ["**/*.@(spec|test).?(c|m)[jt]s?(x)"],
  // cypress: `specPattern` defaults to cypress/e2e/**\/*.cy.{js,jsx,ts,tsx}
  cypress: ["cypress/e2e/**/*.cy.{js,jsx,ts,tsx}", "**/*.cy.{js,jsx,ts,tsx}"],
};

interface FrameworkMarker {
  framework: KnownTestFramework;
  /** Package names whose presence in dependencies/devDependencies declares this framework. */
  packages: readonly string[];
  /** Matches the literal text of a package.json script that invokes this framework. */
  script: RegExp;
}

const MARKERS: readonly FrameworkMarker[] = [
  { framework: "vitest", packages: ["vitest"], script: /(?:^|[\s;&|])vitest(?:$|[\s;&|])/ },
  { framework: "jest", packages: ["jest", "ts-jest", "@swc/jest", "jest-cli"], script: /(?:^|[\s;&|/])jest(?:$|[\s;&|])/ },
  { framework: "mocha", packages: ["mocha", "ts-mocha"], script: /(?:^|[\s;&|/])mocha(?:$|[\s;&|])/ },
  { framework: "ava", packages: ["ava"], script: /(?:^|[\s;&|/])ava(?:$|[\s;&|])/ },
  { framework: "tap", packages: ["tap", "libtap"], script: /(?:^|[\s;&|/])tap(?:$|[\s;&|])/ },
  { framework: "node:test", packages: [], script: /(?:node|tsx)\s[^;&|]*--test(?:$|[\s;&|=])/ },
  { framework: "jasmine", packages: ["jasmine", "jasmine-core"], script: /(?:^|[\s;&|/])jasmine(?:$|[\s;&|])/ },
  { framework: "bun:test", packages: [], script: /(?:^|[\s;&|])bun\s+test(?:$|[\s;&|])/ },
  // End-to-end runners last, so that a repository with both gets a unit-test runner as its primary.
  { framework: "playwright", packages: ["@playwright/test", "playwright"], script: /(?:^|[\s;&|/])playwright(?:$|[\s;&|])/ },
  { framework: "cypress", packages: ["cypress"], script: /(?:^|[\s;&|/])cypress(?:$|[\s;&|])/ },
];

export interface PackageJsonLike {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/**
 * Frameworks the repository declares. A dependency is stronger evidence than a script mention, but
 * either is sufficient - a monorepo root often runs a framework it does not itself depend on, and a
 * repository can depend on a framework it invokes only through a wrapper.
 */
export function detectDeclaredFrameworks(packageJson: PackageJsonLike | undefined): DeclaredTestFrameworks {
  if (!packageJson) return { frameworks: [], evidence: {} };
  const deps = { ...(packageJson.dependencies ?? {}), ...(packageJson.devDependencies ?? {}) };
  const scripts = packageJson.scripts ?? {};
  const frameworks: KnownTestFramework[] = [];
  const evidence: Record<string, string> = {};

  for (const marker of MARKERS) {
    const declaredPackage = marker.packages.find((p) => deps[p] !== undefined);
    if (declaredPackage !== undefined) {
      frameworks.push(marker.framework);
      evidence[marker.framework] = `dependency:${declaredPackage}`;
      continue;
    }
    const scriptEntry = Object.entries(scripts).find(([, command]) => marker.script.test(command));
    if (scriptEntry) {
      frameworks.push(marker.framework);
      evidence[marker.framework] = `script:${scriptEntry[0]}`;
    }
  }

  return { frameworks, evidence };
}

/**
 * Each framework's own published default EXCLUDES, transcribed - the other half of the defaults, and
 * not optional. ava's defaults exclude `**\/fixtures\/**` and `**\/helpers\/**`; without that,
 * `sindresorhus/execa` reports 337 test files where 193 of them are process fixtures ava would never
 * run (measured 2026-08-26). An inflated test universe is a wrong denominator in every downstream
 * savings figure, so "over-include and move on" is not good enough here.
 *
 * These apply only to files a framework's DEFAULT includes pulled in. A file that matches DiffCI's
 * conventional `.test.`/`.spec.` patterns, or a glob the repository declared explicitly in its own
 * config, is a test regardless of where it sits - the repository said so.
 */
export const FRAMEWORK_DEFAULT_EXCLUDES: Record<KnownTestFramework, readonly string[]> = {
  vitest: ["**/node_modules/**", "**/dist/**", "**/cypress/**"],
  jest: ["**/node_modules/**"],
  mocha: ["**/node_modules/**"],
  ava: ["**/fixtures/**", "**/helpers/**", "**/__helper__/**", "**/node_modules/**"],
  tap: ["**/fixtures/**", "**/node_modules/**"],
  "node:test": ["**/node_modules/**"],
  jasmine: ["**/node_modules/**"],
  "bun:test": ["**/node_modules/**"],
  playwright: ["**/node_modules/**"],
  cypress: ["**/node_modules/**", "**/cypress/support/**", "**/cypress/fixtures/**"],
};

/** The union of every declared framework's default include globs. */
export function defaultIncludesFor(frameworks: readonly KnownTestFramework[]): string[] {
  const patterns = new Set<string>();
  for (const framework of frameworks) {
    for (const pattern of FRAMEWORK_DEFAULT_INCLUDES[framework]) patterns.add(pattern);
  }
  return Array.from(patterns);
}

/** The union of every declared framework's default exclude globs. */
export function defaultExcludesFor(frameworks: readonly KnownTestFramework[]): string[] {
  const patterns = new Set<string>();
  for (const framework of frameworks) {
    for (const pattern of FRAMEWORK_DEFAULT_EXCLUDES[framework]) patterns.add(pattern);
  }
  return Array.from(patterns);
}
