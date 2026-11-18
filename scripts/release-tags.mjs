// Creates and pushes the three tags of a CLI release in one atomic push, as the person releasing:
//   cli-release-v<version>  triggers the Publish CLI workflow
//   v<version>              the GitHub Release tag
//   action-v<version>       the observer Action tag (annotated)
// Pushing them here, not from the workflow, matters: the workflow's GITHUB_TOKEN cannot create a tag on a commit
// whose .github/workflows files differ from main's (that needs the `workflows` permission, which a job token can
// never have), so a release commit that main has moved past with a workflow change fails with
// "Resource not accessible by integration" (0.3.48, 2026-11-16). The workflow accepts tags that already exist.
//
// Usage: npm run release:tag   (from the committed and pushed release commit)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { releaseTags } from "./release-surfaces.mjs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const { version } = JSON.parse(readFileSync("packages/diffci-cli/package.json", "utf8"));
const head = git("rev-parse", "HEAD");
if (git("status", "--porcelain", "--untracked-files=no")) throw new Error("Commit the release first: the working tree has changes.");
git("fetch", "-q", "origin", "main");
if (!git("branch", "-r", "--contains", head, "origin/main")) throw new Error(`HEAD ${head.slice(0, 7)} is not on origin/main yet: push the release commit first.`);

const tags = releaseTags(version);
const remote = new Map(git("ls-remote", "--tags", "origin").split("\n").filter(Boolean).map((line) => {
  const [sha, ref] = line.split("\t");
  return [ref.replace(/^refs\/tags\//, ""), sha];
}));
const toPush = [];
for (const tag of [tags.release, tags.action, tags.cli]) {
  const peeled = remote.get(`${tag}^{}`) ?? remote.get(tag);
  if (peeled === head) { console.log(`${tag} already targets ${head.slice(0, 7)}`); continue; }
  if (peeled) throw new Error(`${tag} already exists on origin at ${peeled.slice(0, 7)}, not ${head.slice(0, 7)}`);
  // -f for every tag: a rejected push leaves the tags it created in this clone, and a rerun must replace them.
  if (tag === tags.action) git("tag", "-f", "-a", tag, "-m", `Release DiffCI observer Action v${version}`, head);
  else git("tag", "-f", tag, head);
  toPush.push(`refs/tags/${tag}`);
}
if (toPush.length) {
  git("push", "--atomic", "origin", ...toPush);
  console.log(`Pushed ${toPush.map((ref) => ref.slice("refs/tags/".length)).join(", ")} at ${head.slice(0, 7)}`);
}
