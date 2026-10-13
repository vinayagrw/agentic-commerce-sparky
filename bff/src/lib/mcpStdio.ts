/**
 * Minimal MCP stdio client (initialize -> tools/list -> tools/call).
 *
 * The Claude CLI is its own MCP client for normal runs. The CaMeL executor
 * (agents/camel.ts) is not: it decides tool calls itself in TypeScript, so it needs to
 * speak to policy-mcp directly. This is that client — about as small as the protocol
 * allows, and enough to prove that a refused call is refused at the proxy.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface McpTool {
  name: string;
  description?: string;
}

export interface McpSpawn {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export class McpStdioClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  stderr = "";

  constructor(
    private readonly spec: McpSpawn,
    private readonly timeoutMs = 60_000,
  ) {}

  async start(): Promise<void> {
    const child = spawn(this.spec.command, this.spec.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(this.spec.env ?? {}) },
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    child.stderr.on("data", (c: Buffer) => {
      this.stderr = (this.stderr + c.toString()).slice(-4000);
    });
    child.stdout.on("data", (c: Buffer) => this.onData(c.toString()));
    child.on("error", (e) => this.failAll(e as Error));
    child.on("close", () => this.failAll(new Error(`policy-mcp exited. stderr: ${this.stderr.slice(-300)}`)));
    await this.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "sparky-camel-executor", version: "0" },
    });
    this.notify("notifications/initialized");
  }

  private onData(chunk: string) {
    this.buf += chunk;
    const lines = this.buf.split("\n");
    this.buf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      let msg: any;
      try {
        msg = JSON.parse(t);
      } catch {
        continue;
      }
      const p = typeof msg.id === "number" ? this.pending.get(msg.id) : undefined;
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message ?? "mcp error"));
      else p.resolve(msg.result);
    }
  }

  private failAll(e: Error) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
  }

  private notify(method: string, params: unknown = {}) {
    this.child?.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  private rpc(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child?.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async listTools(): Promise<McpTool[]> {
    const r = await this.rpc("tools/list", {});
    return (r?.tools ?? []) as McpTool[];
  }

  /** Call a tool and parse the JSON text result the server returns. */
  async callTool(name: string, args: Record<string, unknown>): Promise<any> {
    const r = await this.rpc("tools/call", { name, arguments: args });
    const text = (r?.content ?? [])
      .filter((c: any) => c?.type === "text" && typeof c.text === "string")
      .map((c: any) => c.text)
      .join("");
    if (!text) return { error: "empty tool result", isError: Boolean(r?.isError) };
    try {
      const parsed = JSON.parse(text);
      // FastMCP wraps a str-returning tool as {"result": "<json>"}; unwrap it.
      if (parsed && typeof parsed === "object" && Object.keys(parsed).length === 1 && typeof parsed.result === "string") {
        return JSON.parse(parsed.result);
      }
      return parsed;
    } catch {
      return { raw: text };
    }
  }

  stop() {
    try {
      this.child?.kill();
    } catch {
      /* gone */
    }
    this.child = null;
  }
}
