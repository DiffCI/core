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
  /^\.github\//,
  /^\.docker/,
  /^Dockerfile/,
  /^docker-compose/,
  /^ops\//,
  /^database\//,
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
// license, contributors, bugs, repository). Only these fields can actually change what gets built/
// tested/resolved; everything else is metadata a change to which should never force FULL fallback.
const PACKAGE_JSON_RELEVANT_FIELDS = [
  "dependencies", "devDependencies", "peerDependencies", "optionalDependencies",
  "scripts", "exports", "main", "module", "type", "bin", "engines", "workspaces", "browser",
] as const;

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
  return PACKAGE_JSON_RELEVANT_FIELDS.some((field) => JSON.stringify(oldJson[field]) !== JSON.stringify(newJson[field]));
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

  const matches = (pattern: RegExp) => paths.some((p) => pattern.test(p));

  return {
    empty: files.length === 0,
    configChanged: CONFIG_PATTERNS.some(matches),
    dependencyManifestChanged: matches(/^package\.json$/),
    lockfileChanged:
      matches(/^package-lock\.json$/) ||
      matches(/^yarn\.lock$/) ||
      matches(/^pnpm-lock\.yaml$/) ||
      matches(/^bun\.lockb$/),
    workflowChanged: matches(/^\.github\/workflows\//),
    infrastructureChanged: matches(/^ops\//),
    databaseChanged: matches(/^database\//),
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
    if (analysis.dependencyManifestChanged) {
      const changedPackageJson = filesWithBinary.find((f) => f.path === "package.json" && f.changeType === "modified");
      if (changedPackageJson) {
        const oldContent = readFileAtSha(baseSha, "package.json", repoPath);
        const newContent = readFileAtSha(headSha, "package.json", repoPath);
        analysis.dependencyManifestChanged = hasRelevantPackageJsonChange(oldContent, newContent);
      }
    }

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

