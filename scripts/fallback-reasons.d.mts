// SPDX-License-Identifier: MIT

/** Each fallback reason in src/, with `…` for its variable parts, mapped to the `file:line` that prints it. */
export function fallbackReasons(): Map<string, string>;

/** Each literal "no runnable command" reason in src/planner/test-command.ts, with `…` for its variable parts, mapped to its `file:line`. */
export function noCommandReasons(): Map<string, string>;
