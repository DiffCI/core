// SPDX-License-Identifier: MIT
/**
 * Which changed paths are CI pipeline definitions (2026-11-05).
 *
 * WHY. A pipeline definition decides which commands CI runs, so changing one can change a test outcome
 * without touching anything a test imports. Only `.github/workflows/` was recognised. A GitLab
 * pipeline file fell through to the unknown-file path, where reference resolution narrowed it to the
 * files that name it: a test reading `.gitlab-ci.yml` became the only selected test, and a file pulled
 * in by `include: local:` (read only by `.gitlab-ci.yml`) selected no tests at all.
 *
 * GitLab has no fixed directory, so this recognises the conventional names and also follows
 * `include` from the root `.gitlab-ci.yml`. Anything it cannot follow (a variable in the path, an
 * unparsable file) makes every YAML file count as pipeline config.
 */
import { parse as parseYaml } from "yaml";

const GITLAB_ROOT = ".gitlab-ci.yml";
const YAML = /\.ya?ml$/i;
const MAX_INCLUDE_DEPTH = 10;

/** Recognised by name alone, with no file content. */
export function isConventionalCiConfigPath(path: string): boolean {
  if (path.startsWith(".github/workflows/")) return true;
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (/(?:^|\.)gitlab-ci\.ya?ml$/.test(base)) return true; // .gitlab-ci.yml, test.gitlab-ci.yml
  return path.startsWith(".gitlab/") && YAML.test(path); // .gitlab/ci/*.yml and similar
}

export interface GitlabIncludes {
  /** Local files reached from the root through `include`, without the leading slash. */
  paths: Set<string>;
  /** Local include patterns with `*`, as regular expressions over repository paths. */
  patterns: RegExp[];
  /** An include could not be followed, so any YAML file may be pipeline config. */
  unresolved: boolean;
}

function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === "*" && glob[i + 1] === "*") {
      source += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (char === "*") source += "[^/]*";
    else source += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

/** The local include targets one parsed pipeline document names. Remote, project, template and
 * component includes live outside the repository, so a diff of this repository cannot change them. */
function localIncludeTargets(doc: unknown): { targets: string[]; unresolved: boolean } {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return { targets: [], unresolved: false };
  const include = (doc as Record<string, unknown>).include;
  if (include === undefined) return { targets: [], unresolved: false };
  const entries = Array.isArray(include) ? include : [include];
  const targets: string[] = [];
  let unresolved = false;
  for (const entry of entries) {
    let target: unknown;
    if (typeof entry === "string") {
      if (/^https?:\/\//i.test(entry)) continue; // shorthand for `remote:`
      target = entry;
    } else if (entry !== null && typeof entry === "object") {
      const record = entry as Record<string, unknown>;
      if (!("local" in record)) continue;
      target = record.local;
    } else {
      unresolved = true;
      continue;
    }
    if (typeof target !== "string" || target === "" || target.includes("$")) {
      unresolved = true;
      continue;
    }
    targets.push(target.replace(/^\/+/, ""));
  }
  return { targets, unresolved };
}

/**
 * Follows `include` from `.gitlab-ci.yml` at one commit. `read` returns a file's content at that
 * commit, or undefined when it does not exist. `files` lists the repository's files at that commit; it
 * is called only for a wildcard include, whose matches may include further files.
 */
export function gitlabLocalIncludes(read: (path: string) => string | undefined, files: () => readonly string[] = () => []): GitlabIncludes {
  const result: GitlabIncludes = { paths: new Set(), patterns: [], unresolved: false };
  const queue: Array<{ path: string; depth: number }> = [{ path: GITLAB_ROOT, depth: 0 }];
  const seen = new Set<string>([GITLAB_ROOT]);
  while (queue.length > 0) {
    const { path, depth } = queue.shift()!;
    const content = read(path);
    if (content === undefined) continue; // a missing include fails the GitLab pipeline itself
    let doc: unknown;
    try {
      doc = parseYaml(content);
    } catch {
      result.unresolved = true;
      continue;
    }
    const { targets, unresolved } = localIncludeTargets(doc);
    if (unresolved) result.unresolved = true;
    for (const target of targets) {
      const matches = target.includes("*")
        ? (() => { const pattern = globToRegExp(target); result.patterns.push(pattern); return files().filter((f) => pattern.test(f)); })()
        : [target];
      for (const match of matches) {
        if (match !== GITLAB_ROOT) result.paths.add(match);
        if (seen.has(match)) continue;
        seen.add(match);
        if (depth + 1 >= MAX_INCLUDE_DEPTH) { result.unresolved = true; continue; }
        queue.push({ path: match, depth: depth + 1 });
      }
    }
  }
  return result;
}

/** A predicate over changed paths: conventional names, plus whatever either commit's includes reach. */
export function ciConfigPredicate(includes: readonly GitlabIncludes[] = []): (path: string) => boolean {
  const paths = new Set(includes.flatMap((i) => [...i.paths]));
  const patterns = includes.flatMap((i) => i.patterns);
  const anyYaml = includes.some((i) => i.unresolved);
  return (path) =>
    isConventionalCiConfigPath(path)
    || paths.has(path)
    || patterns.some((pattern) => pattern.test(path))
    || (anyYaml && YAML.test(path));
}
