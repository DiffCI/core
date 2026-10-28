import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import {
  type ChangeType,
  type ChangedFile,
  type GitCommitRange,
  type GitDelta,
  type GitDeltaAnalysis,
  type GitDeltaResult,
  type GitDeltaSummary,
  type RepositoryInventory,
} from "./types.js";
import { infrastructureRole, testScriptClosure } from "../repo/file-references.js";
import { workflowMayRunTests } from "../repo/workflow-test-steps.js";
import { npmLockAffectedDependencies } from "../repo/npm-lockfile.js";

export const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
export const ZERO_SHA = "0000000000000000000000000000000000000000";

export interface AnalyzeGitDeltaOptions extends Partial<GitCommitRange> {
  repoPath?: string;
  findRenames?: string | boolean;
}

interface SpawnResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

function runGit(
  args: readonly string[],
  repoPath: string | undefined,
): SpawnResult {
  const result = spawnSync("git", args, {
    cwd: repoPath,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
  };
}

function runGitOrThrow(
  args: readonly string[],
  repoPath: string | undefined,
  context: string,
): string {
  const result = runGit(args, repoPath);
  if (result.status !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || "unknown error";
    throw new GitDiffError(`${context} failed: ${message}`, {
      command: `git ${args.join(" ")}`,
      stderr: result.stderr,
      exitCode: result.status ?? undefined,
    });
  }
  return result.stdout;
}

interface GitDiffErrorDetails {
  command?: string;
  stderr?: string;
  exitCode?: number;
}

class GitDiffError extends Error {
  readonly details: GitDiffErrorDetails;

  constructor(message: string, details: GitDiffErrorDetails = {}) {
    super(message);
    this.name = "GitDiffError";
    this.details = details;
  }
}

type StatusCode = "A" | "C" | "D" | "M" | "R" | "T" | "U" | "X" | "B";

const STATUS_TO_CHANGE_TYPE: Record<StatusCode, ChangeType> = {
  A: "added",
  C: "copied",
  D: "deleted",
  M: "modified",
  R: "renamed",
  T: "modified",
  U: "unmerged",
  X: "unknown",
  B: "unknown",
};

function mapStatusCode(code: string): ChangeType {
  const first = code.charAt(0) as StatusCode;
  return STATUS_TO_CHANGE_TYPE[first] ?? "unknown";
}

export function parseNameStatus(buffer: Buffer): ChangedFile[] {
  const text = buffer.toString("utf8");
  const tokens = text.split("\0");
  const files: ChangedFile[] = [];
  let i = 0;

  while (i < tokens.length) {
    const statusToken = tokens[i];
    if (!statusToken) {
      i += 1;
      continue;
    }

    const code = statusToken.charAt(0);
    const similarity =
      statusToken.length > 1 ? parseInt(statusToken.slice(1), 10) : undefined;
    i += 1;

    if (i >= tokens.length) {
      break;
    }
    const firstPath = tokens[i];
    i += 1;

    if (code === "R" || code === "C") {
      if (i >= tokens.length) {
        break;
      }
      const secondPath = tokens[i];
      i += 1;
      files.push({
        path: secondPath,
        oldPath: firstPath,
        changeType: mapStatusCode(code),
        similarityScore: Number.isFinite(similarity) ? similarity : undefined,
      });
    } else {
      files.push({
        path: firstPath,
        changeType: mapStatusCode(code),
      });
    }
  }

  return files;
}

function parseNumstatRecord(record: string): { path: string; isBinary: boolean } | undefined {
  if (!record) return undefined;

  const fields = record.split("\t");
  if (fields.length < 3) return undefined;

  const isBinary = fields[0]?.trimStart().startsWith("-") ?? false;
  const hasRename = fields.length >= 4;
  const newPath = hasRename ? fields[fields.length - 1] : fields[2];

  if (!newPath) return undefined;
  return { path: newPath, isBinary };
}

export function parseNumstat(buffer: Buffer): Map<string, boolean> {
  const text = buffer.toString("utf8");
  const records = text.split("\0");
  const binaryByNewPath = new Map<string, boolean>();

  for (const record of records) {
    const parsed = parseNumstatRecord(record);
    if (parsed) {
      binaryByNewPath.set(parsed.path, parsed.isBinary);
    }
  }

  return binaryByNewPath;
}

export function normalizeDirectories(paths: Iterable<string>): string[] {
  const seen = new Set<string>();
  const dirs: string[] = [];

  for (const filePath of paths) {
    if (!filePath) continue;
    const dir = dirname(filePath);
    if (dir === ".") continue;
    if (!seen.has(dir)) {
      seen.add(dir);
      dirs.push(dir);
    }
  }

  dirs.sort((a, b) => a.localeCompare(b));
  return dirs;
}

const CONFIG_PATTERNS = [
  /^next\.config\./,
  /^tsconfig\.json$/,
  /^jsconfig\.json$/,
  /^eslint\.config\./,
  /^eslint\.rc/,
  /^\.eslint/,
  /^postcss\.config\./,
  /^tailwind\.config\./,
  /^\.prettier/,
  /^prettier\.config\./,
  /^vitest\.config\./,
  /^jest\.config\./,
  /^playwright\.config\./,
  /^webpack\.config\./,
  /^rollup\.config\./,
  /^esbuild\.config\./,
  // Only workflows and composite actions configure CI. Issue templates, CODEOWNERS and agent
  // instructions under .github/ do not (2026-10-21).
  /^\.github\/(?:workflows|actions)\//,
  /^\.docker/,
  /^Dockerfile/,
  /^docker-compose/,
  // ops/ and database/ are reported by their own signals below, not a second time as configuration
  // (2026-10-21).
  /^package\.json$/,
  /^package-lock\.json$/,
  /^yarn\.lock$/,
  /^pnpm-lock\.yaml$/,
  /^bun\.lockb$/,
  /^(npm|pnpm|yarn)-lock\./,
];

// Stage 1B fix (2026-08-21, docs/research/2026-08-21-stage1b-*.md): root-caused in Stage 1A's fallback-
// composition analysis - dependencyManifestChanged previously fired on ANY change to the root
// package.json, including fields with zero behavioral effect (description, keywords, author, homepage,
// license, contributors, bugs, repository). Content comparison must also clear the generic config
// flag for that file, otherwise the path-based rule still forces FULL fallback.
// Only explicitly understood descriptive fields may be ignored. Unknown fields can configure
// tools (including DiffCI itself), so a behavioral-field allowlist is unsafe.
const PACKAGE_JSON_METADATA_FIELDS = new Set([
  "description", "keywords", "author", "contributors", "homepage", "license", "bugs", "repository",
]);

/** Narrows a path-based "package.json changed" signal to whether any behaviorally-relevant field
 * actually changed, given both versions' raw content. Returns true (never narrows) whenever either
 * side is missing/unparseable - a file that was added, deleted, or became invalid JSON is unambiguously
 * not a case for field-level narrowing, and an unparseable "before" or "after" state means there is
 * nothing safe to compare. This function only ever narrows true -> false, never invents a change that
 * a path-based check didn't already flag. */
export function hasRelevantPackageJsonChange(oldContent: string | undefined, newContent: string | undefined): boolean {
  if (oldContent === undefined || newContent === undefined) return true;
  let oldJson: Record<string, unknown>;
  let newJson: Record<string, unknown>;
  try {
    oldJson = JSON.parse(oldContent);
    newJson = JSON.parse(newContent);
  } catch {
    return true;
  }
  if (!oldJson || !newJson || Array.isArray(oldJson) || Array.isArray(newJson) ||
      typeof oldJson !== "object" || typeof newJson !== "object") return true;
  return [...new Set([...Object.keys(oldJson), ...Object.keys(newJson)])].some((field) =>
    !PACKAGE_JSON_METADATA_FIELDS.has(field) && JSON.stringify(oldJson[field]) !== JSON.stringify(newJson[field]));
}

/**
 * Fields whose change cannot alter how `npm test` runs, but which a test may read (a release test
 * asserting `version`, a packaging test reading `files`). 2026-10-21 telemetry: `version` alone was the
 * only package.json change in 18 of one dogfood repository's 84 full runs, and non-test scripts in 15 more.
 */
const PACKAGE_JSON_DATA_FIELDS = new Set(["version", "files", "private", "publishConfig", "funding", "mcpName"]);

function parsePackageScripts(content: string | undefined): unknown {
  if (content === undefined) return undefined;
  try { return (JSON.parse(content) as { scripts?: unknown } | null)?.scripts; } catch { return undefined; }
}

function scriptRecord(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

const TEST_FILE_WORD = /^(?:\.\/)?[A-Za-z0-9._@+\-/]+\.(?:test|spec)\.[cm]?[jt]sx?$/;

/**
 * The test files a test-closure script edit adds to or removes from an explicit file list, or
 * undefined when the edit is anything else (2026-10-28). One dogfood repository's `test` script lists ~60 test
 * files by path; agents add one to it in most commits that add a test, and every such edit forced the
 * full suite (5 of the first 42 replayed commits). Only an insertion or removal of whole words that are
 * test-file paths, inside an `&&` phase that runs `--test`, qualifies: the remaining words, in order,
 * must be identical, so no flag, runner or other argument changed.
 */
export function testListEdit(oldBody: string, newBody: string): { added: string[]; removed: string[] } | undefined {
  const phases = (body: string) => body.split("&&").map((phase) => phase.trim().split(/\s+/).filter(Boolean));
  const oldPhases = phases(oldBody);
  const newPhases = phases(newBody);
  if (oldPhases.length !== newPhases.length) return undefined;
  const added: string[] = [];
  const removed: string[] = [];
  for (let i = 0; i < oldPhases.length; i++) {
    const before = oldPhases[i]!;
    const after = newPhases[i]!;
    const beforeSet = new Set(before);
    const afterSet = new Set(after);
    const phaseAdded = after.filter((word) => !beforeSet.has(word));
    const phaseRemoved = before.filter((word) => !afterSet.has(word));
    if (phaseAdded.length === 0 && phaseRemoved.length === 0) {
      if (before.join(" ") !== after.join(" ")) return undefined; // reordered or duplicated words
      continue;
    }
    if (!before.includes("--test") || !after.includes("--test")) return undefined;
    if (![...phaseAdded, ...phaseRemoved].every((word) => TEST_FILE_WORD.test(word))) return undefined;
    const kept = (words: string[], dropped: string[]) => words.filter((word) => !dropped.includes(word)).join(" ");
    if (kept(before, phaseRemoved) !== kept(after, phaseAdded)) return undefined;
    added.push(...phaseAdded.map((word) => word.replace(/^\.\//, "")));
    removed.push(...phaseRemoved.map((word) => word.replace(/^\.\//, "")));
  }
  return { added, removed };
}

const DEPENDENCY_FIELDS = new Set(["dependencies", "devDependencies", "optionalDependencies"]);

export interface PackageJsonChange {
  kind: "metadata" | "data" | "dependencies" | "behavioral";
  /** Test files a test-list edit added to the test script; they are now part of the suite. */
  testScriptAddedPaths: string[];
  /** Dependency names whose entry changed, when `kind` is `dependencies`. */
  changedDependencies: string[];
}

/**
 * How a modified package.json changed:
 *   - `metadata`: only descriptive fields (hasRelevantPackageJsonChange is false);
 *   - `data`: only PACKAGE_JSON_DATA_FIELDS, scripts outside the test closure (`test`, its lifecycle
 *     hooks, install hooks, and every script they name) on either side, and test-list edits (see
 *     testListEdit) - tests may read the file, so it is resolved by reference rather than ignored;
 *   - `dependencies`: as `data`, plus changed entries in dependencies, devDependencies or
 *     optionalDependencies. Which tests that affects depends on the lockfile and on who imports each
 *     package, so the caller decides, and stays behavioral when it cannot;
 *   - `behavioral`: anything else, including peerDependencies, overrides, engines, type, exports,
 *     workspaces and unparseable JSON.
 */
export function packageJsonChange(oldContent: string | undefined, newContent: string | undefined): PackageJsonChange {
  const result = (kind: PackageJsonChange["kind"], testScriptAddedPaths: string[] = [], changedDependencies: string[] = []): PackageJsonChange =>
    ({ kind, testScriptAddedPaths, changedDependencies });
  if (!hasRelevantPackageJsonChange(oldContent, newContent)) return result("metadata");
  let oldJson: Record<string, unknown>;
  let newJson: Record<string, unknown>;
  try {
    oldJson = JSON.parse(oldContent!);
    newJson = JSON.parse(newContent!);
  } catch {
    return result("behavioral");
  }
  const oldScripts = scriptRecord(oldJson.scripts);
  const newScripts = scriptRecord(newJson.scripts);
  if (!oldScripts || !newScripts) return result("behavioral");
  const closure = new Set([...testScriptClosure(oldScripts), ...testScriptClosure(newScripts)]);
  const added = new Set<string>();
  const dependencies = new Set<string>();
  for (const field of new Set([...Object.keys(oldJson), ...Object.keys(newJson)])) {
    if (PACKAGE_JSON_METADATA_FIELDS.has(field) || PACKAGE_JSON_DATA_FIELDS.has(field)) continue;
    if (JSON.stringify(oldJson[field]) === JSON.stringify(newJson[field])) continue;
    if (DEPENDENCY_FIELDS.has(field)) {
      const before = scriptRecord(oldJson[field]);
      const after = scriptRecord(newJson[field]);
      if (!before || !after) return result("behavioral");
      for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) if (before[name] !== after[name]) dependencies.add(name);
      continue;
    }
    if (field !== "scripts") return result("behavioral");
    for (const name of new Set([...Object.keys(oldScripts), ...Object.keys(newScripts)])) {
      if (oldScripts[name] === newScripts[name] || !closure.has(name)) continue;
      const edit = oldScripts[name] !== undefined && newScripts[name] !== undefined ? testListEdit(oldScripts[name]!, newScripts[name]!) : undefined;
      if (!edit) return result("behavioral");
      for (const path of edit.added) added.add(path);
    }
  }
  return result(dependencies.size > 0 ? "dependencies" : "data", [...added].sort(), [...dependencies].sort());
}

/** packageJsonChange's kind, with a dependency change reported as behavioral. */
export function packageJsonChangeKind(oldContent: string | undefined, newContent: string | undefined): "metadata" | "data" | "behavioral" {
  const { kind } = packageJsonChange(oldContent, newContent);
  return kind === "dependencies" ? "behavioral" : kind;
}

/** Reads a file's content at a specific commit via `git show <sha>:<path>`, without touching the
 * working tree (safe to call regardless of what's currently checked out). Returns undefined - not an
 * error - when the file doesn't exist at that commit (a newly-added or since-deleted file), which is
 * the expected, common case this is called for, not an exceptional one. */
function readFileAtSha(sha: string, path: string, repoPath: string | undefined): string | undefined {
  const result = runGit(["show", `${sha}:${path}`], repoPath);
  if (result.status !== 0) return undefined;
  return result.stdout;
}

export function computeAnalysis(files: ChangedFile[]): GitDeltaAnalysis {
  const paths = files.flatMap((f) =>
    f.oldPath ? [f.path, f.oldPath] : [f.path],
  );

  const matching = (test: (p: string) => boolean) => [...new Set(paths.filter(test))].sort();
  const signalPaths: NonNullable<GitDeltaAnalysis["signalPaths"]> = {
    config: matching((p) => CONFIG_PATTERNS.some((pattern) => pattern.test(p))),
    dependencyManifest: matching((p) => p === "package.json"),
    lockfile: matching((p) => /^(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb)$/.test(p)),
    workflow: matching((p) => p.startsWith(".github/workflows/")),
    infrastructure: matching((p) => infrastructureRole(p) === "definition"),
    database: matching((p) => p.startsWith("database/")),
  };

  return {
    empty: files.length === 0,
    configChanged: signalPaths.config!.length > 0,
    dependencyManifestChanged: signalPaths.dependencyManifest!.length > 0,
    lockfileChanged: signalPaths.lockfile!.length > 0,
    workflowChanged: signalPaths.workflow!.length > 0,
    infrastructureChanged: signalPaths.infrastructure!.length > 0,
    databaseChanged: signalPaths.database!.length > 0,
    signalPaths,
  };
}

export function summarize(files: ChangedFile[]): GitDeltaSummary {
  const s = {
    added: 0,
    modified: 0,
    deleted: 0,
    renamed: 0,
    copied: 0,
    unmerged: 0,
    unknown: 0,
    total: files.length,
  };

  for (const file of files) {
    switch (file.changeType) {
      case "added":
        s.added += 1;
        break;
      case "modified":
        s.modified += 1;
        break;
      case "deleted":
        s.deleted += 1;
        break;
      case "renamed":
        s.renamed += 1;
        break;
      case "copied":
        s.copied += 1;
        break;
      case "unmerged":
        s.unmerged += 1;
        break;
      default:
        s.unknown += 1;
        break;
    }
  }

  return s;
}

export function resolveCommitParents(sha: string, repoPath: string | undefined): string[] {
  const output = runGitOrThrow(["rev-list", "--parents", "-n", "1", sha], repoPath, "Resolve commit parents").trim();
  const parts = output.split(/\s+/);
  return parts.slice(1); // first token is the commit itself
}

function validateCommits(
  baseSha: string,
  headSha: string,
  repoPath: string | undefined,
): void {
  for (const sha of [baseSha, headSha]) {
    if (!sha || sha === ZERO_SHA || (!/^[0-9a-f]{4,40}$/i.test(sha) && !/^[A-Za-z0-9/_.^~@-]+$/i.test(sha))) {
      throw new GitDiffError(`Invalid commit SHA: ${sha}`);
    }
  }

  for (const sha of [baseSha, headSha]) {
    if (sha === EMPTY_TREE_SHA) continue;
    runGitOrThrow(["cat-file", "-t", `${sha}^{commit}`], repoPath, "SHA validation");
  }
}

function headHasParent(headSha: string, repoPath: string | undefined): boolean {
  const parents = resolveCommitParents(headSha, repoPath);
  return parents.length > 0;
}

/**
 * Canonical HEAD file inventory (see RepositoryInventory). One `git ls-tree` per analysis - cheap
 * (~tens of ms for ~10k paths) and already co-located with the only code that knows repoPath+headSha.
 * Failure is NOT fatal: returns undefined so the delta analysis still succeeds and relationship-based
 * classification simply stays inert (conservative: affected files remain "unknown" -> fallback).
 */
export function readRepositoryInventory(headSha: string, repoPath: string | undefined): RepositoryInventory | undefined {
  const result = runGit(["ls-tree", "-r", "--name-only", "-z", headSha], repoPath);
  if (result.status !== 0) return undefined;
  const files = new Set(result.stdout.split("\0").filter((p) => p.length > 0));
  if (files.size === 0) return undefined; // an empty listing is never a trustworthy inventory
  return { headSha, files, source: "git-ls-tree" };
}

export async function analyzeGitDelta(
  options: AnalyzeGitDeltaOptions = {},
): Promise<GitDeltaResult> {
  const repoPath = options.repoPath;

  try {
    const headSha =
      options.headSha ??
      runGitOrThrow(["rev-parse", "HEAD"], repoPath, "Resolve HEAD").trim();
    let baseSha = options.baseSha;
    if (!baseSha) {
      baseSha = headHasParent(headSha, repoPath)
        ? runGitOrThrow(["rev-parse", `${headSha}^`], repoPath, "Resolve base").trim()
        : EMPTY_TREE_SHA;
    }

    validateCommits(baseSha, headSha, repoPath);

    const findRenamesArg = options.findRenames
      ? `--find-renames=${typeof options.findRenames === "string" ? options.findRenames : "50%"}`
      : "--find-renames=50%";

    const nameStatus = runGitOrThrow(
      [
        "diff-tree",
        "-r",
        "--name-status",
        "-z",
        findRenamesArg,
        baseSha,
        headSha,
      ],
      repoPath,
      "Resolve changed files",
    );

    const files = parseNameStatus(Buffer.from(nameStatus, "utf8"));

    const numstat = runGitOrThrow(
      ["diff-tree", "-r", "--numstat", "-z", findRenamesArg, baseSha, headSha],
      repoPath,
      "Resolve binary metadata",
    );

    const binaryMap = parseNumstat(Buffer.from(numstat, "utf8"));
    const filesWithBinary = files.map((file) => ({
      ...file,
      isBinary: binaryMap.get(file.path),
    }));

    const allPaths = filesWithBinary.flatMap((f) =>
      f.oldPath ? [f.path, f.oldPath] : [f.path],
    );

    const analysis = computeAnalysis(filesWithBinary);
    // Stage 1B fix (2026-08-21): narrow the path-based dependencyManifestChanged signal to whether a
    // behaviorally-relevant field actually changed - only attempted when the root package.json itself
    // was modified (not added/deleted/renamed, which stay unambiguously true - see
    // hasRelevantPackageJsonChange()'s own doc comment) and only ever narrows true -> false.
    const narrowed = new Set<ChangedFile>();
    const referenceResolvedPaths: string[] = [];
    const changedPackageJson = filesWithBinary.find((f) => f.path === "package.json" && f.changeType === "modified");
    const oldPackageJson = readFileAtSha(baseSha, "package.json", repoPath);
    const newPackageJson = readFileAtSha(headSha, "package.json", repoPath);
    const packageChange = changedPackageJson ? packageJsonChange(oldPackageJson, newPackageJson) : undefined;
    if (analysis.dependencyManifestChanged && changedPackageJson && packageChange) {
      analysis.dependencyManifestChanged = packageChange.kind === "behavioral" || packageChange.kind === "dependencies";
      if (packageChange.kind === "metadata" || packageChange.kind === "data") narrowed.add(changedPackageJson);
      if (packageChange.kind === "data") referenceResolvedPaths.push("package.json");
      if (packageChange.kind === "data" && packageChange.testScriptAddedPaths.length > 0) analysis.testScriptAddedPaths = packageChange.testScriptAddedPaths;
    }
    // 2026-10-28: a dependency change is narrowed to the direct dependencies whose installed tree the
    // npm lockfile shows changed (src/repo/npm-lockfile.ts); ImpactAnalyzer selects the tests that
    // import them, or falls back. Both files must agree: a manifest dependency change without a
    // matching lockfile change stays global.
    const changedLockfile = filesWithBinary.find((f) => f.path === "package-lock.json" && f.changeType === "modified");
    const dependencyEdit = packageChange?.kind === "dependencies" || (!changedPackageJson && analysis.lockfileChanged);
    const onlyNpmLock = (analysis.signalPaths?.lockfile ?? []).every((p) => p === "package-lock.json");
    if (dependencyEdit && changedLockfile && onlyNpmLock) {
      const manifests = [oldPackageJson, newPackageJson].map((content) => { try { return JSON.parse(content ?? "") as Record<string, unknown>; } catch { return undefined; } });
      const direct = new Set<string>();
      let modelled = manifests.every((manifest) => manifest && manifest.workspaces === undefined);
      for (const manifest of manifests) {
        for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
          const record = scriptRecord(manifest?.[field]);
          if (!record) { modelled = false; continue; }
          for (const name of Object.keys(record)) direct.add(name);
        }
      }
      const affected = modelled
        ? npmLockAffectedDependencies(readFileAtSha(baseSha, "package-lock.json", repoPath), readFileAtSha(headSha, "package-lock.json", repoPath), [...direct])
        : undefined;
      if (affected && (packageChange?.changedDependencies ?? []).every((name) => affected.includes(name))) {
        analysis.dependencyManifestChanged = false;
        analysis.lockfileChanged = false;
        analysis.changedDependencies = affected;
        narrowed.add(changedLockfile);
        if (changedPackageJson) {
          narrowed.add(changedPackageJson);
          referenceResolvedPaths.push("package.json");
          if (packageChange!.testScriptAddedPaths.length > 0) analysis.testScriptAddedPaths = packageChange!.testScriptAddedPaths;
        }
      }
    }
    // 2026-10-21: a workflow that cannot run tests (deploy, publish, scan) cannot change a test
    // outcome. Both sides of the change are inspected, since removing a test step changes CI too.
    if (analysis.workflowChanged) {
      const headScripts = scriptRecord(parsePackageScripts(readFileAtSha(headSha, "package.json", repoPath))) ?? {};
      const baseScripts = scriptRecord(parsePackageScripts(readFileAtSha(baseSha, "package.json", repoPath))) ?? {};
      for (const file of filesWithBinary) {
        const sides = file.oldPath ? [file.path, file.oldPath] : [file.path];
        if (!sides.every((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p))) continue;
        const before = file.changeType === "added" ? "" : readFileAtSha(baseSha, file.oldPath ?? file.path, repoPath);
        const after = file.changeType === "deleted" ? "" : readFileAtSha(headSha, file.path, repoPath);
        const mayRunTests = (text: string | undefined, scripts: Record<string, string>) => text !== "" && workflowMayRunTests(text, scripts);
        if (mayRunTests(before, baseScripts) || mayRunTests(after, headScripts)) continue;
        narrowed.add(file);
        referenceResolvedPaths.push(file.path);
      }
    }
    if (narrowed.size > 0) {
      // Do not let the generic path rules undo the content-level narrowing. Other changes in the same
      // delta must still force full validation.
      const remaining = computeAnalysis(filesWithBinary.filter((f) => !narrowed.has(f)));
      analysis.configChanged = remaining.configChanged;
      analysis.workflowChanged = remaining.workflowChanged;
      analysis.signalPaths = { ...analysis.signalPaths, config: remaining.signalPaths?.config, workflow: remaining.signalPaths?.workflow,
        ...(analysis.dependencyManifestChanged ? {} : { dependencyManifest: [] }),
        ...(analysis.lockfileChanged ? {} : { lockfile: [] }) };
    }
    if (referenceResolvedPaths.length > 0) analysis.referenceResolvedPaths = referenceResolvedPaths.sort();

    const delta: GitDelta = {
      baseSha,
      headSha,
      files: filesWithBinary,
      directories: normalizeDirectories(allPaths),
      summary: summarize(filesWithBinary),
      analysis,
    };

    return { success: true, delta, inventory: readRepositoryInventory(headSha, repoPath) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: message,
    };
  }
}

export function gitDeltaToJson(delta: GitDelta): string {
  return JSON.stringify(
    delta,
    (_key, value) => (typeof value === "bigint" ? value.toString() : value),
    2,
  );
}

export { GitDiffError };

export function isAllZeroSha(sha: string | undefined): boolean {
  return typeof sha === "string" && /^0+$/.test(sha);
}

export interface CommitPair {
  baseSha: string;
  headSha: string;
  emptyBase: boolean;
  firstParent: boolean;
}

export function findRecentNonEmptyCommitPair(
  repoPath?: string,
  maxWalk: number = 32,
): CommitPair | undefined {
  const head = runGitOrThrow(["rev-parse", "HEAD"], repoPath, "Resolve HEAD").trim();
  const candidates = runGitOrThrow(["rev-list", "--first-parent", "-n", String(maxWalk + 1), head], repoPath, "List first-parent commits").trim().split("\n");

  for (let i = 0; i < candidates.length - 1; i++) {
    const headSha = candidates[i]!;
    const baseSha = candidates[i + 1]!;
    const diffFiles = runGit(["diff-tree", "--no-commit-id", "--name-only", "-r", baseSha, headSha], repoPath);
    if (diffFiles.status === 0 && diffFiles.stdout.trim().length > 0) {
      return { baseSha, headSha, emptyBase: false, firstParent: true };
    }
  }

  if (candidates.length > 0) {
    return { baseSha: EMPTY_TREE_SHA, headSha: candidates[0]!, emptyBase: true, firstParent: true };
  }

  return undefined;
}
