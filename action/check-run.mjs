// SPDX-License-Identifier: MIT
// Runs inside the DiffCI change impact Action after the fast check, only with `check-run: "true"`.
// It posts one completed check run, the "DiffCI merge gate", on the pull request's head commit, so a
// branch protection rule can require it by a name that does not depend on the workflow's job names.
//
//   success  - the fast check ran the affected tests (and checks) and they passed
//   failure  - they failed
//   neutral  - DiffCI could not narrow the change, could not verify it, or verify is off. The
//              repository's own full test job decides; DiffCI never turns a pull request red by itself.
//
// It also says which AI coding agent wrote the change, read from the commits' co-author trailers and
// the pull request's head branch. Only a fixed label is ever written (never a name, email or branch),
// and when nothing matches it says "none detected", not "human".
//
// No dependencies, and it never fails the step: the verdict is the check run itself, and the fast
// check step already failed when the tests did.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const DEFAULT_CHECK_NAME = "DiffCI merge gate";
/** Commits read for agent markers; a longer pull request is attributed from its newest commits. */
const MAX_COMMITS = 250;
const MAX_REASONS = 5;
const MAX_LISTED_CHECKS = 20;

/**
 * Agent markers, in the order they are reported. The trailer rules follow the red-build studies'
 * agent_authorship.py; the labels are agent-identity.ts's KNOWN_AGENTS, so receipts and gates agree.
 */
const TRAILER_RULES = [
  ["claude", /^co-authored-by:[^\n]*\b(claude|anthropic)\b/im],
  ["claude", /generated with \[?claude code/i],
  ["codex", /^co-authored-by:[^\n]*\b(codex|openai)\b/im],
  ["codex", /generated with \[?codex/i],
  ["cursor", /^co-authored-by:[^\n]*\bcursor/im],
  ["copilot", /^co-authored-by:[^\n]*\bcopilot\b/im],
  ["devin", /^co-authored-by:[^\n]*\bdevin/im],
  ["gemini", /^co-authored-by:[^\n]*\bgemini\b/im],
  ["jules", /^co-authored-by:[^\n]*\bjules\b/im],
  ["openhands", /^co-authored-by:[^\n]*\bopenhands\b/im],
  ["aider", /^co-authored-by:[^\n]*\baider\b/im],
];
const BRANCH_RULE = /^(claude|codex|copilot|cursor|devin|jules|openhands)[/-]/i;

/**
 * Which agents wrote the change. `messages` are commit messages; `branch` is the head branch name.
 * Returns sorted labels and where each was seen, or an empty list. Nothing from the input is returned.
 */
export function detectAgents({ messages = [], branch = "" } = {}) {
  const found = new Map();
  for (const message of messages) {
    for (const [agent, rule] of TRAILER_RULES) {
      if (rule.test(message)) found.set(agent, found.get(agent) === "branch" ? "trailer+branch" : "trailer");
    }
  }
  const match = BRANCH_RULE.exec(String(branch));
  if (match) {
    const agent = match[1].toLowerCase();
    const seen = found.get(agent);
    found.set(agent, seen === "trailer" || seen === "trailer+branch" ? "trailer+branch" : "branch");
  }
  return [...found.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([agent, source]) => ({ agent, source }));
}

/** Short label for outputs and the title: "claude", "claude+codex", or "none detected". */
export function agentLabel(agents) {
  return agents.length === 0 ? "none detected" : agents.map(({ agent }) => agent).join("+");
}

function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

/** Prose from the report or receipt must never mention anyone or break the markdown. */
function prose(text) {
  return String(text).replace(/@/g, "@\u200b").replace(/\r?\n/g, " ").slice(0, 300);
}

function code(text) {
  return `\`${String(text).replace(/`/g, "'").replace(/\|/g, "\\|")}\``;
}

/**
 * The check run's conclusion and output from what the Action already produced. Pure, so every case is
 * testable without GitHub: `verifyEnabled` is the `verify` input, `verifyStatus` the fast check's
 * status output ("" when it did not run), `receipt` the verification receipt and `report` the observation.
 */
export function gateVerdict({ verifyEnabled, verifyStatus, report, receipt, agents = [], runUrl, uploaded = false }) {
  const agent = agentLabel(agents);
  const result = report?.status === "OBSERVED" ? report.result : undefined;
  let conclusion;
  let headline;
  let detail;

  if (!verifyEnabled) {
    conclusion = "neutral";
    headline = "Observation only";
    detail = 'The merge gate needs the fast check: set `verify: "true"` on this step. Your full test job decides.';
  } else if (verifyStatus === "passed") {
    conclusion = "success";
    headline = "Affected tests passed";
    detail = "Every test this change affects passed on this commit. Your full test job still runs everything.";
  } else if (verifyStatus === "failed") {
    conclusion = "failure";
    headline = "Affected tests failed";
    detail = "A test or check this change affects failed. The fast check stopped at the first failing batch; fix it and push again.";
  } else if (verifyStatus === "skipped") {
    conclusion = "neutral";
    headline = "Full suite needed";
    detail = "DiffCI could not narrow this change, so it ran nothing here. Your full test job decides.";
  } else {
    conclusion = "neutral";
    headline = verifyStatus === "blocked" ? "Could not verify" : "Fast check did not run";
    detail = "DiffCI could not verify this change, so this gate does not block. Your full test job decides.";
  }

  const lines = [`**${headline}.** ${detail}`, ""];
  lines.push("| | |", "| --- | --- |");
  lines.push(`| Written by | ${agentCell(agents)} |`);
  if (receipt && receipt.selection === "selected") {
    lines.push(`| Tests run | ${plural(receipt.tests_selected ?? 0, "test file")} of ${receipt.tests_available ?? "?"} |`);
    const skipped = Math.max(0, (receipt.tests_available ?? 0) - (receipt.tests_selected ?? 0));
    lines.push(`| Not affected, not run here | ${plural(skipped, "test file")} (your full test job runs them) |`);
  } else if (receipt && receipt.selection === "full") {
    lines.push(`| Tests run | all ${plural(receipt.tests_available ?? 0, "test file")} |`);
  } else if (result) {
    lines.push(`| Affected tests | ${result.mode === "SELECTIVE" ? `${plural(result.selectedTests?.length ?? 0, "test file")} of ${result.totalTestCount ?? "?"}` : "all (full suite needed)"} |`);
  }
  if (result) lines.push(`| Changed files | ${result.changedFileCount ?? "?"} |`);
  const checks = Array.isArray(receipt?.checks) ? receipt.checks : [];
  if (checks.length > 0) {
    const listed = checks.slice(0, MAX_LISTED_CHECKS).map((check) => `${code(check.id)} ${prose(check.status)}`).join(", ");
    lines.push(`| Checks | ${listed}${checks.length > MAX_LISTED_CHECKS ? `, and ${checks.length - MAX_LISTED_CHECKS} more` : ""} |`);
  }
  const version = receipt?.diffci_version ?? report?.observer?.version;
  if (version) lines.push(`| DiffCI | ${prose(version)} |`);

  const reasons = (result?.mode === "SELECTIVE" ? [] : result?.fallbackReasons) ?? (report?.reason ? [report.reason] : []);
  if (conclusion === "neutral" && reasons.length > 0) {
    lines.push("", "Why the full suite is needed:");
    for (const reason of reasons.slice(0, MAX_REASONS)) lines.push(`- ${prose(reason)}`);
    if (reasons.length > MAX_REASONS) lines.push(`- and ${reasons.length - MAX_REASONS} more`);
  }
  // Say where the record is only when it exists: a skipped fast check writes no receipt, and
  // upload-artifact: "false" keeps both files on the runner.
  const kept = uploaded ? (receipt ? "The observation report and verification receipt are uploaded as an artifact. " : "The observation report is uploaded as an artifact. ") : "";
  lines.push(
    "",
    `${runUrl ? `[Plan and verification output](${runUrl}) · ` : ""}${kept}Via [DiffCI](https://github.com/DiffCI/core), open source (MIT).`,
  );

  return {
    conclusion,
    agent,
    title: `${headline} · agent: ${agent}`,
    summary: lines.join("\n"),
  };
}

function agentCell(agents) {
  if (agents.length === 0) return "no agent detected (from co-author trailers and the head branch)";
  return agents.map(({ agent, source }) => `${agent} (${source === "branch" ? "head branch" : source === "trailer" ? "co-author trailer" : "trailer and branch"})`).join(", ");
}

function readJson(path) {
  if (!path) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** Commit messages in base..head, newest first. Read-only; an unreadable range gives none. */
export function commitMessages(repo, base, head) {
  if (!repo || !head || !/^[0-9a-f]{7,64}$/i.test(head) || (base && !/^[0-9a-f]{7,64}$/i.test(base))) return [];
  try {
    const out = execFileSync(
      "git",
      ["-C", repo, "log", `--max-count=${MAX_COMMITS}`, "--format=%B%x00", base ? `${base}..${head}` : head],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
    );
    return out.split("\0").map((message) => message.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function warn(message) {
  console.log(`::warning title=DiffCI merge gate::${message.replace(/\r?\n/g, " ")}`);
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
  return response.json();
}

function writeOutputs(outputs, file) {
  if (!file) return;
  appendFileSync(file, Object.entries(outputs).map(([name, value]) => `${name}=${value}\n`).join(""));
}

export async function main(env = process.env) {
  let event;
  try {
    event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  } catch {
    event = undefined;
  }
  const report = readJson(env.DIFFCI_REPORT);
  const receipt = readJson(env.DIFFCI_RECEIPT);
  const pull = event?.pull_request;

  // The check belongs on the commit the pull request shows, not the merge commit GITHUB_SHA names.
  const headSha = env.DIFFCI_HEAD || pull?.head?.sha || report?.commitRange?.headSha || env.GITHUB_SHA;
  const baseSha = env.DIFFCI_BASE || report?.commitRange?.mergeBaseSha || report?.commitRange?.baseSha || pull?.base?.sha;
  const agents = detectAgents({ messages: commitMessages(env.DIFFCI_REPO, baseSha, headSha), branch: pull?.head?.ref ?? "" });
  const runUrl = env.GITHUB_SERVER_URL && env.GITHUB_RUN_ID && env.GITHUB_REPOSITORY
    ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
    : undefined;
  const verdict = gateVerdict({
    verifyEnabled: env.DIFFCI_VERIFY_ENABLED === "true",
    verifyStatus: env.DIFFCI_VERIFY_STATUS ?? "",
    report,
    receipt,
    agents,
    runUrl,
    uploaded: env.DIFFCI_UPLOAD === "true" && Boolean(report),
  });
  try {
    writeOutputs({ "gate-conclusion": verdict.conclusion, agent: verdict.agent }, env.GITHUB_OUTPUT);
  } catch {
    // Outputs are a convenience.
  }

  if (!env.DIFFCI_GITHUB_TOKEN) return warn("no github-token, so no check run was posted");
  if (!headSha || !/^[0-9a-f]{40}$/i.test(headSha)) return warn("no head commit to attach the check run to");
  const name = (env.DIFFCI_CHECK_NAME || DEFAULT_CHECK_NAME).replace(/[\r\n]/g, " ").slice(0, 100);
  try {
    const created = await github(env, "POST", `/repos/${env.GITHUB_REPOSITORY}/check-runs`, {
      name,
      head_sha: headSha,
      status: "completed",
      conclusion: verdict.conclusion,
      ...(runUrl ? { details_url: runUrl } : {}),
      output: { title: verdict.title, summary: verdict.summary },
    });
    console.log(`DiffCI merge gate: ${verdict.conclusion} (agent: ${verdict.agent})${created?.html_url ? ` ${created.html_url}` : ""}`);
  } catch (error) {
    const status = error?.status;
    warn(
      status === 403 || status === 404
        ? `could not post the check run (${status}). Give the job "permissions: checks: write"; pull requests from forks get a read-only token, so they get no check run.`
        : `could not post the check run: ${error?.message ?? error}`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
