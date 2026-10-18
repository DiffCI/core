#!/usr/bin/env node
import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { agentChangedFiles, agentSelection } from "./agent-selection.js";

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
}

interface ToolCallParams {
  name?: string;
  arguments?: Record<string, unknown>;
}

const SERVER_INFO = { name: "diffci-mcp", version: "0.1.0" };

const tools = [
  ...["diffci_changed_files", "diffci_select_tests", "diffci_explain_selection", "diffci_run_affected_tests"].map((name) => ({
    name,
    description: name === "diffci_run_affected_tests"
      ? "Reanalyze and verify the current working-tree snapshot with affected tests or conservative full fallback. Required CI remains authoritative."
      : name === "diffci_changed_files"
      ? "List staged, unstaged and non-ignored untracked changed paths relative to HEAD, with a snapshot identity. Builds no dependency graph and runs no tests."
      : "Inspect current staged, unstaged and non-ignored untracked changes and return a snapshot-bound affected-test plan and fallback reasons. Runs no tests; a plan is not a passing receipt.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Absolute repository path; defaults to server working directory. Always pass the edited repository when using a plugin." },
        ...(name === "diffci_run_affected_tests" ? { timeoutMs: { type: "number", minimum: 0 } } : {}),
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: name !== "diffci_run_affected_tests", openWorldHint: false },
  })),
  {
    name: "diffci_verify",
    description: "Verify a clean commit range and return a receipt bound to the checked-out head commit. Resolves the CI event range automatically when base and head are omitted.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repository path. Defaults to the MCP server working directory." },
        base: { type: "string", description: "Optional base commit SHA. Must be paired with head." },
        head: { type: "string", description: "Optional head commit SHA. Must be paired with base and match checked-out HEAD." },
        timeoutMs: { type: "number", description: "Maximum verification-command runtime in milliseconds." },
        redactPaths: { type: "boolean", description: "Replace paths with stable digests in analysis." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "diffci_verify_changed",
    description: "Verify the current staged, unstaged, and non-ignored untracked changes. Fails closed unless the exact working-tree snapshot passes selected or full fallback verification.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repository path. Defaults to the MCP server working directory." },
        timeoutMs: { type: "number", description: "Maximum verification-command runtime in milliseconds." },
        redactPaths: { type: "boolean", description: "Replace paths with stable digests in analysis." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "diffci_check",
    description: "Analyze the repository, run inferred full and selected test commands when available, and report paired runtime. Sends nothing to DiffCI Cloud.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repository path. Defaults to the MCP server working directory." },
        base: { type: "string", description: "Optional base commit SHA." },
        head: { type: "string", description: "Optional head commit SHA." },
        json: { type: "boolean", description: "Print the full JSON observation report." },
        quiet: { type: "boolean", description: "Suppress the human summary." },
        redactPaths: { type: "boolean", description: "Replace paths with stable digests in the report." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "diffci_init",
    description: "Seed a repository with AI-agent instruction files for DiffCI.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repository path. Defaults to the MCP server working directory." },
        workflow: { type: "boolean", description: "Also add the non-blocking GitHub Actions observer workflow." },
        verificationWorkflow: { type: "boolean", description: "Also add the blocking GitHub Actions verification workflow." },
        force: { type: "boolean", description: "Overwrite existing instruction files." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "diffci_verify_workflow",
    description: "Check that a DiffCI GitHub Actions job cannot affect the rest of CI.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repository path. Defaults to the MCP server working directory." },
      },
      additionalProperties: false,
    },
  },
];

function cliPath(): string {
  return join(dirname(import.meta.filename), "cli.js");
}

function stringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function booleanArg(args: Record<string, unknown>, name: string): boolean {
  return args[name] === true;
}

function commandForTool(name: string, args: Record<string, unknown>): string[] {
  const repo = stringArg(args, "repo");
  switch (name) {
    case "diffci_verify": {
      const command = ["verify", "--json"];
      if (repo) command.push("--repo", resolve(repo));
      for (const flag of ["base", "head"]) {
        const value = stringArg(args, flag);
        if (value) command.push(`--${flag}`, value);
      }
      const timeoutMs = args.timeoutMs;
      if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs >= 0) command.push("--timeout-ms", String(timeoutMs));
      if (booleanArg(args, "redactPaths")) command.push("--redact-paths");
      return command;
    }
    case "diffci_run_affected_tests":
    case "diffci_verify_changed": {
      const command = ["verify", "--changed", "--json"];
      if (repo) command.push("--repo", resolve(repo));
      const timeoutMs = args.timeoutMs;
      if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs >= 0) command.push("--timeout-ms", String(timeoutMs));
      if (booleanArg(args, "redactPaths")) command.push("--redact-paths");
      return command;
    }
    case "diffci_check": {
      const command = ["check"];
      if (repo) command.push("--repo", resolve(repo));
      for (const flag of ["base", "head"]) {
        const value = stringArg(args, flag);
        if (value) command.push(`--${flag}`, value);
      }
      if (booleanArg(args, "json")) command.push("--json");
      if (booleanArg(args, "quiet")) command.push("--quiet");
      if (booleanArg(args, "redactPaths")) command.push("--redact-paths");
      return command;
    }
    case "diffci_init": {
      const command = ["init"];
      if (repo) command.push("--repo", resolve(repo));
      if (booleanArg(args, "workflow")) command.push("--workflow");
      if (booleanArg(args, "verificationWorkflow")) command.push("--verification-workflow");
      if (booleanArg(args, "force")) command.push("--force");
      return command;
    }
    case "diffci_verify_workflow": {
      const command = ["verify-workflow"];
      if (repo) command.push("--repo", resolve(repo));
      return command;
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    execFile(process.execPath, [cliPath(), ...args], {
      cwd: process.cwd(),
      env: { ...process.env, DIFFCI_MCP: "1" },
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      const exitCode = typeof code === "number" ? code : error ? 1 : 0;
      resolveRun({ exitCode, stdout, stderr });
    });
  });
}

function writeMessage(message: unknown): void {
  const body = JSON.stringify(message);
  process.stdout.write(lineTransport ? `${body}\n` : `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

function success(id: JsonRpcId | undefined, result: unknown): void {
  if (id === undefined) return;
  writeMessage({ jsonrpc: "2.0", id, result });
}

function failure(id: JsonRpcId | undefined, code: number, message: string): void {
  if (id === undefined) return;
  writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(request: JsonRpcRequest): Promise<void> {
  const id = request.id;
  switch (request.method) {
    case "initialize":
      success(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      return;
    case "notifications/initialized":
      return;
    case "tools/list":
      success(id, { tools });
      return;
    case "tools/call": {
      const params = request.params as ToolCallParams | undefined;
      if (!params?.name) {
        failure(id, -32602, "tools/call requires params.name");
        return;
      }
      const args = params.arguments ?? {};
      const tool = tools.find((entry) => entry.name === params.name);
      if (!tool || !args || typeof args !== "object" || Array.isArray(args)) {
        failure(id, -32602, "unknown tool or invalid arguments");
        return;
      }
      const properties = tool.inputSchema.properties;
      for (const [key, value] of Object.entries(args)) {
        const property = properties[key as keyof typeof properties] as { type: string } | undefined;
        if (!property || typeof value !== property.type || (key === "timeoutMs" && (!Number.isFinite(value) || (value as number) < 0))) {
          failure(id, -32602, `invalid argument: ${key}`);
          return;
        }
      }
      if (["diffci_changed_files", "diffci_select_tests", "diffci_explain_selection"].includes(params.name)) {
        const repo = stringArg(args, "repo") ?? process.cwd();
        const plan = params.name === "diffci_changed_files" ? agentChangedFiles(repo) : await agentSelection(repo);
        success(id, { content: [{ type: "text", text: JSON.stringify(plan) }], structuredContent: plan, isError: plan.status === "blocked" });
        return;
      }
      const run = await runCli(commandForTool(params.name, args));
      const text = [
        run.stdout.trim(),
        run.stderr.trim() ? `stderr:\n${run.stderr.trim()}` : "",
        `exitCode: ${run.exitCode}`,
      ].filter(Boolean).join("\n\n");
      let structuredContent: unknown;
      if (["diffci_verify", "diffci_verify_changed", "diffci_run_affected_tests"].includes(params.name) && run.stdout.trim()) {
        try { structuredContent = JSON.parse(run.stdout); }
        catch { /* The text and non-zero status still carry the failure. */ }
      }
      success(id, {
        content: [{ type: "text", text }],
        isError: run.exitCode !== 0,
        structuredContent,
      });
      return;
    }
    default:
      failure(id, -32601, `unknown method: ${request.method ?? ""}`);
  }
}

let buffer = Buffer.alloc(0);
let lineTransport = false;
const decoder = new StringDecoder("utf8");

function readMessages(): void {
  while (true) {
    while (buffer.length && [9, 10, 13, 32].includes(buffer[0]!)) buffer = buffer.subarray(1);
    if (buffer.length === 0) return;
    if (buffer[0] === 123 || buffer[0] === 91 || lineTransport) {
      lineTransport = true;
      const end = buffer.indexOf("\n");
      if (end === -1) return;
      const body = buffer.subarray(0, end).toString("utf8").trim();
      buffer = buffer.subarray(end + 1);
      if (body) dispatch(body);
      continue;
    }
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const header = decoder.write(buffer.subarray(0, headerEnd));
    const match = /^Content-Length:\s*(\d+)\s*$/im.exec(header);
    if (!match) {
      buffer = buffer.subarray(headerEnd + 4);
      continue;
    }
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (buffer.length < bodyEnd) return;
    const body = buffer.subarray(bodyStart, bodyEnd).toString("utf8");
    buffer = buffer.subarray(bodyEnd);
    dispatch(body);
  }
}

function dispatch(body: string): void {
  let request: JsonRpcRequest;
  try { request = JSON.parse(body) as JsonRpcRequest; }
  catch { failure(null, -32700, "invalid JSON"); return; }
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    failure(null, -32600, "invalid request"); return;
  }
  void handle(request).catch((error: unknown) => {
    failure(request.id, -32603, error instanceof Error ? error.message : String(error));
  });
}

process.stdin.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  readMessages();
});

process.stdin.resume();
