// SPDX-License-Identifier: AGPL-3.0-only
import type { TaskRegistry } from "../../planner/task-registry.js";
import { matchesAny } from "./matcher.js";
import type { ChangedFile } from "../../git/types.js";

export interface GenericPathBaselineResult {
  selectedTaskIds: string[];
  fallbackRequired: boolean;
  fallbackReasons: string[];
  matchedRules: string[];
}

export function runGenericPathBaseline(taskRegistry: TaskRegistry, changedFiles: ChangedFile[]): GenericPathBaselineResult {
  const changedPaths = changedFiles.map((f) => f.path.replace(/\\/g, "/"));
  const matchedRules: string[] = [];
  const allTasks = taskRegistry.all();

  const alwaysRunTaskIds = allTasks.filter((t) => t.alwaysRun).map((t) => t.id);

  const docsOnly = changedPaths.every((p) => p.endsWith(".md") || p.endsWith(".mdx") || p.startsWith("docs/") || p.startsWith("README"));
  if (docsOnly) {
    matchedRules.push("docs-only -> skip non-always-run tasks");
    return { selectedTaskIds: alwaysRunTaskIds, fallbackRequired: false, fallbackReasons: [], matchedRules };
  }

  if (changedPaths.some((p) => globalFallbackPattern(p))) {
    matchedRules.push("global/dependency/config/workflow -> full fallback");
    return {
      selectedTaskIds: allTasks.map((t) => t.id),
      fallbackRequired: true,
      fallbackReasons: ["config/dependency/workflow/infrastructure/database change triggers full fallback"],
      matchedRules,
    };
  }

  const selected = new Set<string>();
  for (const task of allTasks) {
    if (task.alwaysRun || changedPaths.some((p) => matchesAny(p, task.inputPatterns))) {
      selected.add(task.id);
      matchedRules.push(`${task.id} selected by path match or always-run policy`);
    }
  }

  if (selected.size === 0) {
    matchedRules.push("no matching path rules -> run all tasks");
    return { selectedTaskIds: allTasks.map((t) => t.id), fallbackRequired: true, fallbackReasons: ["no matching path rules"], matchedRules };
  }

  return { selectedTaskIds: Array.from(selected), fallbackRequired: false, fallbackReasons: [], matchedRules };
}

function globalFallbackPattern(path: string): boolean {
  const p = path.toLowerCase();
  if (["package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb", "go.mod", "go.sum", "requirements.txt", "setup.py", "pyproject.toml", "cargo.toml", "cargo.lock", "pom.xml", "build.gradle", "gradle.lockfile"].includes(p)) return true;
  if (p.startsWith(".github/workflows/")) return true;
  if (p.startsWith("database/") || p.startsWith("migrations/")) return true;
  if (p.startsWith("ops/") || p.startsWith("terraform/") || p.startsWith("docker") || p.includes("dockerfile")) return true;
  if (p.startsWith("tsconfig") || p.startsWith("next.config") || p.startsWith("eslint.config") || p.startsWith(".eslintrc") || p.startsWith("vitest.config") || p.startsWith("jest.config")) return true;
  return false;
}
