#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
import { parseArgs } from "node:util";
import { analyzeCheckout } from "./analyze.js";

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    repo: { type: "string", default: process.cwd() }, base: { type: "string" }, head: { type: "string", default: "HEAD" },
    help: { type: "boolean", short: "h" }
  } });
  if (values.help || positionals.length === 0) {
    console.log("Usage: diffci plan --repo <clean-checkout> --base <commit> [--head HEAD]\nOutputs an advisory JSON plan. Does not execute, skip or cancel CI jobs.");
  } else {
    if (positionals.length !== 1 || positionals[0] !== "plan" || !values.base) throw new Error("Expected: diffci plan --repo <path> --base <commit> [--head HEAD]");
    console.log(JSON.stringify(await analyzeCheckout({ repoPath: values.repo!, base: values.base, head: values.head! }), null, 2));
  }
} catch (error) {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error), recommendation: "RUN_FULL_CI" }));
  process.exitCode = 1;
}
