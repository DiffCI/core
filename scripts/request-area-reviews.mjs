#!/usr/bin/env node
// Requests a review from the area maintainer (CONTRIBUTING.md#contributor-tiers) on every open pull request that
// touches their area, as listed in .github/area-maintainers.json. Run on a schedule by
// .github/workflows/request-area-reviews.yml.
//
// Area maintainers are collaborators with the Triage role: they can be requested and can review, but cannot push or
// merge, and their approval does not count toward main's ruleset. A maintainer is requested at most once per pull
// request: never on their own pull request, and never again once they were requested (even if the request was later
// removed) or have reviewed. A maintainer who is not a collaborator yet is skipped with a warning and picked up on a
// later run.
//
// Usage: node scripts/request-area-reviews.mjs [--dry-run]   (needs GITHUB_TOKEN; reads GITHUB_REPOSITORY)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** A repository-relative glob as a RegExp: * stays within one path segment, ** crosses segments. */
export function globToRegExp(pattern) {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*" && pattern[i + 1] === "*") {
      i++;
      if (pattern[i + 1] === "/") {
        i++;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

/** Validated areas from the parsed .github/area-maintainers.json. */
export function parseAreas(config) {
  if (!Array.isArray(config?.areas)) throw new Error("area-maintainers.json needs an areas array");
  return config.areas.map((entry) => {
    const ok =
      typeof entry.area === "string" &&
      Array.isArray(entry.maintainers) &&
      entry.maintainers.length > 0 &&
      entry.maintainers.every((login) => typeof login === "string" && /^[A-Za-z0-9-]+$/.test(login)) &&
      Array.isArray(entry.paths) &&
      entry.paths.length > 0 &&
      entry.paths.every((path) => typeof path === "string" && path.length > 0 && !path.startsWith("/"));
    if (!ok) throw new Error(`area-maintainers.json has an invalid entry: ${JSON.stringify(entry)}`);
    return { area: entry.area, maintainers: entry.maintainers, patterns: entry.paths.map(globToRegExp) };
  });
}

/**
 * Logins to request on one pull request: maintainers of every area a changed path falls in, minus the author and
 * anyone already involved (requested before or reviewed). Logins compare case-insensitively.
 */
export function reviewersToRequest({ areas, author, files, involved }) {
  const skip = new Set([author, ...involved].map((login) => login.toLowerCase()));
  const wanted = new Map();
  for (const { maintainers, patterns } of areas) {
    if (!files.some((file) => patterns.some((pattern) => pattern.test(file)))) continue;
    for (const login of maintainers) {
      if (!skip.has(login.toLowerCase())) wanted.set(login.toLowerCase(), login);
    }
  }
  return [...wanted.values()];
}

/** Logins a pull request's timeline shows as requested (at any point) or as having reviewed. */
export function involvedLogins(timeline) {
  const logins = new Set();
  for (const event of timeline) {
    if (event.event === "review_requested" && event.requested_reviewer?.login) logins.add(event.requested_reviewer.login);
    if (event.event === "reviewed" && event.user?.login) logins.add(event.user.login);
  }
  return [...logins];
}

async function api(path, token, init = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
  return response;
}

async function paginate(path, token) {
  const items = [];
  for (let page = 1; ; page++) {
    const separator = path.includes("?") ? "&" : "?";
    const response = await api(`${path}${separator}per_page=100&page=${page}`, token);
    if (!response.ok) throw new Error(`GET ${path} failed: ${response.status} ${await response.text()}`);
    const batch = await response.json();
    items.push(...batch);
    if (batch.length < 100) return items;
  }
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY ?? "DiffCI/core";
  if (!token) throw new Error("GITHUB_TOKEN is required");
  const dryRun = process.argv.includes("--dry-run");
  const areas = parseAreas(JSON.parse(readFileSync(new URL("../.github/area-maintainers.json", import.meta.url), "utf8")));

  const pulls = await paginate(`/repos/${repository}/pulls?state=open`, token);
  for (const pr of pulls) {
    if (pr.draft || !pr.user) continue;
    const changed = await paginate(`/repos/${repository}/pulls/${pr.number}/files`, token);
    const files = changed.flatMap((file) => [file.filename, file.previous_filename].filter(Boolean));
    const timeline = await paginate(`/repos/${repository}/issues/${pr.number}/timeline`, token);
    const reviewers = reviewersToRequest({ areas, author: pr.user.login, files, involved: involvedLogins(timeline) });
    if (!reviewers.length) continue;
    if (dryRun) {
      console.log(`#${pr.number}: would request ${reviewers.join(", ")}`);
      continue;
    }
    // Request one at a time, so a maintainer who is not a collaborator yet does not block the others.
    for (const login of reviewers) {
      const response = await api(`/repos/${repository}/pulls/${pr.number}/requested_reviewers`, token, {
        method: "POST",
        body: JSON.stringify({ reviewers: [login] }),
      });
      if (response.ok) console.log(`#${pr.number}: requested ${login}`);
      else if (response.status === 422) console.log(`::warning::#${pr.number}: cannot request ${login} (not a collaborator yet?)`);
      else throw new Error(`requesting ${login} on #${pr.number} failed: ${response.status} ${await response.text()}`);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
