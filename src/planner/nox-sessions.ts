// SPDX-License-Identifier: MIT

const SESSION = /^@nox\.session\( *(?:python *= *False|venv_backend *= *(?:"none"|'none')) *\)$/;
const DEFINITION = /^def ([a-z][a-z0-9_]*)\(session(?:: nox\.Session)?\)(?: -> None)?:$/;
const RESERVED_NAME = /^(?:and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|nox|not|or|pass|raise|return|try|while|with|yield)$/;
const RUN = /^    session\.run\((.*)\)$/;
const WORD = /^(["'])([\w./@:=+-]+)\1$/;

/** Read the entire root noxfile as literal session declarations. Each session uses
 * the current environment and can only call session.run with separately quoted words. */
export function noxCheckCommands(source: string, sessions: readonly string[]): string[] | undefined {
  if (!sessions.length || source.length > 64 * 1024) return undefined;
  const text = source.replace(/\r\n/g, "\n");
  // Python encoding cookies and Nox script metadata can change how the file is loaded.
  if (/[^\x20-\x7e\n]/.test(text) || /^ *#.*(?:coding[:=]|\/\/\/)/m.test(text)) return undefined;
  const lines = text.split("\n").map((line) => line.trimEnd()).filter((line) => line && !line.trimStart().startsWith("#"));
  if (lines[0] !== "import nox") return undefined;

  const declarations = new Map<string, string[]>();
  let i = 1;
  while (i < lines.length) {
    if (!SESSION.test(lines[i++]!)) return undefined;
    const name = DEFINITION.exec(lines[i++] ?? "")?.[1];
    if (!name || RESERVED_NAME.test(name) || declarations.has(name)) return undefined;
    const commands: string[] = [];
    while (i < lines.length && lines[i]!.startsWith(" ")) {
      const args = RUN.exec(lines[i++]!)?.[1];
      if (!args) return undefined;
      const words: string[] = [];
      for (const arg of args.split(",")) {
        const word = WORD.exec(arg.trim())?.[2];
        if (!word) return undefined;
        words.push(word);
      }
      commands.push(words.join(" "));
    }
    if (!commands.length) return undefined;
    declarations.set(name, commands);
  }

  const selected: string[] = [];
  for (const name of sessions) {
    const commands = declarations.get(name);
    if (!commands) return undefined;
    selected.push(...commands);
  }
  return selected;
}
