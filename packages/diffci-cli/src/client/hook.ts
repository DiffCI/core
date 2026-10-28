import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";

/**
 * The pre-push hook `diffci init --hook` installs (2026-10-28).
 *
 * WHY. In 449 agent sessions on DentalPresence, agents ran DiffCI in 24 of over 1,500 test commands:
 * they picked test files themselves (928) or ran the whole suite (282), and 104 pushes then failed the
 * repository gates in CI. Instructions alone did not make DiffCI the default. A hook does: every push,
 * by an agent or a person, verifies the commits being pushed before they leave the machine.
 *
 * BEHAVIOUR. For each pushed ref that is the checked-out HEAD, the hook runs
 * `diffci verify --base <remote sha> --head <local sha>` (a new branch uses its merge base with the
 * remote's default branch). Failing verification (exit 1) blocks the push. When DiffCI cannot verify
 * (exit 2: dirty checkout, unknown base, analysis refused) it says why and lets the push through,
 * because required CI still runs; `DIFFCI_HOOK_STRICT=1` blocks instead. `git push --no-verify` skips it.
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
status=0
while read -r local_ref local_sha remote_ref remote_sha; do
  [ "$local_sha" = "$zero" ] && continue
  if [ "$local_sha" != "$head" ]; then
    echo "diffci: $local_ref is not checked out; not verified here" >&2
    continue
  fi
  base="$remote_sha"
  if [ "$base" = "$zero" ] || ! git cat-file -e "$base^{commit}" 2>/dev/null; then
    base=$(git merge-base HEAD "refs/remotes/$remote/HEAD" 2>/dev/null || true)
  fi
  if [ -z "$base" ] || [ "$base" = "$local_sha" ]; then
    echo "diffci: no base commit for $local_ref; not verified" >&2
    continue
  fi
  echo "diffci: verifying $base..$local_sha before push" >&2
  ${command} verify --base "$base" --head "$local_sha" </dev/null
  code=$?
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
