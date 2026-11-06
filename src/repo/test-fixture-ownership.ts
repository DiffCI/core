/**
 * Conservative test-fixture ownership (2026-08-23, deepseek-harness benchmark Phase 3).
 *
 * Recorded fixtures such as `examples/acp-agent/tests/snapshots/<case>/session.jsonl` are read at
 * runtime by the suite beside them (`examples/acp-agent/tests/acp.snapshot.ts` builds the directory
 * from `import.meta.url` + 'snapshots'). The import graph cannot see that edge, so before this module
 * every such change was "Unknown changed file" -> full fallback (157 files on one deepseek merge).
 *
 * These files are TEST INPUTS, never documentation: a change must SELECT the tests that read it, or
 * a conservative superset, or stay unknown. The relationship is expressed purely structurally:
 *
 *   <scope>/<tests-dir>/<fixture-dir>/...   is owned by the test files that live in <scope>/<tests-dir>
 *
 * with every step guarded:
 *   1. the nearest ancestor directory named `tests`, `test` or `__tests__` is the tests dir T;
 *   2. the segment directly under T must be a fixture directory by name (`snapshots`,
 *      `goal-snapshots`, `fixtures`, `__fixtures__`, `__snapshots__`, ...) - a `.jsonl` elsewhere
 *      under T (or outside any tests dir) is NOT claimed, except a non-code file directly in T, which
 *      the direct test children of T own (2026-11-05);
 *   3. owners are the recognised test files (profile test patterns) that are DIRECT children of T.
 *      When the fixture dir is snapshot-named and T has snapshot-family tests, only those are owned
 *      (a snapshots dir is read by snapshot suites); otherwise all direct test children; if T has no
 *      direct test children, every recognised test under T/** (wider superset);
 *   4. if that still yields nothing - or the caller has no HEAD inventory to look in - the result is
 *      undefined and the file stays "unknown" (fallback). Deleted fixtures resolve against HEAD: the
 *      tests dir still exists -> its tests are selected; tests dir gone -> unknown.
 *
 * A fixture directory BESIDE its tests (2026-11-05, LobeHub `verification/fixtures/assets/*` next to
 * `verification/__tests__/`, `src/spawn/__fixtures__/` next to `src/spawn/*.test.ts`) is owned the same
 * way when no tests-dir ancestor claims it: the nearest fixture-named ancestor F, its parent P, and as
 * owners the tests directly in P or directly in P's `tests`/`test`/`__tests__`; if there are none, every
 * test under P/** (scope `sibling-recursive`).
 *
 * Ownership is by directory convention only; nothing here inspects file contents or file extensions,
 * so the same rule covers `.jsonl`, `.json`, `.txt`, `.expected.*` fixtures alike.
 */
import { testFamilyOfPath } from "./test-discovery.js";

const TESTS_DIR_NAMES = new Set(["tests", "test", "__tests__"]);
const FIXTURE_DIR = /(^|[-_.])(snapshots?|fixtures?)([-_.]|$)|^__(snapshots|fixtures)__$/i;
const CODE_FILE = /\.(?:[cm]?[jt]sx?|vue|svelte|go|java|kt|py|rb)$/i;

export interface FixtureOwnership {
  testsDir: string;
  fixtureDir: string;
  /** How owners were chosen - surfaced in evidence so over-selection is auditable. */
  scope: "direct-snapshot-family" | "direct" | "recursive" | "sibling" | "sibling-recursive";
  owners: string[];
}

/** Owners of a fixture directory that sits beside its tests rather than inside a tests dir. */
function siblingOwners(segments: readonly string[], isTestFile: (p: string) => boolean, repositoryFiles: ReadonlySet<string>): FixtureOwnership | undefined {
  let f = -1;
  for (let i = segments.length - 2; i >= 1; i--) { if (FIXTURE_DIR.test(segments[i]!)) { f = i; break; } }
  if (f === -1) return undefined;
  const scope = segments.slice(0, f).join("/");
  const fixtureDir = `${scope}/${segments[f]}`;
  const direct: string[] = [];
  const recursive: string[] = [];
  for (const file of repositoryFiles) {
    if (!file.startsWith(`${scope}/`) || !isTestFile(file)) continue;
    recursive.push(file);
    const rest = file.slice(scope.length + 1).split("/");
    if (rest.length === 1 || (rest.length === 2 && TESTS_DIR_NAMES.has(rest[0]!))) direct.push(file);
  }
  if (direct.length > 0) return { testsDir: scope, fixtureDir, scope: "sibling", owners: direct.sort() };
  if (recursive.length > 0) return { testsDir: scope, fixtureDir, scope: "sibling-recursive", owners: recursive.sort() };
  return undefined;
}

export function resolveTestFixtureOwners(
  changedPath: string,
  isTestFile: (p: string) => boolean,
  repositoryFiles: ReadonlySet<string> | undefined,
): FixtureOwnership | undefined {
  if (!repositoryFiles) return undefined;
  if (isTestFile(changedPath)) return undefined; // a test is a test, not a fixture
  const segments = changedPath.split("/");
  // nearest tests-dir ancestor (search from the deepest directory upward)
  let t = -1;
  for (let i = segments.length - 2; i >= 0; i--) { if (TESTS_DIR_NAMES.has(segments[i]!)) { t = i; break; } }
  // A data file directly in a tests dir (`__tests__/recordedRun.json`) is read by the tests beside it
  // (2026-11-05, LobeHub). Code there is a helper the graph sees, so only non-code files are claimed.
  if (t !== -1 && t === segments.length - 2 && /\.[^./]+$/.test(changedPath) && !CODE_FILE.test(changedPath)) {
    const testsDir = segments.slice(0, t + 1).join("/");
    const owners = [...repositoryFiles].filter((f) => f.startsWith(`${testsDir}/`) && !f.slice(testsDir.length + 1).includes("/") && isTestFile(f)).sort();
    if (owners.length > 0) return { testsDir, fixtureDir: testsDir, scope: "direct", owners };
  }
  const fixtureSegment = t === -1 ? undefined : segments[t + 1];
  // must be a fixture DIRECTORY (at least one more segment = the file itself), and fixture-named
  if (fixtureSegment === undefined || t + 1 >= segments.length - 1 || !FIXTURE_DIR.test(fixtureSegment)) return siblingOwners(segments, isTestFile, repositoryFiles);
  const testsDir = segments.slice(0, t + 1).join("/");
  const prefix = `${testsDir}/`;
  const direct: string[] = [];
  const recursive: string[] = [];
  for (const f of repositoryFiles) {
    if (!f.startsWith(prefix) || !isTestFile(f)) continue;
    recursive.push(f);
    if (!f.slice(prefix.length).includes("/")) direct.push(f);
  }
  if (recursive.length === 0) return undefined;
  const fixtureDir = `${testsDir}/${fixtureSegment}`;
  if (direct.length > 0) {
    if (/snapshot/i.test(fixtureSegment)) {
      const snapshotOwners = direct.filter((f) => testFamilyOfPath(f) === "snapshot");
      if (snapshotOwners.length > 0) return { testsDir, fixtureDir, scope: "direct-snapshot-family", owners: snapshotOwners.sort() };
    }
    return { testsDir, fixtureDir, scope: "direct", owners: direct.sort() };
  }
  return { testsDir, fixtureDir, scope: "recursive", owners: recursive.sort() };
}
