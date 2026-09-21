/**
 * What do this repository's directories MEAN? (Phase 01 follow-up, 2026-08-26.)
 *
 * WHY. After the first Phase 01 pass the engine named no particular repository, but it still
 * *described* one. `src/repo/impact.ts` answered "is this a script?" with
 * `path.startsWith("scripts/") || path.startsWith("ops/")` and "is this documentation?" with
 * `startsWith("docs/")` - DiffCI's own directory vocabulary, applied to every repository regardless
 * of what that repository actually has. A project keeping its tooling in `tools/` or `bin/` had
 * those files classified as ordinary source; a project with no `ops/` had a rule that could never
 * fire. And the Next.js entry-point rules ran everywhere: `classifyNextEntryPoint()` was called
 * without checking whether the repository was a Next.js app at all, so any file named `route.ts`,
 * `error.ts` or `page.ts` acquired Next.js semantics. Measured across the Phase 01 cohort, that
 * mislabelled files in five of nine repositories - `unjs/h3` alone has seven, where `route` and
 * `error` are HTTP concepts and nothing to do with Next.
 *
 * WHAT THIS IS. One place that turns a RepositoryProfile into answers about THAT repository's
 * layout. Two kinds of input, and the distinction matters:
 *
 *   - DISCOVERED: `profile.sourceRoots` records the directories this repository actually has, with
 *     the kind they were discovered as. A `scripts` root exists here only if the repository has one.
 *   - CONVENTIONAL: a small list of names that mean the same thing across the ecosystem (`docs/`,
 *     `doc/`, `documentation/`). These are conventions, not one repository's invention, and they are
 *     applied only as names - never as an assumption that the directory exists.
 *
 * What is NOT here: anything derived from a specific repository's habits.
 */
import { extname } from "node:path";
import type { RepositoryProfile } from "./types.js";

/**
 * Directory names that mean "documentation" across the ecosystem. Deliberately short: a name earns a
 * place here by being a convention many projects share, not by appearing in one repository.
 */
const CONVENTIONAL_DOC_DIRECTORIES: readonly string[] = ["docs", "doc", "documentation"];

export interface RepositoryLayout {
  /** Directories this repository actually uses for auxiliary code - build tooling, ops, release
   * scripts. Empty when it has none, rather than assumed. */
  readonly scriptRoots: readonly string[];
  /** Whether this repository is a Next.js application, and so whether Next.js file-name conventions
   * (`page`, `layout`, `route`, `middleware`, ...) mean anything in it. */
  readonly isNextApp: boolean;
  /** Auxiliary code: build/release tooling and operations, as this repository organises it. */
  isScriptPath(path: string): boolean;
  /** Documentation: any Markdown file, plus anything under a conventional documentation directory. */
  isDocumentationPath(path: string): boolean;
}

function normalizeRoot(root: string): string {
  return root.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

export function repositoryLayout(profile: RepositoryProfile): RepositoryLayout {
  const scriptRoots = Array.from(
    new Set(
      (profile.sourceRoots ?? [])
        .filter((root) => root.kind === "scripts" || root.kind === "operations")
        .map((root) => normalizeRoot(root.path))
        .filter((root) => root !== ""),
    ),
  ).sort();

  // A repository is a Next.js app if it says so - a next.config file, or a declared dependency. Both
  // are the repository's own statement about itself, not an inference from a filename.
  const declaresNext =
    profile.packageJson.dependencies.includes("next") || profile.packageJson.devDependencies.includes("next");
  const isNextApp = profile.nextConfig?.exists === true || declaresNext;

  return {
    scriptRoots,
    isNextApp,
    isScriptPath(path: string): boolean {
      const normalized = normalizeRoot(path);
      return scriptRoots.some((root) => isUnder(normalized, root));
    },
    isDocumentationPath(path: string): boolean {
      const normalized = normalizeRoot(path);
      const ext = extname(normalized).toLowerCase();
      if (ext === ".md" || ext === ".mdx") return true;
      const first = normalized.split("/")[0];
      return first !== undefined && CONVENTIONAL_DOC_DIRECTORIES.includes(first.toLowerCase());
    },
  };
}

/** The layout of a repository nothing is known about: no script roots, not a Next.js app. Used where
 * a profile genuinely is not available, so the absence is explicit rather than a silent default. */
export const UNKNOWN_REPOSITORY_LAYOUT: RepositoryLayout = {
  scriptRoots: [],
  isNextApp: false,
  isScriptPath: () => false,
  isDocumentationPath(path: string): boolean {
    const ext = extname(path).toLowerCase();
    return ext === ".md" || ext === ".mdx";
  },
};
