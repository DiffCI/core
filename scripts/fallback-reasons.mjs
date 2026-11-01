// SPDX-License-Identifier: MIT
// Lists every full-run fallback reason the CLI can print, from the source sites that produce one, so
// docs/using-diffci.md can be checked against it (#51). Each reason is listed as its fixed
// text with each `${...}` (a path, package name or count that varies per run) shown as `…`.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// A line that produces a fallback reason, and the string literals on it that are the reason.
const SITES = [
  /fallbackReasons(?:\.push\(|: \[)/,
  /[bB]lockers\.push\(/,
  /const message = /,
  /\bmessage: "/,
  /\bfail\(`/,
  /\bblock\("/,
  /runEverything\("/,
  /(?:discoveryError|configurationError)\s*[:=]\s*"/,
  /return unsupported \? `/,
];
const LITERAL = /"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;

function collect(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? collect(full) : entry.name.endsWith('.ts') ? [full] : [];
  });
}

// git's own error text, not a fallback reason.
const IGNORED = new Set(['unknown error']);

/** A reason with each `${...}` shown as `…`, or undefined for a literal that is not one (a rule name). */
function reasonText(literal, line) {
  if (/runEverything\("/.test(line) && !line.includes(`, "${literal}"`)) return undefined; // the rule name
  if (/\bmessage: "/.test(line) && !/fallback|full validation/i.test(literal)) return undefined;
  let text = literal.replace(/\$\{[^}]*\}/g, '…');
  if (/\bblock\("/.test(line)) text = `Vue …: ${text}`; // vue.ts prefixes the component path
  return IGNORED.has(text) || !/[a-z]{3,} [a-z]{2,}/i.test(text) ? undefined : text;
}

export function fallbackReasons() {
  const reasons = new Map();
  for (const file of collect(join(root, 'src')).sort()) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (/^\s*(?:\/\/|\*)/.test(line) || !SITES.some((site) => site.test(line))) return;
      for (const match of line.matchAll(LITERAL)) {
        const text = reasonText(match[1] ?? match[2], line);
        if (text && !reasons.has(text)) reasons.set(text, `${relative(root, file).replaceAll('\\', '/')}:${index + 1}`);
      }
    });
  }
  return reasons;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const [text, where] of fallbackReasons()) console.log(`${where}\t${text}`);
}
