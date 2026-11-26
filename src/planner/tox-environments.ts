// SPDX-License-Identifier: MIT
/** The root tox.ini subset used for workflow checks. Only literal names and explicitly
 * declared environments are supported. The caller classifies every returned command. */

type Section = Map<string, string[]>;

const HEADER = /^\[(tox|testenv(?::[a-z][a-z0-9_-]*)?)\]$/;
const ENV_LIST = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*(?:[ \t]*,[ \t]*[a-zA-Z0-9][a-zA-Z0-9_.-]*)*$/;
const EXTERNAL = /^(?:mypy|pyright|basedpyright|pyrefly|ruff)$/;

function readToxIni(source: string): Map<string, Section> | undefined {
  const text = source.replace(/\r\n/g, "\n");
  if (source.length > 64 * 1024 || /[^\t\n\x20-\x7e]/.test(text)) return undefined;
  const sections = new Map<string, Section>();
  let name = "";
  let section: Section | undefined;
  let values: string[] | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || /^[#;]/.test(line)) continue;
    // Substitutions, escaping, inline comments and control characters have separate
    // meanings in tox's INI loader. Leave them to CI.
    if (/[{}\\#;]/.test(raw)) return undefined;
    if (/^[ \t]/.test(raw)) {
      if (!values) return undefined;
      values.push(line);
      continue;
    }
    const header = HEADER.exec(line);
    if (header) {
      name = header[1]!;
      if (sections.has(name)) return undefined;
      section = new Map();
      sections.set(name, section);
      values = undefined;
      continue;
    }
    const option = /^([a-z_]+)[ \t]*=[ \t]*(.*)$/.exec(line);
    if (!option || !section) return undefined;
    const key = option[1] === "envlist" ? "env_list" : option[1]!;
    const supported = name === "tox"
      ? key === "env_list" || key === "skipsdist"
      : ["commands", "skip_install", "allowlist_externals", "description"].includes(key);
    if (!supported || section.has(key)) return undefined;
    values = option[2] ? [option[2]] : [];
    section.set(key, values);
  }
  for (const section of sections.values()) {
    if (section.get("env_list")?.some((line) => !ENV_LIST.test(line))) return undefined;
    if (section.get("allowlist_externals")?.some((line) => !EXTERNAL.test(line))) return undefined;
    if (section.has("skip_install") && section.get("skip_install")!.join("\n") !== "true") return undefined;
    if (section.has("skipsdist") && section.get("skipsdist")!.join("\n") !== "true") return undefined;
  }
  return sections.has("tox") ? sections : undefined;
}

/** Read commands without running tox, provisioning dependencies or installing the project.
 * A selected environment inherits individual options from [testenv]. It must explicitly
 * skip installation and allow the named external check program. */
export function toxCheckCommands(source: string, environments: readonly string[]): string[] | undefined {
  const sections = readToxIni(source);
  if (!sections || !environments.length || new Set(environments).size !== environments.length) return undefined;
  const skipsPackage = sections.get("tox")!.has("skipsdist");
  const base = sections.get("testenv");
  const commands: string[] = [];
  for (const name of environments) {
    const env = sections.get(`testenv:${name}`);
    if (!env || !(skipsPackage || env.has("skip_install") || base?.has("skip_install"))) return undefined;
    const allowed = env.get("allowlist_externals") ?? base?.get("allowlist_externals");
    const lines = env.get("commands") ?? base?.get("commands");
    if (!lines?.length || !allowed) return undefined;
    // Inherited command lists can otherwise expand many times across named environments.
    if (commands.length + lines.length > 256) return undefined;
    for (const line of lines) {
      if (!allowed.includes(line.split(/[ \t]/, 1)[0]!)) return undefined;
      commands.push(line);
    }
  }
  return commands;
}
