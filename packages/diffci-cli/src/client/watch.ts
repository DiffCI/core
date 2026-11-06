import { realpathSync, watch as fsWatch } from "node:fs";

/**
 * `diffci watch` (2026-11-06), the idea of `jest --watch` with DiffCI's selection.
 *
 * WHY. A person working beside an agent, or in a `node --test` repository whose own watch mode reruns
 * everything, wants the "what did I just break" answer on every save without typing a command. It is also
 * the plainest way to see what DiffCI does: the selection changes as the files do.
 *
 * WHAT. Watches the repository recursively and, after a quiet period (debounce), runs one verification of
 * the uncommitted changes: the same `verify --changed` an agent runs, so the selection, reuse, ranking and
 * coverage map all apply. Changes inside `.git` and `node_modules` are ignored. Saves during a run start
 * one more run after it, never two at once. Events that leave the tree as the last run left it start
 * nothing, so files a test writes during a run do not trigger the next one.
 * Each run is a fresh analysis; re-parsing only the changed files is not done yet.
 */

export interface WatchRun {
  /** The tree as the run left it (files it wrote included), so its own writes start nothing new. */
  treeSha: string;
}

export interface WatchOptions {
  repoPath: string;
  /** Runs one verification and reports it; resolves with the verified tree. */
  run: () => Promise<WatchRun>;
  debounceMs?: number;
  /** Injected in tests; defaults to a recursive fs.watch. Calls `onChange` with a repository-relative path. */
  watch?: (repoPath: string, onChange: (path: string) => void) => { close(): void };
  /** The tree as it is now, to tell a save from the run's own writes; undefined means "assume changed". */
  currentTree?: () => string | undefined;
}

export function ignoredWatchPath(path: string): boolean {
  return path.split(/[\\/]/).some((part) => part === ".git" || part === "node_modules");
}

function defaultWatch(repoPath: string, onChange: (path: string) => void): { close(): void } {
  // Windows: watching a short 8.3 path (C:\Users\SWATIK~1\...) aborts the process inside libuv, whose
  // events carry long names; the real path is long.
  let root = repoPath;
  try { root = realpathSync.native(repoPath); } catch {}
  const watcher = fsWatch(root, { recursive: true }, (_event, name) => onChange(name ? String(name) : ""));
  return { close: () => watcher.close() };
}

/** Starts watching and runs once at start. `idle()` resolves when no run is pending or in progress. */
export function startWatch(options: WatchOptions): { stop(): void; idle(): Promise<void> } {
  const debounceMs = options.debounceMs ?? 300;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let pending = false;
  let stopped = false;
  let lastTree: string | undefined;

  // A save during a run is part of the tree that run leaves, so the run queued for it always goes ahead;
  // only an event after a run compares trees, which is what filters out the run's own writes.
  const runOnce = async (force = false): Promise<void> => {
    if (stopped) return;
    if (running) { pending = true; return; }
    const tree = options.currentTree?.();
    if (!force && tree !== undefined && tree === lastTree) return;
    running = (async () => {
      try { lastTree = (await options.run()).treeSha; }
      catch { lastTree = undefined; }
    })();
    await running;
    running = undefined;
    if (pending && !stopped) { pending = false; await runOnce(true); }
  };

  const schedule = (path: string) => {
    if (stopped || ignoredWatchPath(path)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; void runOnce(); }, debounceMs);
  };

  const watcher = (options.watch ?? defaultWatch)(options.repoPath, schedule);
  void runOnce();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      watcher.close();
    },
    async idle() {
      while (timer || running) {
        if (running) await running;
        else await new Promise((resolve) => setTimeout(resolve, debounceMs + 10));
      }
    },
  };
}
