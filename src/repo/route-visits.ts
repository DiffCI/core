// SPDX-License-Identifier: MIT
/**
 * End-to-end specs selected by the routes they visit (2026-11-06).
 *
 * WHY. A Playwright spec reaches the application through a URL, not an import: `page.goto("/blog/x")`
 * exercises `app/blog/[slug]/page.tsx` without naming it. The dependency graph sees no edge, so a change
 * to that page selected no end-to-end spec at all, a silent skip wherever the suite runs them.
 *
 * WHAT. A spec is a Playwright spec when it imports `@playwright/test`. The URLs it visits are read from
 * literal `.goto(...)` and `request.get/post/...(...)` calls. A Next.js App Router entry point maps to a
 * route pattern (route groups and parallel slots dropped, `[x]`, `[...x]` and `[[...x]]` matched as Next
 * matches them); a page or route handler matches its own route, a layout, loading, error, template or
 * not-found file every route under it, and middleware every route. A spec visiting a URL built at run time
 * (a template with `${}` or a variable) is selected whenever any entry point is affected, as is every spec
 * when an affected entry point's route cannot be derived: an unknown visit is not a negative.
 */

export interface RouteVisits {
  /** Literal paths the spec visits, origin, query and hash removed. */
  paths: string[];
  /** True when some visit's URL is computed at run time. */
  computed: boolean;
}

const PLAYWRIGHT_IMPORT = /(?:from\s+|require\(\s*|import\(\s*)['"]@playwright\/test['"]/;

export function isPlaywrightSpec(source: string): boolean {
  return PLAYWRIGHT_IMPORT.test(source);
}

function normalizeVisit(url: string): string {
  const withoutOrigin = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "");
  const path = withoutOrigin.replace(/[?#].*$/, "");
  const absolute = path.startsWith("/") ? path : `/${path}`;
  return absolute.length > 1 ? absolute.replace(/\/+$/, "") : "/";
}

export function visitedRoutes(source: string): RouteVisits {
  const paths = new Set<string>();
  let computed = false;
  const call = /(?:\.goto|\brequest\.(?:get|post|put|patch|delete|head|fetch))\(\s*(?:(['"])((?:\\.|(?!\1).)*)\1|`((?:\\.|[^`\\])*)`|([^\s)]))/g;
  for (const match of source.matchAll(call)) {
    const quoted = match[2];
    const template = match[3];
    if (quoted !== undefined) paths.add(normalizeVisit(quoted));
    else if (template !== undefined && !template.includes("${")) paths.add(normalizeVisit(template));
    else computed = true;
  }
  return { paths: [...paths].sort(), computed };
}

export type RouteScope = "exact" | "prefix" | "all";

/** The route pattern an App Router entry point serves, or undefined when the path is not under `app/`. */
export function nextAppRoute(entryPath: string, kind: string): { segments: string[]; scope: RouteScope } | undefined {
  const parts = entryPath.split("/");
  const base = (parts[parts.length - 1] ?? "").replace(/\.[^.]+$/, "");
  if (base === "middleware") return { segments: [], scope: "all" };
  const appIndex = parts.lastIndexOf("app");
  if (appIndex < 0 || appIndex === parts.length - 1) return undefined;
  const segments = parts.slice(appIndex + 1, -1)
    .filter((segment) => !/^\(.*\)$/.test(segment) && !segment.startsWith("@"));
  if (segments.some((segment) => segment.startsWith("("))) return undefined; // intercepting routes
  const exact = kind === "next-page" || kind === "next-route" || kind === "next-api" || base === "page" || base === "route";
  return { segments, scope: exact ? "exact" : "prefix" };
}

/** Whether `path` (a visited URL path) is served by the route `segments` under `scope`. */
export function routeMatches(route: { segments: string[]; scope: RouteScope }, path: string): boolean {
  if (route.scope === "all") return true;
  const url = path.split("/").filter(Boolean).map((part) => { try { return decodeURIComponent(part); } catch { return part; } });
  const match = (r: number, u: number): boolean => {
    if (r === route.segments.length) return route.scope === "prefix" || u === url.length;
    const segment = route.segments[r]!;
    if (/^\[\[\.\.\..+\]\]$/.test(segment)) {
      for (let next = u; next <= url.length; next += 1) if (match(r + 1, next)) return true;
      return false;
    }
    if (/^\[\.\.\..+\]$/.test(segment)) {
      for (let next = u + 1; next <= url.length; next += 1) if (match(r + 1, next)) return true;
      return false;
    }
    if (u >= url.length) return false;
    if (/^\[.+\]$/.test(segment)) return match(r + 1, u + 1);
    return segment === url[u] && match(r + 1, u + 1);
  };
  return match(0, 0);
}
