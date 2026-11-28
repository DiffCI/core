export interface ParsedArgs {
  command?: string;
  flags: Record<string, string | boolean>;
}

/**
 * Parses `diffci <command> --flag value` arguments. Both `--name value` and `--name=value` set the
 * flag; a bare `--name` is `true`. `--paths` takes every value up to the next flag, and repeats add
 * to it; NUL separates the values because no path contains one.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const args = argv.slice(2);
  const flags: Record<string, string | boolean> = {};
  let command: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (!token.startsWith("--")) {
      command ??= token;
      continue;
    }
    const equals = token.indexOf("=");
    const key = equals < 0 ? token.slice(2) : token.slice(2, equals);
    const inline = equals < 0 ? undefined : token.slice(equals + 1);
    if (key === "paths") {
      const values: string[] = typeof flags.paths === "string" ? flags.paths.split("\0") : [];
      if (inline !== undefined && inline !== "") values.push(inline);
      while (args[i + 1] !== undefined && !args[i + 1]!.startsWith("--")) values.push(args[++i]!);
      flags.paths = values.length ? values.join("\0") : true;
      continue;
    }
    if (inline !== undefined) {
      flags[key] = inline;
      continue;
    }
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { command, flags };
}
