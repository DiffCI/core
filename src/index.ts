// SPDX-License-Identifier: AGPL-3.0-only
export { analyzeGitDelta, EMPTY_TREE_SHA } from "./git/git-diff.js";
export { analyzeRepository } from "./repo/analyzer.js";
export { buildDependencyGraph, graphToJson } from "./repo/graph.js";
export { ImpactAnalyzer } from "./repo/impact.js";
export { DefaultCIPlanner } from "./planner/planner.js";
export { createTaskRegistry } from "./planner/task-registry.js";
export { planSelectiveTestCommands } from "./planner/test-command.js";
export { explain } from "./planner/explain.js";
export { collectEvidence } from "./ci-inference/evidence.js";
export { inferPipeline } from "./ci-inference/infer.js";
export { GraphCache, buildGraphCacheKey } from "./cache/graph-cache.js";
export { analyzeCheckout } from "./analyze.js";
export { measure, estimateImpact } from "./measurement.js";
export type { ExecutionPlan, CommandSpec } from "./planner/types.js";
export type { ImpactResult } from "./repo/impact-types.js";
export type { DependencyGraphResult, RepositoryProfile } from "./repo/types.js";
