// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { analyzeGitDelta } from "./git/git-diff.js";
import { buildDependencyGraph } from "./repo/graph.js";
import { ImpactAnalyzer } from "./repo/impact.js";
import { DefaultCIPlanner } from "./planner/planner.js";
import { buildGenericTaskRegistry } from "./research/baseline/registry.js";
import { parseRepositoryWorkflows } from "./research/baseline/workflow-parser.js";

/** Analyze a clean checkout at head. Repository commands and configuration are never executed. */
export async function analyzeCheckout(options: { repoPath: string; base: string; head: string }) {
  const canonical = (path: string) => {
    const full = realpathSync.native(resolve(path));
    return process.platform === "win32" ? full.toLowerCase() : full;
  };
  const repoPath = realpathSync.native(resolve(options.repoPath));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoPath, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
  if (canonical(git("rev-parse", "--show-toplevel")) !== canonical(repoPath)) throw new Error("--repo must be the Git repository root");
  const base = git("rev-parse", "--verify", "--end-of-options", `${options.base}^{commit}`);
  const head = git("rev-parse", "--verify", "--end-of-options", `${options.head}^{commit}`);
  if (git("rev-parse", "HEAD") !== head) throw new Error("Checkout must be at --head before analysis");
  if (git("status", "--porcelain", "--untracked-files=normal")) throw new Error("Checkout must be clean, including untracked files, before analysis");
  const delta = await analyzeGitDelta({ repoPath, baseSha: base, headSha: head });
  if (!delta.success) throw new Error(JSON.stringify(delta.error));
  const graph = await buildDependencyGraph({ repoPath, excludeDirs: ["node_modules", ".git", "dist", "build", ".next", "coverage"] });
  const impact = new ImpactAnalyzer().analyze(delta.delta, graph, graph.profile, { repositoryFiles: delta.inventory?.files });
  const registry = buildGenericTaskRegistry(graph.profile, "typescript", parseRepositoryWorkflows(graph.profile, repoPath));
  const plan = new DefaultCIPlanner(registry).plan({ delta: delta.delta, impact, profile: graph.profile });
  return { advisoryOnly: true, base, head, plan, impact };
}
