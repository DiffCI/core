import { strict as assert } from "node:assert";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const MCP = join(ROOT, "dist-client", "src", "client", "mcp.js");

before(() => {
  execFileSync(process.execPath, [join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.client.json"], { cwd: ROOT, stdio: "pipe" });
});
function frame(message: unknown): string {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

function parseFrames(data: string): unknown[] {
  const messages: unknown[] = [];
  let rest = data;
  while (rest.length > 0) {
    const headerEnd = rest.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;
    const header = rest.slice(0, headerEnd);
    const match = /^Content-Length:\s*(\d+)\s*$/im.exec(header);
    assert.ok(match, `missing Content-Length in ${header}`);
    const length = Number(match[1]);
    const start = headerEnd + 4;
    const end = start + length;
    if (rest.length < end) break;
    messages.push(JSON.parse(rest.slice(start, end)));
    rest = rest.slice(end);
  }
  return messages;
}

describe("DiffCI MCP server", () => {
  it("initializes and lists the DiffCI tools over stdio framing", async () => {
    const child = spawn(process.execPath, [MCP], { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });

    child.stdin.write(frame({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
    child.stdin.write(frame({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }));

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        clearInterval(poll);
        child.kill();
        reject(new Error(`timed out waiting for MCP response. stderr: ${stderr}`));
      }, 5000);
      const poll = setInterval(() => {
        if (parseFrames(stdout).length >= 2) {
          clearTimeout(timeout);
          clearInterval(poll);
          resolve();
        }
      }, 25);
    });

    child.kill();
    const messages = parseFrames(stdout) as Array<{ id?: number; result?: { tools?: Array<{ name: string }> }; error?: unknown }>;
    assert.equal(messages[0]?.id, 1);
    assert.equal(messages[0]?.error, undefined);
    assert.equal(messages[1]?.id, 2);
    assert.deepEqual(messages[1]?.result?.tools?.map((tool) => tool.name), [
      "diffci_changed_files",
      "diffci_select_tests",
      "diffci_explain_selection",
      "diffci_run_affected_tests",
      "diffci_verify",
      "diffci_verify_changed",
      "diffci_check",
      "diffci_init",
      "diffci_verify_workflow",
    ]);
  });

  it("returns a structured verification receipt", async () => {
    const repo = mkdtempSync(join(tmpdir(), "diffci-mcp-verify-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: repo });
      execFileSync("git", ["config", "user.email", "test@diffci.local"], { cwd: repo });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
      writeFileSync(join(repo, "README.md"), "fixture\n", "utf8");
      execFileSync("git", ["add", "-A"], { cwd: repo });
      execFileSync("git", ["commit", "--quiet", "-m", "initial"], { cwd: repo });

      const child = spawn(process.execPath, [MCP], { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      child.stdin.write(frame({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "diffci_verify_changed", arguments: { repo } },
      }));

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          clearInterval(poll);
          child.kill();
          reject(new Error(`timed out waiting for verification response. stderr: ${stderr}`));
        }, 15_000);
        const poll = setInterval(() => {
          if (parseFrames(stdout).length >= 1) {
            clearTimeout(timeout);
            clearInterval(poll);
            resolve();
          }
        }, 25);
      });

      child.kill();
      const message = parseFrames(stdout)[0] as {
        id?: number;
        result?: { isError?: boolean; structuredContent?: Record<string, unknown> };
      };
      assert.equal(message.id, 3);
      assert.equal(message.result?.isError, false);
      assert.equal(message.result?.structuredContent?.schema, "diffci.verification.v1");
      assert.equal(message.result?.structuredContent?.verification, "passed");
      assert.equal(message.result?.structuredContent?.safe_to_continue, true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
