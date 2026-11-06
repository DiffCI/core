// SPDX-License-Identifier: MIT
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { isPlaywrightSpec, nextAppRoute, routeMatches, visitedRoutes } from "../../src/repo/route-visits.js";

describe("route visits (2026-11-06)", () => {
  it("recognises Playwright specs by their import", () => {
    assert.ok(isPlaywrightSpec("import { test, expect } from '@playwright/test';"));
    assert.ok(isPlaywrightSpec('const { test } = require("@playwright/test");'));
    assert.ok(!isPlaywrightSpec("import { test } from 'vitest'; page.goto('/x');"));
  });

  it("reads literal visits and notices computed ones", () => {
    const source = [
      "await page.goto('/blog/hello?ref=1');",
      'await page.goto("http://localhost:3000/about/#team");',
      "await page.goto(`/pricing`);",
      "await request.post('/api/orders', { data });",
      "await page.goto('');",
    ].join("\n");
    assert.deepEqual(visitedRoutes(source), { paths: ["/", "/about", "/api/orders", "/blog/hello", "/pricing"], computed: false });
    assert.equal(visitedRoutes("await page.goto(`/blog/${slug}`);").computed, true);
    assert.equal(visitedRoutes("await page.goto(url);").computed, true);
  });

  it("maps App Router files to routes, dropping groups and slots", () => {
    assert.deepEqual(nextAppRoute("src/app/(marketing)/blog/[slug]/page.tsx", "next-page"), { segments: ["blog", "[slug]"], scope: "exact" });
    assert.deepEqual(nextAppRoute("app/dashboard/@stats/layout.tsx", "next-layout"), { segments: ["dashboard"], scope: "prefix" });
    assert.deepEqual(nextAppRoute("app/api/orders/route.ts", "next-route"), { segments: ["api", "orders"], scope: "exact" });
    assert.deepEqual(nextAppRoute("src/middleware.ts", "next-api"), { segments: [], scope: "all" });
    assert.equal(nextAppRoute("pages/blog/page.tsx", "next-page"), undefined, "not the App Router");
    assert.equal(nextAppRoute("app/feed/(..)photo/[id]/page.tsx", "next-page"), undefined, "intercepting routes are not modelled");
  });

  it("matches URLs the way Next serves them", () => {
    const route = (segments: string[], scope: "exact" | "prefix" = "exact") => ({ segments, scope });
    assert.ok(routeMatches(route([]), "/"));
    assert.ok(!routeMatches(route([]), "/about"));
    assert.ok(routeMatches(route([], "prefix"), "/about"));
    assert.ok(routeMatches(route(["blog", "[slug]"]), "/blog/hello"));
    assert.ok(!routeMatches(route(["blog", "[slug]"]), "/blog"));
    assert.ok(routeMatches(route(["docs", "[...slug]"]), "/docs/a/b"));
    assert.ok(!routeMatches(route(["docs", "[...slug]"]), "/docs"));
    assert.ok(routeMatches(route(["docs", "[[...slug]]"]), "/docs"));
    assert.ok(routeMatches(route(["dashboard"], "prefix"), "/dashboard/settings"));
    assert.ok(!routeMatches(route(["dashboard"], "prefix"), "/dash"));
  });
});
