import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Builds dist-client for the tests that run the compiled CLI, once per source state.
 *
 * node --test runs test files in parallel processes. When each of them ran `tsc -p tsconfig.client.json`,
 * one file's build rewrote dist-client while another file's CLI was loading it, and that CLI failed with
 * `SyntaxError: Unexpected end of input` in a half-written module. Builds now take a lock, and a build is
 * skipped when dist-client is newer than every source and config file, so nothing rewrites the files
 * another test is running.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = join(ROOT, "dist-client");
const STAMP = join(OUT, ".test-build-stamp");
const LOCK = join(OUT, ".test-build-lock");
const STALE_LOCK_MS = 5 * 60_000;
const WAIT_MS = 10 * 60_000;

function newestSource(): number {
  let newest = 0;
  const visit = (path: string): void => {
    const stats = statSync(path);
    if (stats.isDirectory()) {
      for (const entry of readdirSync(path)) visit(join(path, entry));
    } else if (/\.(?:ts|json)$/.test(path)) {
      newest = Math.max(newest, stats.mtimeMs);
    }
  };
  visit(join(ROOT, "src"));
  for (const file of ["package.json", "tsconfig.json", "tsconfig.client.json"]) newest = Math.max(newest, statSync(join(ROOT, file)).mtimeMs);
  return newest;
}

function upToDate(): boolean {
  try { return statSync(STAMP).mtimeMs >= newestSource(); } catch { return false; }
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireLock(): void {
  const deadline = Date.now() + WAIT_MS;
  mkdirSync(OUT, { recursive: true });
  for (;;) {
    try {
      mkdirSync(LOCK);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // A lock left by a test process that was killed mid-build.
      try { if (Date.now() - statSync(LOCK).mtimeMs > STALE_LOCK_MS) rmSync(LOCK, { recursive: true, force: true }); } catch { /* released meanwhile */ }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${LOCK}`);
      sleep(100);
    }
  }
}

/** Compiles the client into dist-client unless a build of the current sources is already there. */
export function buildClient(): void {
  if (upToDate()) return;
  acquireLock();
  try {
    if (upToDate()) return;
    const started = Date.now();
    const build = spawnSync(process.execPath, [join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.client.json"], { cwd: ROOT, encoding: "utf8" });
    if (build.error) throw build.error;
    if (build.status !== 0) throw new Error(`tsc -p tsconfig.client.json failed:\n${build.stdout}${build.stderr}`);
    // Stamped with the build's start: a source saved during the build makes the next call build again.
    writeFileSync(STAMP, "");
    utimesSync(STAMP, new Date(started), new Date(started));
  } finally {
    rmSync(LOCK, { recursive: true, force: true });
  }
}
