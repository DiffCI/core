# Add a repository adapter

Begin with `src/repo/adapters/types.ts`, then read `vue.ts`, `go.ts`, or `maven.ts` and their cases in `tests/repo/language-adapters.test.ts`. Propose the supported configuration in an issue before building a large adapter.

1. Add `src/repo/adapters/<name>.ts` implementing `RepositoryAdapter`: stable `id` and `version`, `kind`, `detect(context)`, and `analyze(context)`.
2. Start the result with `contribution(adapter)`. Return original source identities, test files, dependency edges, and virtual sources only where the existing TS resolver can understand them. Use `testPackages` for package ownership. Do not invent an empty successful graph when parsing or resolution fails.
3. Record unresolved or unsupported configurations in `blockers` (global) or `fileBlockers` only where the uncertainty is confined to a known file. Missing edges cannot be dismissed by reachability.
4. Register the adapter in `REPOSITORY_ADAPTERS` in `src/repo/adapters/index.ts`. Verify detection does not claim unrelated repositories.
5. Add synthetic fixtures for a direct dependency, transitive dependency, unrelated change, and unsupported syntax. Assert affected tests and fallback behavior. Follow the existing `fixture()` helper and `try/finally` cleanup in `tests/repo/language-adapters.test.ts`.
6. Check command synthesis in `src/planner/test-command.ts`. An advisory graph without a runnable command must remain advisory. Add command coverage tests for the runner options you support.

## Worked example: manifest dependencies

Suppose a repository declares components in `*.component.json` files with this shape:

```json
{"source":"src/button.ts","test":"test/button.test.ts","dependsOn":"src/theme.ts"}
```

The smallest useful adapter detects that explicit declaration, starts with `contribution()`, and refuses to claim a complete graph when any declared path cannot be resolved:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  contribution,
  type AdapterContribution,
  type RepositoryAdapter,
} from "./types.js";

interface ComponentManifest {
  source: string;
  test: string;
  dependsOn?: string;
}

function isManifest(value: unknown): value is ComponentManifest {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.source === "string"
    && typeof record.test === "string"
    && (record.dependsOn === undefined || typeof record.dependsOn === "string");
}

export const componentManifestAdapter: RepositoryAdapter = {
  id: "component-manifest",
  version: "1",
  kind: "framework",

  detect: ({ files }) => files.some((path) => path.endsWith(".component.json")),

  analyze(context): AdapterContribution {
    const result = contribution(this);
    const known = new Set(context.files);

    for (const path of context.files.filter((file) => file.endsWith(".component.json"))) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(join(context.repoPath, path), "utf8"));
      } catch {
        result.blockers.push(`Cannot parse component manifest: ${path}`);
        continue;
      }

      if (!isManifest(parsed)) {
        result.blockers.push(`Invalid component manifest: ${path}`);
        continue;
      }

      const declared = [parsed.source, parsed.test, parsed.dependsOn].filter(
        (candidate): candidate is string => candidate !== undefined,
      );
      const missing = declared.filter((candidate) => !known.has(candidate));
      if (missing.length) {
        // A missing dependency may connect otherwise unrelated graph regions.
        // Reachability cannot prove that uncertainty irrelevant.
        result.blockers.push(`Unresolved component paths in ${path}: ${missing.join(", ")}`);
        continue;
      }

      result.sourcePaths.push(parsed.source, parsed.test);
      result.testFiles.push(parsed.test);
      result.edges.push({ from: parsed.test, to: parsed.source, kind: "import" });
      if (parsed.dependsOn) {
        result.sourcePaths.push(parsed.dependsOn);
        result.edges.push({ from: parsed.source, to: parsed.dependsOn, kind: "import" });
      }
    }

    if (!result.sourcePaths.length && !result.blockers.length) {
      result.blockers.push("Component manifests produced no supported sources");
    }
    return result;
  },
};
```

Register `componentManifestAdapter` in `REPOSITORY_ADAPTERS`, then test detection against both matching and unrelated repositories. Deduplicate paths if several manifests may declare the same file; the example stays small to show the safety contract.

`blockers` invalidate selective planning for the analyzed graph. Use them for parse failures, unresolved dependency targets, dynamic configuration, or any uncertainty that could hide an edge. Returning empty arrays without a blocker would incorrectly present “nothing was affected” as established evidence.

`fileBlockers` are narrower: they identify uncertainty already proven to originate from one known file. They are appropriate only when the adapter's graph integration explicitly evaluates whether that file is reachable from the change. Merely adding a `fileBlockers` entry does not make an unknown dependency local, and current adapter-specific narrowing must be covered by positive and negative reachability tests. When in doubt, use a global `blockers` entry and require full validation.

Run the checks in `CONTRIBUTING.md`. Include exact support boundaries and fallback cases in the PR. A new language is usually larger than a first contribution; one regression fixture is a better starting point.
