"use strict";

const { spawn } = require("node:child_process");

const npxArgs = [
  "--yes",
  "--package",
  "@diffci.com/diffci@0.3.21",
  "diffci-mcp",
];

const child = process.platform === "win32"
  ? spawn(
      process.env.ComSpec || "cmd.exe",
      ["/d", "/s", "/c", "npx", ...npxArgs],
      { stdio: "inherit", windowsHide: true },
    )
  : spawn("npx", npxArgs, { stdio: "inherit" });

let finished = false;
function finish(code) {
  if (finished) return;
  finished = true;
  process.exit(code);
}

child.once("error", (error) => {
  console.error(`Failed to launch DiffCI MCP: ${error.message}`);
  finish(1);
});

child.once("exit", (code, signal) => {
  finish(code ?? (signal ? 1 : 0));
});
