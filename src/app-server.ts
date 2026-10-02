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
export function notificationTurnId(params: Record<string, unknown>): string | null {
  if (typeof params.turnId === "string") return params.turnId;
  if (typeof params.turn_id === "string") return params.turn_id;
  const turn = params.turn;
  return turn && typeof turn === "object" && typeof (turn as Record<string, unknown>).id === "string"
    ? (turn as { id: string }).id : null;
}
export type AppServerExitHandler = (event: { epoch: number; code: number | null; error?: Error }) => void;
export type AppServerHealthState = "stopped" | "starting" | "healthy" | "unhealthy" | "restarting";
export interface AppServerHealth { state: AppServerHealthState; epoch: number; sinceMs: number; lastError?: string; }
export interface AppServerLifecycleEvent { kind: "started" | "exited" | "stopped"; epoch: number; error?: Error; }
export class AppServerRpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) { super(message); this.name = "AppServerRpcError"; }
}
export interface AppServerPort {
  readonly appServerEpoch: number;
  readonly isHealthy: boolean;
  getHealth(): AppServerHealth;
  ensureStarted(): Promise<void>;
  request<T = unknown>(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  respond(id: JsonRpcId, result: unknown): Promise<void>;
  reject(id: JsonRpcId, error: { code: number; message: string; data?: unknown }): Promise<void>;
  interrupt(threadId: string, turnId: string): Promise<void>;
  unarchiveThread(threadId: string): Promise<void>;
  unsubscribeThread(threadId: string): Promise<void>;
  restart(reason?: string): Promise<void>;
  close(): Promise<void>;
}
const execFileAsync = promisify(execFile);
const REQUIRED_PROTOCOL_TOKENS = ["thread/start", "thread/resume", "thread/list", "thread/archive", "turn/start", "turn/steer", "turn/interrupt", "item/tool/requestUserInput", "item/commandExecution/requestApproval", "item/fileChange/requestApproval", "turn/completed", "thread/unarchive", "thread/unsubscribe", "thread/archived", "thread/unarchived", "thread/deleted"];

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
  private writeTail: Promise<void> = Promise.resolve();
  private healthState: AppServerHealthState = "stopped";
  private healthSinceMs = Date.now();
  private lastHealthError: string | undefined;
  private expectedClose = false;
  private notifiedExitEpoch = -1;
  private readonly lifecycleHandlers = new Set<(event: AppServerLifecycleEvent) => void>();

  constructor(private readonly bin: string, private readonly codexHome: string, private readonly stateDir?: string) {}

  get appServerEpoch(): number { return this.epoch; }
  get isHealthy(): boolean { return this.healthy; }
  getHealth(): AppServerHealth { return { state: this.healthState, epoch: this.epoch, sinceMs: this.healthSinceMs, ...(this.lastHealthError ? { lastError: this.lastHealthError } : {}) }; }
  onLifecycle(handler: (event: AppServerLifecycleEvent) => void): () => void { this.lifecycleHandlers.add(handler); return () => this.lifecycleHandlers.delete(handler); }
  private setHealth(state: AppServerHealthState, error?: Error): void { this.healthState = state; this.healthSinceMs = Date.now(); this.lastHealthError = error?.message; }
  private emitLifecycle(event: AppServerLifecycleEvent): void { for (const handler of this.lifecycleHandlers) handler(event); }
  private notifyExit(code: number | null, error: Error): void { if (this.notifiedExitEpoch === this.epoch) return; this.notifiedExitEpoch = this.epoch; this.healthy = false; this.setHealth(this.expectedClose ? "stopped" : "unhealthy", error); this.failPending(error); if (!this.expectedClose) for (const handler of this.exitHandlers) handler({ epoch: this.epoch, code, error }); this.emitLifecycle({ kind: this.expectedClose ? "stopped" : "exited", epoch: this.epoch, error }); }
  onServerRequest(handler: ServerRequestHandler): void { this.handler = handler; }
  onNotification(handler: ServerNotificationHandler): void { this.notificationHandler = handler; }
  onExit(handler: AppServerExitHandler): () => void { this.exitHandlers.add(handler); return () => this.exitHandlers.delete(handler); }
  async ensureStarted(): Promise<void> { await this.start(); }
  async restart(reason = "manual restart"): Promise<void> { this.setHealth("restarting", new Error(reason)); await this.close(); await this.start(); }
  async interrupt(threadId: string, turnId: string): Promise<void> { await this.request("turn/interrupt", { threadId, turnId }, 10_000); }
  async unarchiveThread(threadId: string): Promise<void> { await this.request("thread/unarchive", { threadId }, 15_000); }
  async unsubscribeThread(threadId: string): Promise<void> {
    try { await this.request("thread/unsubscribe", { threadId }, 10_000); }
    catch (error) {
      if (error instanceof AppServerRpcError && /unsubscribed|notSubscribed|not subscribed|notLoaded|not loaded/i.test(error.message)) return;
      throw error;
    }
  }

  async start(): Promise<void> {
    if (this.child && this.healthy) return;
    this.setHealth("starting");
    if (this.starting) return this.starting;
    this.starting = this.startImpl().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async startImpl(): Promise<void> {
    if (this.child) await this.close();
    const enabled = await this.detectFeatureFlags();
    await this.cacheAndVerifySchema();
    this.expectedClose = false;
    this.child = spawn(this.bin, ["app-server", "--stdio", ...enabled.flatMap((name) => ["--enable", name])], {
      env: { ...process.env, CODEX_HOME: this.codexHome }, stdio: ["pipe", "pipe", "pipe"],
    });
    this.epoch += 1;
    this.child.stderr.setEncoding("utf8").on("data", (chunk: string) => console.warn(`[codex app-server] ${chunk.trimEnd()}`));
    this.notifiedExitEpoch = -1;
    this.child.on("close", (code) => { const error = new Error("Codex app-server exited (" + (code ?? "unknown") + ")"); this.child = null; this.notifyExit(code, error); });
    this.child.on("error", (error) => this.notifyExit(null, error instanceof Error ? error : new Error(String(error))));
    this.child.stdin.on("error", (error) => this.notifyExit(null, error instanceof Error ? error : new Error(String(error))));
    this.lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.lines.on("line", (line) => this.consume(line));
    await this.request("initialize", { clientInfo: { name: "feishu-codex-bridge", title: "Feishu Codex Bridge", version: "0.2.0" }, capabilities: { experimentalApi: true, mcpServerOpenaiFormElicitation: true } });
    await this.write({ method: "initialized", params: {} });
    this.healthy = true;
    this.setHealth("healthy");
    this.emitLifecycle({ kind: "started", epoch: this.epoch });
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
    this.expectedClose = true;
    this.lines?.close();
    this.lines = null;
    const child = this.child;
    this.child = null;
    this.failPending(new Error("Codex app-server closed"));
    this.healthy = false;
    this.setHealth("stopped");
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
      void this.write({ jsonrpc: "2.0", id, method, params }).catch((error) => {
        clearTimeout(timer); this.pending.delete(id); reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async respond(id: JsonRpcId, result: unknown): Promise<void> { await this.writeWithTimeout({ jsonrpc: "2.0", id, result }, 10_000); }
  async reject(id: JsonRpcId, error: { code: number; message: string; data?: unknown }): Promise<void> { await this.writeWithTimeout({ jsonrpc: "2.0", id, error }, 10_000); }

  private async startIfNeeded(): Promise<void> {
    if (this.child) {
      if (this.healthState === "unhealthy") throw new Error("Codex app-server is unhealthy");
      return;
    }
    await this.start();
  }
  private async writeWithTimeout(message: JsonRpcMessage, timeoutMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try { await Promise.race([this.write(message), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Codex app-server write timed out")), timeoutMs); timer.unref(); })]); } finally { if (timer) clearTimeout(timer); }
  }
  private write(message: JsonRpcMessage): Promise<void> {
    const payload = JSON.stringify(message) + "\n";
    this.writeTail = this.writeTail.catch(() => undefined).then(() => new Promise<void>((resolve, reject) => {
      const stdin = this.child?.stdin as Writable | undefined;
      if (!stdin || stdin.destroyed) { reject(new Error("Codex app-server is not running")); return; }
      let settled = false;
      const onError = (error: Error) => done(error);
      const done = (error?: Error | null) => {
        if (settled) return; settled = true; stdin.removeListener("error", onError);
        if (error) reject(error); else resolve();
      };
      const accepted = stdin.write(payload, (error) => done(error));
      if (!accepted) stdin.once("drain", () => done());
      stdin.once("error", onError);
    }));
    return this.writeTail;
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
      if (message.error) {
        const value = message.error;
        if (value && typeof value === "object" && typeof (value as Record<string, unknown>).code === "number" && typeof (value as Record<string, unknown>).message === "string") {
          const error = value as Record<string, unknown>;
          pending.reject(new AppServerRpcError(Number(error.code), String(error.message), error.data));
        } else pending.reject(new Error(typeof value === "string" ? value : JSON.stringify(value)));
      }
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
