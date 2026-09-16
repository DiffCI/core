// SPDX-License-Identifier: AGPL-3.0-only
import type { RepositoryProfile } from "../../repo/types.js";
import type { CITaskDefinition, TaskRegistry } from "../../planner/task-registry.js";
import { createTaskRegistry } from "../../planner/task-registry.js";
import type { ParsedWorkflow } from "./workflow-parser.js";

export function buildGenericTaskRegistry(profile: RepositoryProfile, language: string, parsedWorkflows: ParsedWorkflow[]): TaskRegistry {
  const definitions: CITaskDefinition[] = [];
  const definitionsById = (id: string): CITaskDefinition | undefined => definitions.find((d) => d.id === id);
  for (const workflow of parsedWorkflows) {
    for (const task of workflow.tasks) {
      const inputs = task.pathGlobs && task.pathGlobs.length > 0 ? task.pathGlobs : defaultTaskInputGlobs(task.category, language);
      definitions.push({
        id: task.id,
        command: `${workflow.name ?? workflow.path} / ${task.name ?? task.id}`,
        category: (task.category as CITaskDefinition["category"]) ?? "validation",
        alwaysRun: false,
        description: `Workflow job ${task.name ?? task.id}`,
        inputPatterns: inputs,
        globalRiskTriggers: defaultGlobalRiskTriggers(task.category),
        hasTestCommand: task.hasTestCommand,
      });
    }
  }
  for (const task of buildStandardTasks(profile, language)) {
    if (!definitionsById(task.id)) definitions.push(task);
  }
  if (definitions.length === 0) {
    definitions.push({ id: "ci:default", command: "ci", category: "validation", alwaysRun: false, description: "Default CI placeholder.", inputPatterns: ["**/*"], globalRiskTriggers: ["CONFIG_GLOBAL"] });
  }
  for (const def of definitions) {
    if (def.category === "infrastructure" || def.category === "security" || def.id.includes("database")) def.alwaysRun = true;
  }
  return createTaskRegistry(definitions);
}

function buildStandardTasks(profile: RepositoryProfile, language: string): CITaskDefinition[] {
  const tasks: CITaskDefinition[] = [];
  const scripts = profile.packageJson.scripts;
  const hasScript = (name: string): boolean => scripts[name] !== undefined;
  if (hasScript("build") || hasScript("build:prod")) {
    tasks.push({ id: "build", command: scripts["build"] ?? "npm run build", category: "build", inputPatterns: languageInputGlobs(language, true), globalRiskTriggers: ["CONFIG_GLOBAL", "DEPENDENCY_MANIFEST", "LOCKFILE_GLOBAL"] });
  }
  if (hasScript("typecheck") || hasScript("tsc") || hasScript("types")) {
    tasks.push({ id: "typecheck", command: scripts["typecheck"] ?? "npm run typecheck", category: "typecheck", inputPatterns: languageInputGlobs(language, false), globalRiskTriggers: ["CONFIG_GLOBAL", "DEPENDENCY_MANIFEST", "LOCKFILE_GLOBAL"] });
  }
  if (hasScript("lint") || hasScript("eslint") || hasScript("biome")) {
    tasks.push({ id: "lint", command: scripts["lint"] ?? "npm run lint", category: "lint", inputPatterns: lintInputGlobs(language), globalRiskTriggers: ["CONFIG_GLOBAL"] });
  }
  if (hasScript("test") || hasScript("test:unit") || hasScript("test:ci")) {
    tasks.push({ id: "test:unit", command: scripts["test"] ?? "npm run test", category: "test", inputPatterns: testInputGlobs(language), globalRiskTriggers: ["CONFIG_GLOBAL", "LOCKFILE_GLOBAL"] });
  }
  tasks.push({ id: "security:default", command: "npm audit --audit-level=moderate", category: "security", alwaysRun: true, inputPatterns: ["package*.json"], globalRiskTriggers: ["CONFIG_GLOBAL", "WORKFLOW_GLOBAL"] });
  tasks.push({ id: "infrastructure:default", command: "terraform validate --check", category: "infrastructure", alwaysRun: true, inputPatterns: ["ops/**/*", "terraform/**/*", "Dockerfile*", "docker/**/*", ".github/workflows/*"], globalRiskTriggers: ["INFRASTRUCTURE_GLOBAL", "WORKFLOW_GLOBAL"] });
  return tasks;
}

function languageInputGlobs(language: string, includeConfig: boolean): string[] {
  if (language === "javascript" || language === "typescript") {
    const globs = ["src/**/*", "lib/**/*", "scripts/**/*"];
    if (includeConfig) globs.push("package*.json", "tsconfig*.json", "next.config.*");
    return globs;
  }
  return ["**/*"];
}

function lintInputGlobs(language: string): string[] {
  if (language === "javascript" || language === "typescript") {
    return ["src/**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}", "scripts/**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}", "eslint.config.*", ".eslintrc*", "biome.json"];
  }
  return ["**/*"];
}

function testInputGlobs(language: string): string[] {
  if (language === "javascript" || language === "typescript") return ["src/**/*.test.{ts,tsx,js,jsx,mjs,cjs,mts,cts}", "tests/**/*", "test/**/*", "**/__tests__/**/*"];
  return ["**/*test*"];
}

function defaultTaskInputGlobs(category: string | undefined, language: string): string[] {
  if (category === "test") return testInputGlobs(language);
  if (category === "lint") return lintInputGlobs(language);
  if (category === "typecheck") return languageInputGlobs(language, false);
  if (category === "build") return languageInputGlobs(language, true);
  if (category === "security") return ["**/*"];
  if (category === "infrastructure") return ["ops/**/*", "terraform/**/*", "Dockerfile*", ".github/workflows/*"];
  return ["**/*"];
}

function defaultGlobalRiskTriggers(category: string | undefined): string[] {
  if (category === "build" || category === "typecheck") return ["CONFIG_GLOBAL", "DEPENDENCY_MANIFEST", "LOCKFILE_GLOBAL"];
  if (category === "infrastructure") return ["INFRASTRUCTURE_GLOBAL", "WORKFLOW_GLOBAL"];
  if (category === "security") return ["WORKFLOW_GLOBAL", "INFRASTRUCTURE_GLOBAL"];
  if (category === "test") return ["CONFIG_GLOBAL", "LOCKFILE_GLOBAL"];
  return ["CONFIG_GLOBAL"];
}
