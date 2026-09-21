/** Package-level result from go test -json. Incomplete streams never mean success. */
export function parseGoTestOutput(output: string): { failures: number; failedNames: string[] } | undefined {
  const started = new Set<string>();
  const finished = new Set<string>();
  const failed = new Set<string>();
  const names = new Set<string>();
  try {
    for (const line of output.split(/\r?\n/).filter((line) => line.trim())) {
      const event = JSON.parse(line) as { Action?: string; Package?: string; Test?: string };
      if (typeof event.Action !== "string" || typeof event.Package !== "string") return undefined;
      if (event.Action === "start") started.add(event.Package);
      if (event.Test && event.Action === "fail") names.add(`${event.Package}/${event.Test}`);
      if (!event.Test && ["pass", "fail", "skip"].includes(event.Action)) {
        if (finished.has(event.Package)) return undefined;
        finished.add(event.Package);
        if (event.Action === "fail") failed.add(event.Package);
      }
    }
  } catch { return undefined; }
  if (!started.size || started.size !== finished.size || [...started].some((pkg) => !finished.has(pkg))) return undefined;
  if (names.size && !failed.size) return undefined;
  return { failures: failed.size, failedNames: [...names].sort() };
}
