// SPDX-License-Identifier: MIT
// Runs inside the DiffCI change impact Action after `diffci observe`. It reads the written report and
//   1. sets step outputs a workflow can act on (affected-tests, full-suite-required, ...), and
//   2. when asked (`comment: true`), keeps one PR comment up to date with the same answer.
// No dependencies: it runs on the Node the Action already set up, outside the observed checkout, and
// never fails the step - outputs and the comment are conveniences; the report artifact is the record.
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Tests listed by name in the comment before the rest collapse into a count. */
const MAX_LISTED_TESTS = 10;
/** GitHub caps all of a job's outputs at 1 MB; a selection bigger than this is left out, not cut short. */
const MAX_TESTS_OUTPUT_BYTES = 512 * 1024;
const MAX_COMMENT_PAGES = 20;

function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

/** Inline code that survives any path: no backticks to close it early, no pipes to split a table cell. */
function code(text) {
  return `\`${String(text).replace(/`/g, "'").replace(/\|/g, "\\|")}\``;
}

/** Prose from the report (fallback reasons name packages such as `@scope/pkg`) must never mention anyone. */
function prose(text) {
  return String(text).replace(/@/g, "@\u200b").replace(/\r?\n/g, " ");
}

function readableReason(reason) {
  return /^[A-Z0-9_]+$/.test(reason) ? reason.toLowerCase().replace(/_/g, " ") : reason;
}

/**
 * The step outputs for a report (or for no report at all). `full-suite-required` is the safe answer
 * by default: it is "false" only for a clean SELECTIVE observation, so a workflow that trusts it can
 * never narrow on a refusal, an error, a blind spot or a changed working tree.
 */
export function impactOutputs(report) {
  const result = report?.status === "OBSERVED" ? report.result : undefined;
  const narrowable = Boolean(
    result &&
      result.mode === "SELECTIVE" &&
      !result.blindSpot &&
      report.nonInterference?.worktreeUnchanged !== false &&
      Array.isArray(result.selectedTests),
  );
  let reason = "";
  if (!report) reason = "DiffCI wrote no report";
  else if (!result) reason = report.reason || `${String(report.status).toLowerCase()} at ${report.stage}`;
  else if (!narrowable) reason = result.fallbackReasons?.[0] || (result.blindSpot ? "no test files were discovered" : "the full suite is needed");

  // Redacted paths are digests, which no test runner can run. Leaving the list empty (not "[]") makes
  // a workflow that feeds it to fromJSON fail loudly instead of running nothing.
  const redacted = Boolean(report?.payload?.pathRedaction);
  let affectedTests = "";
  if (narrowable && !redacted) {
    const json = JSON.stringify(result.selectedTests);
    if (Buffer.byteLength(json) <= MAX_TESTS_OUTPUT_BYTES) affectedTests = json;
  }
  return {
    "full-suite-required": narrowable ? "false" : "true",
    "affected-tests": affectedTests,
    "affected-test-count": result ? String(result.selectedTests?.length ?? 0) : "",
    "total-test-count": result ? String(result.totalTestCount ?? "") : "",
    reason: prose(reason),
  };
}

/** The first line of every DiffCI comment, so a rerun finds and updates its own instead of adding one. */
export function commentMarker(key) {
  return `<!-- diffci-change-impact:${String(key).replace(/-->/g, "")} -->`;
}

/** A short PR comment: the headline and why, with the full detail one click away in the job summary. */
export function formatComment(report, { marker, runUrl }) {
  const lines = [marker, "### DiffCI: what this change affects", ""];
  const result = report.status === "OBSERVED" ? report.result : undefined;
  if (!result) {
    lines.push(`**No plan for this change** (${prose(String(report.status).toLowerCase())} at ${prose(report.stage)}).`);
    if (report.reason) lines.push("", prose(report.reason));
  } else if (result.mode === "FULL") {
    lines.push(
      `**The full test suite is needed** for ${plural(result.changedFileCount, "changed file")}: DiffCI could not prove which of the ${plural(result.totalTestCount, "test file")} this change leaves untouched.`,
    );
    const reasons = result.fallbackReasons ?? [];
    if (reasons.length > 0) {
      lines.push("", "Why:");
      for (const reason of reasons.slice(0, 5)) lines.push(`- ${prose(reason)}`);
      if (reasons.length > 5) lines.push(`- and ${reasons.length - 5} more`);
    }
  } else {
    const selected = result.selectedTests.length;
    lines.push(
      `**${selected} of ${plural(result.totalTestCount, "test file")}** ${selected === 1 ? "is" : "are"} affected by ${plural(result.changedFileCount, "changed file")}.`,
    );
    if (selected > 0) {
      const why = result.selectionReasons ?? {};
      lines.push("", `<details><summary>Why these ${plural(selected, "test")}</summary>`, "", "| Test | Because |", "| --- | --- |");
      for (const test of result.selectedTests.slice(0, MAX_LISTED_TESTS)) {
        const entry = why[test];
        const because = entry
          ? `${prose(readableReason(entry.reason))}${entry.changed_file ? ` from ${code(entry.changed_file)}` : ""}`
          : "affected by the change";
        lines.push(`| ${code(test)} | ${because} |`);
      }
      if (selected > MAX_LISTED_TESTS) lines.push(`| and ${selected - MAX_LISTED_TESTS} more | see the job summary |`);
      lines.push("", "</details>");
    }
  }
  if (report.nonInterference?.worktreeUnchanged === false) {
    lines.push("", "> [!WARNING]", "> The working tree changed while DiffCI observed it. Please report this at https://github.com/DiffCI/core/issues.");
  }
  lines.push(
    "",
    `<sub>${runUrl ? `[Details in the job summary](${runUrl}) · ` : ""}Observation only: DiffCI skipped and changed nothing. Via [DiffCI](https://github.com/DiffCI/core), open source (MIT).</sub>`,
  );
  return lines.join("\n");
}

function writeOutputs(outputs, file) {
  if (!file) return;
  appendFileSync(file, Object.entries(outputs).map(([name, value]) => `${name}=${value}\n`).join(""));
}

function warn(message) {
  console.log(`::warning title=DiffCI PR comment::${message.replace(/\r?\n/g, " ")}`);
}

async function github(env, method, path, body) {
  const response = await fetch(`${env.GITHUB_API_URL || "https://api.github.com"}${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env.DIFFCI_GITHUB_TOKEN}`,
      "content-type": "application/json",
      "user-agent": "diffci-change-impact-action",
      "x-github-api-version": "2022-11-28",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const error = new Error(`${method} ${path} returned ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.status === 204 ? undefined : response.json();
}

/** Creates or updates this job's single DiffCI comment on the pull request. Returns what it did. */
export async function upsertComment(env, report) {
  if (!env.DIFFCI_GITHUB_TOKEN) return "skipped: no github-token";
  let event;
  try {
    event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  } catch {
    return "skipped: no event payload";
  }
  const number = event?.pull_request?.number;
  if (!number) return "skipped: not a pull request event";

  const repo = env.GITHUB_REPOSITORY;
  const marker = commentMarker(`${env.GITHUB_WORKFLOW ?? ""}/${env.GITHUB_JOB ?? ""}`);
  const runUrl = env.GITHUB_SERVER_URL && env.GITHUB_RUN_ID
    ? `${env.GITHUB_SERVER_URL}/${repo}/actions/runs/${env.GITHUB_RUN_ID}`
    : undefined;
  const body = formatComment(report, { marker, runUrl });

  let existing;
  for (let page = 1; page <= MAX_COMMENT_PAGES && !existing; page++) {
    const comments = await github(env, "GET", `/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`);
    existing = comments.find((comment) => typeof comment.body === "string" && comment.body.startsWith(marker));
    if (comments.length < 100) break;
  }
  if (existing) {
    if (existing.body === body) return "unchanged";
    await github(env, "PATCH", `/repos/${repo}/issues/comments/${existing.id}`, { body });
    return "updated";
  }
  await github(env, "POST", `/repos/${repo}/issues/${number}/comments`, { body });
  return "created";
}

export async function main(env = process.env) {
  let report;
  if (env.DIFFCI_REPORT) {
    try {
      report = JSON.parse(readFileSync(env.DIFFCI_REPORT, "utf8"));
    } catch {
      report = undefined;
    }
  }
  try {
    writeOutputs(impactOutputs(report), env.GITHUB_OUTPUT);
  } catch {
    // Outputs are a convenience; the report artifact is the record.
  }
  if (env.DIFFCI_COMMENT !== "true" || !report) return;
  try {
    const outcome = await upsertComment(env, report);
    console.log(`DiffCI PR comment: ${outcome}`);
  } catch (error) {
    const status = error?.status;
    warn(
      status === 403 || status === 404
        ? `could not comment (${status}). Give the job "permissions: pull-requests: write"; pull requests from forks get a read-only token, so they get no comment.`
        : `could not comment: ${error?.message ?? error}`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
