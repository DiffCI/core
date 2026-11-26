// Moves the floating major tag (v0) to the current CLI release, for users who chose `uses: DiffCI/core@v0`.
// Run it after a release, once npm serves the tarball: until then `@v0` would run an Action whose pinned CLI
// version can't be installed (a staged npm publish 404s until it is approved), so this refuses.
// `npm run release:verify` reports a floating tag that lags the release.
//
// Usage: npm run release:float
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { floatingTag, releaseTags } from "./release-surfaces.mjs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const { name, version } = JSON.parse(readFileSync("packages/diffci-cli/package.json", "utf8"));
const floating = floatingTag(version);
const release = releaseTags(version).release;

const tarball = `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${version}.tgz`;
const response = await fetch(tarball, { method: "HEAD" });
if (!response.ok) throw new Error(`npm does not serve ${name}@${version} yet (${response.status} for ${tarball}); approve a staged publish first.`);

const remote = new Map(git("ls-remote", "--tags", "origin").split("\n").filter(Boolean).map((line) => {
  const [sha, ref] = line.split("\t");
  return [ref.replace(/^refs\/tags\//, ""), sha];
}));
const commit = remote.get(`${release}^{}`) ?? remote.get(release);
if (!commit) throw new Error(`${release} is not on origin: release first.`);
if (remote.get(floating) === commit) {
  console.log(`${floating} already targets ${release} (${commit.slice(0, 7)})`);
} else {
  git("fetch", "-q", "origin", `refs/tags/${release}:refs/tags/${release}`);
  git("tag", "-f", floating, commit);
  git("push", "-f", "origin", `refs/tags/${floating}`);
  console.log(`Moved ${floating} to ${release} (${commit.slice(0, 7)})`);
}
