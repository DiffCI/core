#!/bin/sh
# diffci:managed pre-push hook
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
    for dir in $(cd "$top" && find . -maxdepth 4 \( -name .git -o -name node_modules \) -prune -name node_modules -type d -print 2>/dev/null); do
      if [ -d "$tree/$(dirname "$dir")" ] && [ ! -e "$tree/$dir" ] && link_dir "$top/$dir" "$tree/$dir"; then
        linked="$linked $tree/$dir"
      fi
    done
    (cd "$tree" && npx --no-install diffci verify --base "$1" --head "$2" </dev/null)
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
    npx --no-install diffci verify --base "$base" --head "$local_sha" </dev/null
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
    npx --no-install diffci observe --base "$base" --head "$local_sha" --quiet </dev/null >&2 || true
  fi
done
exit $status
