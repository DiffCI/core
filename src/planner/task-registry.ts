import type { TaskCategory } from "./types.js";

export type CITaskCategory = TaskCategory;

export interface CITaskDefinition {
  id: string;
  command: string;
  category: CITaskCategory;
  alwaysRun?: boolean;
  description?: string;
  npmScript?: string;
  inputPatterns?: string[];
  globalRiskTriggers?: string[];
  /** Stage 2C (2026-08-21) measurement-pipeline repair - see src/research/baseline/test-activity.ts.
   * Purely additive/optional; never read by any selection, fallback, or risk-trigger logic - only by
   * evidence-collector.ts's filterToTestCategoryTaskIds at reconciliation time. */
  hasTestCommand?: boolean;
}

export interface TaskRegistry {
  all(): CITaskDefinition[];
  get(id: string): CITaskDefinition | undefined;
  tasksByCategory(category: CITaskCategory): CITaskDefinition[];
  alwaysRunTasks(): CITaskDefinition[];
}

function wildcardToRegex(pattern: string): RegExp {
  let escaped = pattern
    .replace(/\\/g, "\\\\")
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, "\0GLOBSTAR\0")
    .replace(/\*/g, "[^/]*");
  escaped = escaped.replace(/\0GLOBSTAR\0/g, ".*");
  return new RegExp(`^${escaped}$`);
}

class InMemoryTaskRegistry implements TaskRegistry {
  private readonly definitions: Map<string, CITaskDefinition>;

  constructor(definitions: CITaskDefinition[]) {
    this.definitions = new Map();
    for (const def of definitions) {
      this.definitions.set(def.id, def);
    }
  }

  all(): CITaskDefinition[] {
    return Array.from(this.definitions.values());
  }

  get(id: string): CITaskDefinition | undefined {
    return this.definitions.get(id);
  }

  tasksByCategory(category: CITaskCategory): CITaskDefinition[] {
    return this.all().filter((t) => t.category === category);
  }

  alwaysRunTasks(): CITaskDefinition[] {
    return this.all().filter((t) => t.alwaysRun === true);
  }

  matchesInputPattern(taskId: string, paths: string[]): boolean {
    const task = this.definitions.get(taskId);
    if (!task || !task.inputPatterns || task.inputPatterns.length === 0) return false;
    const regexes = task.inputPatterns.map(wildcardToRegex);
    return paths.some((p) => regexes.some((re) => re.test(p)));
  }
}

export function createTaskRegistry(definitions: CITaskDefinition[]): TaskRegistry {
  return new InMemoryTaskRegistry(definitions);
}

