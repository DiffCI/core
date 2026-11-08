import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";

/**
 * The pre-push hook `diffci init` installs (2026-10-28; on by default since 0.3.24).
 *
 * WHY. In 449 agent sessions on DentalPresence, agents ran DiffCI in 24 of over 1,500 test commands:
 * they picked test files themselves (928) or ran the whole suite (282), and 104 pushes then failed the
 * repository gates in CI. Instructions alone did not make DiffCI the default. A hook does: every push,
 * by an agent or a person, verifies the commits being pushed before they leave the machine.
 *
 * BEHAVIOUR. For each pushed ref the hook runs `diffci verify --base <remote sha> --head <local sha>`
 * (a new branch uses its merge base with the remote's default branch). Failing verification (exit 1)
 * blocks the push. When DiffCI cannot verify (exit 2: unknown base, analysis refused) it says why and
 * lets the push through, because required CI still runs; `DIFFCI_HOOK_STRICT=1` blocks instead.
 * `git push --no-verify` skips it.
 *
 * CLEAN WORKTREE (2026-11-08). Commit-range verification refuses a dirty checkout, so a stray untracked
 * file (DentalPresence had an empty one named "True") made every push unverifiable. When the checkout
 * has other changes, or the pushed ref is not checked out, the hook verifies in a temporary detached
 * worktree of the pushed commit, linking the checkout's node_modules only when the root lockfiles match.
 * Links are removed before the worktree, so cleanup can never delete the real dependencies.
 *
 * REPORTING (2026-10-29). When DIFFCI_API_URL and DIFFCI_TOKEN are set, the hook also sends an
 * observation report for the pushed range, the same report the GitHub Action sends. A dogfood repository
 * whose GitHub Actions minutes ran out sent nothing for two weeks while its builds moved to another CI;
 * reporting from the push keeps that data. It runs after verification and can never block the push.
 */
export const HOOK_MARKER = "# diffci:managed pre-push hook";

export function prePushHook(command: string): string {
  return `#!/bin/sh
${HOOK_MARKER}
# Verifies the commits being pushed with DiffCI's affected tests. Skip once: git push --no-verify
# Block when DiffCI cannot verify, not only when tests fail: DIFFCI_HOOK_STRICT=1
remote="$1"
zero=0000000000000000000000000000000000000000
head=$(git rev-parse HEAD)
top=$(git rev-parse --show-toplevel)
status=0
case "$(uname -s 2>/dev/null)" in MINGW*|MSYS*|CYGWIN*) windows=1 ;; *) windows=0 ;; esac

# Link a dependency directory from the checkout into the temporary worktree, and remove only the link.
link_dir() {
  if [ "$windows" = "1" ]; then
    # //J, not /J: Git Bash would rewrite /J as a path.
    cmd //c mklink //J "$(cygpath -w "$2")" "$(cygpath -w "$1")" >/dev/null 2>&1
  else
    ln -s "$1" "$2" 2>/dev/null
  fi
}
unlink_dir() {
  if [ "$windows" = "1" ]; then cmd //c rmdir "$(cygpath -w "$1")" >/dev/null 2>&1; else rm -f "$1"; fi
}

# Verifies the pushed commit in a clean temporary worktree, so uncommitted or untracked files in this
# checkout neither block nor influence the result. Installed dependencies are reused only when the
# pushed commit's lockfiles match this checkout's; otherwise it reports that it could not verify.
verify_in_worktree() {
  tmpbase="$TMPDIR"; [ -n "$tmpbase" ] || tmpbase=/tmp
  tmp=$(mktemp -d "$tmpbase/diffci-push-XXXXXX") || return 2
  tree="$tmp/tree"
  if ! git worktree add --quiet --detach "$tree" "$2" >/dev/null 2>&1; then
    rmdir "$tmp" 2>/dev/null
    echo "diffci: could not create a temporary worktree" >&2
    return 2
  fi
  linked=""
  result=0
  # Blob ids, not bytes: Git normalizes line endings (core.autocrlf) the same way on both sides.
  for lock in package-lock.json npm-shrinkwrap.json pnpm-lock.yaml yarn.lock bun.lock bun.lockb; do
    here=""; pushed=""
    [ -f "$top/$lock" ] && here=$(git hash-object -- "$top/$lock" 2>/dev/null)
    pushed=$(git rev-parse -q --verify "$2:$lock" 2>/dev/null)
    if [ -n "$here$pushed" ]; then
      if [ "$here" != "$pushed" ]; then
        echo "diffci: $lock differs from the pushed commit; install dependencies for it, or push from a clean checkout" >&2
        result=2
      fi
    fi
  done
  if [ "$result" -eq 0 ]; then
    for dir in $(cd "$top" && find . -maxdepth 4 \\( -name .git -o -name node_modules \\) -prune -name node_modules -type d -print 2>/dev/null); do
      if [ -d "$tree/$(dirname "$dir")" ] && [ ! -e "$tree/$dir" ] && link_dir "$top/$dir" "$tree/$dir"; then
        linked="$linked $tree/$dir"
      fi
    done
    (cd "$tree" && ${command} verify --base "$1" --head "$2" </dev/null)
    result=$?
  fi
  # Links first: removing the worktree must never reach through a link into this checkout.
  for link in $linked; do unlink_dir "$link"; done
  git worktree remove --force "$tree" >/dev/null 2>&1 || rm -rf "$tree"
  git worktree prune >/dev/null 2>&1
  rmdir "$tmp" 2>/dev/null
  return $result
}

while read -r local_ref local_sha remote_ref remote_sha; do
  [ "$local_sha" = "$zero" ] && continue
  base="$remote_sha"
  if [ "$base" = "$zero" ] || ! git cat-file -e "$base^{commit}" 2>/dev/null; then
    base=$(git merge-base "$local_sha" "refs/remotes/$remote/HEAD" 2>/dev/null || true)
  fi
  if [ -z "$base" ] || [ "$base" = "$local_sha" ]; then
    echo "diffci: no base commit for $local_ref; not verified" >&2
    continue
  fi
  if [ "$local_sha" = "$head" ] && [ -z "$(git status --porcelain 2>/dev/null)" ]; then
    echo "diffci: verifying $base..$local_sha before push" >&2
    ${command} verify --base "$base" --head "$local_sha" </dev/null
    code=$?
  else
    echo "diffci: verifying $base..$local_sha in a clean temporary worktree (this checkout has other changes or another branch)" >&2
    verify_in_worktree "$base" "$local_sha"
    code=$?
  fi
  if [ "$code" -eq 1 ]; then
    echo "diffci: verification failed; push blocked. Fix it, or skip once with git push --no-verify" >&2
    status=1
  elif [ "$code" -ne 0 ]; then
    if [ "$DIFFCI_HOOK_STRICT" = "1" ]; then
      echo "diffci: could not verify (exit $code); push blocked because DIFFCI_HOOK_STRICT=1" >&2
      status=1
    else
      echo "diffci: could not verify (exit $code); pushing anyway, required CI still runs" >&2
    fi
  fi
  # Optional report for teams whose CI cannot run DiffCI. It never affects the push.
  if [ -n "$DIFFCI_API_URL" ] && [ -n "$DIFFCI_TOKEN" ]; then
    ${command} observe --base "$base" --head "$local_sha" --quiet </dev/null >&2 || true
  fi
done
exit $status
`;
}

/** The command the hook runs: the installed binary when the repository has DiffCI as a dependency,
 * otherwise a pinned npx invocation, so the hook never floats to a newer release. */
export function hookCommand(manager: "npm" | "pnpm" | "yarn" | "bun" | undefined, version: string): string {
  switch (manager) {
    case "npm": return "npx --no-install diffci";
    case "pnpm": return "pnpm exec diffci";
    case "yarn": return "yarn diffci";
    case "bun": return "bunx diffci";
    default: return `npx --yes "@diffci.com/diffci@${version}"`;
  }
}

export function isGitRepository(repoPath: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { cwd: repoPath, stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/** Writes the hook into the directory Git actually runs hooks from (`core.hooksPath` included, such as
 * `.husky`). An existing hook DiffCI did not write is kept unless `force` is set. */
export function installPrePushHook(repoPath: string, command: string, force: boolean): string {
  const hooksDir = execFileSync("git", ["rev-parse", "--git-path", "hooks"], { cwd: repoPath, encoding: "utf8", windowsHide: true }).trim();
  const absoluteDir = isAbsolute(hooksDir) ? hooksDir : join(repoPath, hooksDir);
  const hookPath = join(absoluteDir, "pre-push");
  const shown = relative(repoPath, hookPath).replace(/\\/g, "/") || hookPath;
  const content = prePushHook(command);
  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, "utf8");
    if (existing === content) return `kept ${shown} (current)`;
    if (!existing.includes(HOOK_MARKER) && !force) {
      return `kept ${shown} (existing hook not written by DiffCI; add \`${command} verify --base <remote-sha> --head <local-sha>\` to it, or pass --force)`;
    }
  }
  mkdirSync(dirname(hookPath), { recursive: true });
  writeFileSync(hookPath, content, "utf8");
  try { chmodSync(hookPath, 0o755); } catch { /* Git for Windows runs hooks through sh regardless of mode. */ }
  return `wrote ${shown} (verifies pushed commits; skip once with git push --no-verify)`;
}
