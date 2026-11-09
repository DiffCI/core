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

const sections = [
  ["Features", /^feat(\([^)]*\))?!?:\s*/],
  ["Fixes", /^fix(\([^)]*\))?!?:\s*/],
];
const lines = [];
if (packageSpec) lines.push(`npm: \`${packageSpec}\``, "");
for (const [title, pattern] of sections) {
  const entries = subjects.filter((s) => pattern.test(s)).map((s) => {
    const scope = s.match(pattern)[1];
    const text = s.replace(pattern, "");
    return `- ${scope ? `**${scope.slice(1, -1)}:** ` : ""}${text}`;
  });
  if (entries.length) lines.push(`## ${title}`, "", ...entries, "");
}
process.stdout.write(lines.join("\n"));
