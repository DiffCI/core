#!/usr/bin/env node
// Credits outside contributors in the README's Contributors list as soon as their pull request merges.
// Run by .github/workflows/credit-contributors.yml; release notes credit them separately
// (scripts/release-notes.mjs) and diffci.com/contributors has its own job in the DiffCI.com repository.
//
// It only adds: a new entry for a first-time contributor, or the pull request appended to their existing
// entry. Wording a maintainer has edited is never rewritten, and a pull request already linked anywhere in
// the list is skipped, so running it again changes nothing.
//
// Usage: node scripts/credit-contributors.mjs [--dry-run]   (needs GITHUB_TOKEN; reads GITHUB_REPOSITORY)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Pull requests before this one were credited by hand.
export const FIRST_AUTOMATED_PR = 130;
const MAINTAINERS = new Set(["adityankale190895"]);
const conventionalPrefix = /^[a-z]+(\([^)]*\))?!?:\s*/i;

/** Pull requests that earn credit: merged, by a person who is not a maintainer, from FIRST_AUTOMATED_PR on. */
export function creditablePulls(pulls) {
  return pulls
    .filter((pr) => pr.merged_at && pr.number >= FIRST_AUTOMATED_PR)
    .filter((pr) => pr.user && pr.user.type !== "Bot" && !MAINTAINERS.has(pr.user.login))
    .filter((pr) => !["OWNER", "MEMBER"].includes(pr.author_association))
    .sort((a, b) => a.number - b.number);
}

/** The title without its conventional-commit prefix, as a clause for the list. */
export function summarize(title) {
  return title.replace(conventionalPrefix, "").trim().replace(/[.\s]+$/, "");
}

/** Every pull/issue number the section already links, including ranges written as [#118](…)–[#120](…). */
function linkedNumbers(section) {
  const numbers = new Set();
  for (const match of section.matchAll(/\[#(\d+)\]\([^)]*\)(?:\s*[–-]\s*\[#(\d+)\])?/g)) {
    const from = Number(match[1]);
    const to = match[2] ? Number(match[2]) : from;
    for (let n = from; n <= to; n++) numbers.add(n);
  }
  return numbers;
}

/** Returns the README with every creditable pull request credited, and the logins it added or extended. */
export function creditReadme(readme, pulls, repository = "DiffCI/core") {
  const start = readme.indexOf("### Contributors");
  if (start < 0) throw new Error("README has no ### Contributors section");
  const lines = readme.slice(start).split("\n");
  const listStart = lines.findIndex((line) => line.startsWith("- "));
  let listEnd = listStart;
  while (listEnd < lines.length && lines[listEnd].startsWith("- ")) listEnd++;
  if (listStart < 0) throw new Error("README Contributors section has no list");

  const linked = linkedNumbers(lines.slice(listStart, listEnd).join("\n"));
  const credited = [];
  for (const pr of creditablePulls(pulls)) {
    if (linked.has(pr.number)) continue;
    const login = pr.user.login;
    const link = `[#${pr.number}](https://github.com/${repository}/pull/${pr.number})`;
    const clause = `${summarize(pr.title)} (${link})`;
    const profile = `](https://github.com/${login})`.toLowerCase();
    const index = lines.slice(listStart, listEnd).findIndex((line) => line.toLowerCase().includes(profile));
    if (index >= 0) {
      const at = listStart + index;
      lines[at] = `${lines[at].replace(/\.\s*$/, "")}; ${clause}.`;
    } else {
      const avatar = `<a href="https://github.com/${login}"><img src="https://github.com/${login}.png?size=80" width="40" height="40" alt="@${login}"></a>`;
      lines.splice(listEnd, 0, `- ${avatar} **[@${login}](https://github.com/${login})**: ${clause}.`);
      listEnd++;
    }
    linked.add(pr.number);
    credited.push({ login, number: pr.number });
  }
  return { readme: readme.slice(0, start) + lines.join("\n"), credited };
}

async function mergedPulls(repository, token) {
  const pulls = [];
  for (let page = 1; page <= 10; page++) {
    const response = await fetch(
      `https://api.github.com/repos/${repository}/pulls?state=closed&sort=created&direction=desc&per_page=100&page=${page}`,
      { headers: { Accept: "application/vnd.github+json", ...(token ? { Authorization: `Bearer ${token}` } : {}) } },
    );
    if (!response.ok) throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
    const batch = await response.json();
    pulls.push(...batch);
    if (batch.length < 100 || batch.some((pr) => pr.number < FIRST_AUTOMATED_PR)) break;
  }
  return pulls;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repository = process.env.GITHUB_REPOSITORY || "DiffCI/core";
  const path = new URL("../README.md", import.meta.url);
  const { readme, credited } = creditReadme(readFileSync(path, "utf8"), await mergedPulls(repository, process.env.GITHUB_TOKEN), repository);
  if (!process.argv.includes("--dry-run") && credited.length) writeFileSync(path, readme);
  for (const { login, number } of credited) console.log(`credited @${login} for #${number}`);
  if (!credited.length) console.log("every merged contribution is already credited");
}
