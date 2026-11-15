#!/usr/bin/env node
// Prints GitHub Release notes for the commits since the previous v* release tag.
// Changes land on main without pull requests, so `gh release create --generate-notes`
// alone lists nothing; this names the feat/fix commits that make up the release.
//
// Usage: node scripts/release-notes.mjs <release-commit> <package@version>
import { execFileSync } from "node:child_process";

const [commit = "HEAD", packageSpec] = process.argv.slice(2);
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

let previous = "";
try {
  previous = git("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", `${commit}^`);
} catch {
  // First release: list the whole history.
}

const range = previous ? `${previous}..${commit}` : commit;
const subjects = git("log", "--no-merges", "--format=%s", range).split("\n").filter(Boolean);

// Maintainer commits are the release itself; everyone else is thanked by name at the top.
const maintainerEmails = new Set(["adityankale1995@gmail.com"]);
const repository = process.env.GITHUB_REPOSITORY || "DiffCI/core";
const conventionalPrefix = /^[a-z]+(\([^)]*\))?!?:\s*/;

function githubLogin(sha, email) {
  // The pull request that brought the commit in names its GitHub author. Without gh or the
  // network, fall back to a noreply address, then to the commit's author name.
  try {
    const login = execFileSync("gh", ["api", `repos/${repository}/commits/${sha}/pulls`, "--jq", ".[0].user.login // empty"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (login) return login;
  } catch {
    // Offline or unauthenticated: use the commit metadata below.
  }
  return email.match(/^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i)?.[1];
}

const thanks = new Map();
const authored = git("log", "--no-merges", "--reverse", "--format=%H%x09%an%x09%ae%x09%s", range);
for (const line of authored.split("\n").filter(Boolean)) {
  const [sha, name, email, subject] = line.split("\t");
  const key = email.toLowerCase();
  if (maintainerEmails.has(key) || /\[bot\]/i.test(`${name} ${email}`)) continue;
  if (!thanks.has(key)) {
    const login = githubLogin(sha, email);
    thanks.set(key, { who: login ? `[@${login}](https://github.com/${login})` : name, changes: [] });
  }
  thanks.get(key).changes.push(subject.replace(conventionalPrefix, ""));
}

const sections = [
  ["Features", /^feat(\([^)]*\))?!?:\s*/],
  ["Fixes", /^fix(\([^)]*\))?!?:\s*/],
];
const lines = [];
if (packageSpec) lines.push(`npm: \`${packageSpec}\``, "");
if (thanks.size) {
  lines.push("## Thanks to our contributors", "");
  for (const { who, changes } of thanks.values()) lines.push(`- ${who}: ${changes.join("; ")}`);
  lines.push("");
}
for (const [title, pattern] of sections) {
  const entries = subjects.filter((s) => pattern.test(s)).map((s) => {
    const scope = s.match(pattern)[1];
    const text = s.replace(pattern, "");
    return `- ${scope ? `**${scope.slice(1, -1)}:** ` : ""}${text}`;
  });
  if (entries.length) lines.push(`## ${title}`, "", ...entries, "");
}
process.stdout.write(lines.join("\n"));
