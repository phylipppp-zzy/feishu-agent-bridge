import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createInterface, type Interface } from "node:readline";
import type { Writable } from "node:stream";

export type JsonRpcId = string | number;
export interface JsonRpcMessage { jsonrpc?: "2.0"; id?: JsonRpcId; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown; }
export type ServerRequestHandler = (request: JsonRpcMessage) => Promise<unknown>;
export type ServerNotificationHandler = (notification: JsonRpcMessage) => Promise<void> | void;
export type AppServerExitHandler = (event: { epoch: number; code: number | null; error?: Error }) => void;
const execFileAsync = promisify(execFile);
const REQUIRED_PROTOCOL_TOKENS = ["thread/start", "thread/resume", "thread/list", "turn/start", "turn/steer", "turn/interrupt", "item/tool/requestUserInput", "item/commandExecution/requestApproval", "item/fileChange/requestApproval", "turn/completed"];

/** Bidirectional JSON-RPC transport for local Codex app-server clients. */
export class CodexAppServer {
  private child: ChildProcessWithoutNullStreams | null = null;
  private lines: Interface | null = null;
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private readonly exitHandlers = new Set<AppServerExitHandler>();
  private epoch = 0;
  private handler: ServerRequestHandler | null = null;
  private notificationHandler: ServerNotificationHandler | null = null;
  private starting: Promise<void> | null = null;
  private healthy = false;

  constructor(private readonly bin: string, private readonly codexHome: string, private readonly stateDir?: string) {}

  get appServerEpoch(): number { return this.epoch; }
  get isHealthy(): boolean { return this.healthy; }
  onServerRequest(handler: ServerRequestHandler): void { this.handler = handler; }
  onNotification(handler: ServerNotificationHandler): void { this.notificationHandler = handler; }
  onExit(handler: AppServerExitHandler): () => void { this.exitHandlers.add(handler); return () => this.exitHandlers.delete(handler); }
  async restart(): Promise<void> { await this.close(); await this.start(); }

  async start(): Promise<void> {
    if (this.child && this.healthy) return;
    if (this.starting) return this.starting;
    this.starting = this.startImpl().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async startImpl(): Promise<void> {
    if (this.child) await this.close();
    const enabled = await this.detectFeatureFlags();
    await this.cacheAndVerifySchema();
    this.child = spawn(this.bin, ["app-server", "--stdio", ...enabled.flatMap((name) => ["--enable", name])], {
      env: { ...process.env, CODEX_HOME: this.codexHome }, stdio: ["pipe", "pipe", "pipe"],
    });
    this.epoch += 1;
    this.child.stderr.setEncoding("utf8").on("data", (chunk: string) => console.warn(`[codex app-server] ${chunk.trimEnd()}`));
    this.child.on("close", (code) => {
      this.healthy = false;
      this.child = null;
      const error = new Error(`Codex app-server exited (${code ?? "unknown"})`);
      this.failPending(error);
      for (const handler of this.exitHandlers) handler({ epoch: this.epoch, code, error });
    });
    this.child.on("error", (error) => {
      this.healthy = false;
      this.failPending(error instanceof Error ? error : new Error(String(error)));
    });
    this.lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.lines.on("line", (line) => this.consume(line));
    await this.request("initialize", { clientInfo: { name: "feishu-codex-bridge", title: "Feishu Codex Bridge", version: "0.2.0" }, capabilities: { experimentalApi: true, mcpServerOpenaiFormElicitation: true } });
    this.write({ method: "initialized", params: {} });
    this.healthy = true;
  }

  private async detectFeatureFlags(): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync(this.bin, ["features", "list"], { env: { ...process.env, CODEX_HOME: this.codexHome }, maxBuffer: 1_000_000 });
      const supported = new Set(stdout.split("\n").map((line) => line.trim().split(/\s+/)[0]).filter(Boolean));
      return ["default_mode_request_user_input", "request_permissions_tool", "exec_permission_approvals"].filter((name) => supported.has(name));
    } catch (error) {
      console.warn("Unable to probe Codex feature flags; starting without optional flags", error);
      return [];
    }
  }

  private async cacheAndVerifySchema(): Promise<void> {
    if (!this.stateDir) return;
    const { stdout } = await execFileAsync(this.bin, ["--version"], { env: { ...process.env, CODEX_HOME: this.codexHome } });
    const safeVersion = stdout.trim().replace(/[^a-zA-Z0-9._-]+/g, "_") || "unknown";
    const output = join(this.stateDir, "app-server-schema", safeVersion);
    await mkdir(output, { recursive: true, mode: 0o700 });
    try {
      await execFileAsync(this.bin, ["app-server", "generate-json-schema", "--experimental", "--out", output], { env: { ...process.env, CODEX_HOME: this.codexHome }, maxBuffer: 1_000_000 });
    } catch (error) {
      // A previously cached schema for the same binary remains a valid contract.
      console.warn("Unable to regenerate app-server schema; using cache if available", error);
    }
    let combined = "";
    for (const name of ["codex_app_server_protocol.schemas.json", "ClientRequest.json", "ServerRequest.json", "ServerNotification.json"]) {
      try { combined += await readFile(join(output, name), "utf8"); } catch { /* a release can split schemas differently */ }
    }
    const missing = REQUIRED_PROTOCOL_TOKENS.filter((token) => !combined.includes(token));
    if (missing.length) throw new Error(`Codex app-server lacks required bridge protocol: ${missing.join(", ")}`);
  }

  async close(): Promise<void> {
    this.lines?.close();
    this.lines = null;
    const child = this.child;
    this.child = null;
    this.failPending(new Error("Codex app-server closed"));
    this.healthy = false;
    if (!child) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5_000);
      child.once("close", () => { clearTimeout(timer); resolve(); });
    });
  }

  async request(method: string, params: Record<string, unknown>, timeoutMs = method === "turn/start" ? 30_000 : 15_000): Promise<unknown> {
    await this.startIfNeeded();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`Codex app-server RPC timed out: ${method}`)); }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ jsonrpc: "2.0", id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  respond(id: JsonRpcId, result: unknown): void { this.write({ jsonrpc: "2.0", id, result }); }
  reject(id: JsonRpcId, error: { code: number; message: string; data?: unknown }): void { this.write({ jsonrpc: "2.0", id, error }); }

  private async startIfNeeded(): Promise<void> { if (!this.child) await this.start(); }
  private write(message: JsonRpcMessage): void {
    const stdin = this.child?.stdin as Writable | undefined;
    if (!stdin || stdin.destroyed) throw new Error("Codex app-server is not running");
    stdin.write(`${JSON.stringify(message)}\n`);
  }
  private consume(line: string): void {
    if (!line.trim()) return;
    let message: JsonRpcMessage;
    try { message = JSON.parse(line) as JsonRpcMessage; } catch { console.warn("Ignoring invalid app-server JSON-RPC line"); return; }
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(typeof message.error === "string" ? message.error : JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      void Promise.resolve(this.handler?.(message)).then((result) => {
        if (result !== undefined) this.respond(message.id!, result);
        else this.reject(message.id!, { code: -32601, message: `Unsupported app-server request ${message.method}` });
      }).catch((error) => this.reject(message.id!, { code: -32000, message: error instanceof Error ? error.message : String(error) }));
      return;
    }
    if (message.method) void Promise.resolve(this.notificationHandler?.(message)).catch((error) => {
      console.warn(`app-server notification handler failed for ${message.method}`, error);
    });
  }
  private failPending(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
}
