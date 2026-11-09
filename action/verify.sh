#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# The opt-in fast check of the DiffCI change impact Action (verify: "true"). It runs after the
# observation and its outputs, and
#   - runs nothing when the observation could not narrow the change: the full test job covers it, and
#     running the whole suite a second time would not be a fast check;
#   - otherwise runs `diffci verify --fail-fast` on the event range: the affected tests (likeliest
#     failures first) and, unless verify-checks is "false", the check script's lint and typecheck;
#   - fails the step only when those tests or checks fail. A DiffCI problem (blocked, timeout, a CLI
#     that does not start) warns, so DiffCI never becomes the reason a pull request is red.
# Inputs arrive through the environment, never interpolated into this script.
set -uo pipefail

: "${RUNNER_TEMP:?RUNNER_TEMP must be set}"
: "${GITHUB_OUTPUT:=/dev/null}"
: "${GITHUB_STEP_SUMMARY:=/dev/null}"

receipt="$RUNNER_TEMP/diffci-verification.json"
log="$RUNNER_TEMP/diffci-verification.log"

# Markdown and workflow commands are written from fixed text; repository text only goes inside a fence.
summary() {
  local heading="$1" detail="$2"
  {
    echo "### DiffCI fast check: $heading"
    echo
    echo "$detail"
    if [ -s "$log" ]; then
      echo
      echo "<details><summary>Verification output</summary>"
      echo
      echo "~~~~~~~~text"
      tail -c 60000 "$log" | sed 's/^~~~~~~~/ ~~~~~~~~/'
      echo "~~~~~~~~"
      echo
      echo "</details>"
    fi
    echo
  } >> "$GITHUB_STEP_SUMMARY"
}

if [ "${DIFFCI_FULL:-true}" != "false" ]; then
  echo "status=skipped" >> "$GITHUB_OUTPUT"
  echo "::notice title=DiffCI fast check::Skipped: DiffCI could not narrow this change, so the full test job covers it."
  summary "skipped" "DiffCI could not narrow this change, so it ran nothing here; your full test job covers it. Reason: ${DIFFCI_REASON:-not given}"
  exit 0
fi

if [[ ! "${DIFFCI_CLI_VERSION:-}" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$ ]]; then
  echo "DiffCI CLI version must be an exact semver version" >&2
  exit 2
fi
if [[ ! "${DIFFCI_VERIFY_TIMEOUT:-}" =~ ^[1-9][0-9]{0,3}$ ]]; then
  echo "verify-timeout-minutes must be a whole number of minutes from 1 to 9999" >&2
  exit 2
fi
case "${DIFFCI_VERIFY_CHECKS:-true}" in
  true) checks=--checks ;;
  false) checks=--no-checks ;;
  *) echo "verify-checks must be \"true\" or \"false\"" >&2; exit 2 ;;
esac

args=(verify --repo "${DIFFCI_REPO:?}" --fail-fast "$checks" --no-send --no-log --out "$receipt"
  --timeout-ms "$((DIFFCI_VERIFY_TIMEOUT * 60000))")
if [ -n "${DIFFCI_BASE:-}" ]; then args+=(--base "$DIFFCI_BASE"); fi
if [ -n "${DIFFCI_HEAD:-}" ]; then args+=(--head "$DIFFCI_HEAD"); fi

# Installed in RUNNER_TEMP, as for the observation, so npm never touches the checkout. verify itself
# runs the repository's own test and check commands in the checkout.
(
  cd "$RUNNER_TEMP" &&
    npx --yes --ignore-scripts --no-audit --fund=false --package "@diffci.com/diffci@$DIFFCI_CLI_VERSION" diffci "${args[@]}"
) 2>&1 | tee "$log"
code=${PIPESTATUS[0]}

if [ -f "$receipt" ]; then echo "receipt-path=$receipt" >> "$GITHUB_OUTPUT"; fi

case "$code" in
  0)
    echo "status=passed" >> "$GITHUB_OUTPUT"
    summary "passed" "The affected tests$([ "$checks" = --checks ] && echo " and checks") passed. Your full test job still runs everything."
    exit 0
    ;;
  1)
    echo "status=failed" >> "$GITHUB_OUTPUT"
    echo "::error title=DiffCI fast check::The affected tests or checks failed. See the verification output in the job summary."
    summary "failed" "The affected tests or checks failed. With --fail-fast the run stopped at the first failing batch, so fix it and push again."
    exit 1
    ;;
  *)
    echo "status=blocked" >> "$GITHUB_OUTPUT"
    echo "::warning title=DiffCI fast check::DiffCI could not verify this change (exit $code). Your full test job still decides."
    summary "blocked" "DiffCI could not verify this change (exit $code), so this step only warns. Your full test job still decides."
    exit 0
    ;;
esac
