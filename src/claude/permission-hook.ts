import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { join, resolve } from "node:path";
import type { PermissionRequestHookInput, PermissionRequestHookSpecificOutput, SyncHookJSONOutput } from "@anthropic-ai/claude-agent-sdk";

export const PERMISSION_HOOK_PROTOCOL = "feishu-permission-hook-v1" as const;
export const DEFAULT_PERMISSION_HOOK_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_FRAME_BYTES = 1_000_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type PermissionHookDecision = PermissionRequestHookSpecificOutput["decision"];

/** Local request id because the SDK PermissionRequestHookInput has no request-id field. */
export interface PermissionHookRequest {
  requestId: string;
  inputDigest: string;
  input: PermissionRequestHookInput;
}

export interface PermissionHookFrame extends PermissionHookRequest {
  protocol: typeof PERMISSION_HOOK_PROTOCOL;
}

export interface PermissionHookReply extends PermissionHookRequest {
  decision: PermissionHookDecision;
}

export type PermissionApprovalHandler = (request: PermissionHookRequest, signal: AbortSignal) => Promise<PermissionHookReply>;

export interface PermissionHookClock {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type PermissionHookSocketProbe = (socketPath: string) => Promise<"active" | "stale">;

export interface PermissionHookServerOptions {
  stateDir: string;
  onRequest: PermissionApprovalHandler;
  timeoutMs?: number;
  clock?: PermissionHookClock;
}

export interface PermissionHookClientOptions {
  timeoutMs?: number;
  requestId?: string;
}

export interface PermissionHookServer {
  readonly socketPath: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface ActivePermissionRequest {
  controller: AbortController;
  request: PermissionHookRequest;
  timer?: unknown;
}

export function permissionInputDigest(input: PermissionRequestHookInput): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function createPermissionHookFrame(input: PermissionRequestHookInput, requestId: string = randomUUID()): PermissionHookFrame {
  if (!UUID_PATTERN.test(requestId)) throw new Error("requestId must be a UUID");
  return { protocol: PERMISSION_HOOK_PROTOCOL, requestId, inputDigest: permissionInputDigest(input), input };
}

export function permissionHookOutput(decision: PermissionHookDecision): SyncHookJSONOutput {
  return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision } };
}

/** Fail-closed Unix-socket client, also useful to exercise the protocol without launching Claude. */
export function requestPermissionHook(
  socketPath: string,
  input: PermissionRequestHookInput,
  options: PermissionHookClientOptions = {},
): Promise<PermissionHookReply> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PERMISSION_HOOK_TIMEOUT_MS;
  const request = createPermissionHookFrame(input, options.requestId);
  const denied = (message: string): PermissionHookReply => ({
    requestId: request.requestId, inputDigest: request.inputDigest, input,
    decision: { behavior: "deny", message },
  });
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEFAULT_PERMISSION_HOOK_TIMEOUT_MS) {
    return Promise.resolve(denied("审批等待超时配置无效，已拒绝。"));
  }
  return new Promise((resolveReply) => {
    const socket = connect(socketPath);
    let finished = false;
    let buffer = Buffer.alloc(0);
    const finish = (reply: PermissionHookReply): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      resolveReply(reply);
    };
    const timer = setTimeout(() => finish(denied("审批等待超时，已拒绝。")), timeoutMs);
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_FRAME_BYTES) { finish(denied("审批响应过大，已拒绝。")); return; }
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      let parsed: unknown;
      try { parsed = JSON.parse(buffer.subarray(0, newline).toString("utf8")); } catch { finish(denied("审批响应无效，已拒绝。")); return; }
      const response = parsed as Partial<PermissionHookReply> & { protocol?: unknown };
      if (response.protocol !== PERMISSION_HOOK_PROTOCOL || response.requestId !== request.requestId
        || response.inputDigest !== request.inputDigest || !isPermissionDecision(response.decision)) {
        finish(denied("审批响应与本次请求不匹配，已拒绝。"));
      } else finish({ requestId: request.requestId, inputDigest: request.inputDigest, input, decision: response.decision });
    });
    socket.once("error", () => finish(denied("审批服务不可用，已拒绝。")));
    socket.once("close", () => { if (!finished) finish(denied("审批服务已断开，已拒绝。")); });
  });
}

/** Creates a single-request-per-connection Unix socket service for the Agent SDK hook process. */
export function createPermissionHookServer(options: PermissionHookServerOptions): PermissionHookServer {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PERMISSION_HOOK_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEFAULT_PERMISSION_HOOK_TIMEOUT_MS) {
    throw new Error("timeoutMs must be between 1 and 600000");
  }
  const stateDir = resolve(options.stateDir);
  const socketPath = join(stateDir, "claude-permission-hook.sock");
  const clock = options.clock ?? { setTimeout, clearTimeout };
  let server: Server | null = null;
  let stopped = false;
  let ownedSocketIdentity: { dev: number; ino: number; uid: number } | null = null;
  const sockets = new Set<Socket>();
  const active = new Map<Socket, ActivePermissionRequest>();
  const seenRequestIds = new Set<string>();

  const writeReply = (socket: Socket, reply: PermissionHookReply): void => {
    if (!socket.destroyed) socket.end(`${JSON.stringify({ protocol: PERMISSION_HOOK_PROTOCOL, ...reply })}\n`);
  };
  const deny = (request: PermissionHookRequest, message: string): void => {
    const reply: PermissionHookReply = { ...request, decision: { behavior: "deny", message } };
    for (const socket of sockets) {
      const pending = active.get(socket);
      if (pending?.controller.signal.aborted) continue;
      // A client connection is handled independently; only the current in-flight request is written.
      const current = (socket as Socket & { permissionRequest?: PermissionHookRequest }).permissionRequest;
      if (current?.requestId === request.requestId) writeReply(socket, reply);
    }
  };

  const handleFrame = async (socket: Socket, value: unknown): Promise<void> => {
    const request = parsePermissionHookFrame(value);
    if (!request) { socket.destroy(); return; }
    (socket as Socket & { permissionRequest?: PermissionHookRequest }).permissionRequest = request;
    if (stopped) { deny(request, "审批服务已停止，已拒绝。"); return; }
    if (seenRequestIds.has(request.requestId)) { deny(request, "审批请求重复或已处理，已拒绝。"); return; }
    seenRequestIds.add(request.requestId);

    const controller = new AbortController();
    const pendingRequest: ActivePermissionRequest = { controller, request };
    active.set(socket, pendingRequest);
    let timer: unknown;
    const timeout = new Promise<PermissionHookReply>((resolveTimeout) => {
      timer = clock.setTimeout(() => {
        controller.abort(new Error("approval timeout"));
        resolveTimeout({ ...request, decision: { behavior: "deny", message: "审批超时（10分钟），已拒绝。" } });
      }, timeoutMs);
    });
    pendingRequest.timer = timer;
    try {
      const handled = Promise.resolve().then(() => options.onRequest(request, controller.signal));
      const reply = await Promise.race([handled, timeout]);
      if (reply.requestId !== request.requestId || reply.inputDigest !== request.inputDigest || !isPermissionDecision(reply.decision)) {
        deny(request, "审批响应与当前请求不匹配，已拒绝。");
      } else {
        writeReply(socket, { ...request, decision: reply.decision });
      }
    } catch {
      deny(request, "审批处理失败或服务不可用，已拒绝。");
    } finally {
      clock.clearTimeout(timer);
      active.delete(socket);
    }
  };

  return {
    socketPath,
    async start(): Promise<void> {
      if (server) throw new Error("permission hook server already started");
      await ensureSecureStateDir(stateDir);
      await recoverStalePermissionHookSocket(socketPath);
      server = createServer((socket) => {
        sockets.add(socket);
        socket.once("close", () => {
          sockets.delete(socket);
          const pending = active.get(socket);
          if (pending) {
            clock.clearTimeout(pending.timer);
            pending.controller.abort(new Error("hook client disconnected"));
          }
          active.delete(socket);
        });
        let buffer = Buffer.alloc(0);
        let received = false;
        socket.on("data", (chunk) => {
          if (received) { socket.destroy(); return; }
          buffer = Buffer.concat([buffer, chunk]);
          if (buffer.length > MAX_FRAME_BYTES) { socket.destroy(); return; }
          const newline = buffer.indexOf(0x0a);
          if (newline < 0) return;
          received = true;
          const extra = buffer.subarray(newline + 1).toString("utf8").trim();
          if (extra) { socket.destroy(); return; }
          let parsed: unknown;
          try { parsed = JSON.parse(buffer.subarray(0, newline).toString("utf8")); } catch { socket.destroy(); return; }
          void handleFrame(socket, parsed);
        });
      });
      await new Promise<void>((resolveListen, rejectListen) => {
        server!.once("error", rejectListen);
        server!.listen(socketPath, resolveListen);
      });
      const createdSocket = await lstat(socketPath);
      if (!createdSocket.isSocket() || createdSocket.uid !== process.getuid?.()) {
        await this.stop();
        throw new Error("permission hook socket ownership is unsafe");
      }
      ownedSocketIdentity = { dev: createdSocket.dev, ino: createdSocket.ino, uid: createdSocket.uid };
      await chmod(socketPath, 0o600);
      const socketStat = await lstat(socketPath);
      if (!socketStat.isSocket() || socketStat.uid !== process.getuid?.() || (socketStat.mode & 0o077) !== 0) {
        await this.stop();
        throw new Error("permission hook socket ownership or permissions are unsafe");
      }
    },
    async stop(): Promise<void> {
      stopped = true;
      for (const [socket, pending] of active) {
        clock.clearTimeout(pending.timer);
        pending.controller.abort(new Error("permission hook service stopped"));
        const request = (socket as Socket & { permissionRequest?: PermissionHookRequest }).permissionRequest;
        if (request) writeReply(socket, { ...request, decision: { behavior: "deny", message: "审批服务已停止，已拒绝。" } });
        else socket.destroy();
      }
      for (const socket of sockets) socket.destroy();
      if (server) {
        const currentServer = server;
        server = null;
        await new Promise<void>((resolveClose) => currentServer.close(() => resolveClose()));
      }
      try {
        const socketStat = await lstat(socketPath);
        if (ownedSocketIdentity && socketStat.isSocket() && socketStat.uid === ownedSocketIdentity.uid
          && socketStat.dev === ownedSocketIdentity.dev && socketStat.ino === ownedSocketIdentity.ino) await unlink(socketPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      ownedSocketIdentity = null;
    },
  };
}

export function parsePermissionHookFrame(value: unknown): PermissionHookRequest | null {
  if (!value || typeof value !== "object") return null;
  const frame = value as Partial<PermissionHookFrame>;
  if (frame.protocol !== PERMISSION_HOOK_PROTOCOL || typeof frame.requestId !== "string" || !UUID_PATTERN.test(frame.requestId)
    || typeof frame.inputDigest !== "string" || !/^[a-f0-9]{64}$/.test(frame.inputDigest) || !isPermissionRequestInput(frame.input)) return null;
  if (permissionInputDigest(frame.input) !== frame.inputDigest) return null;
  return { requestId: frame.requestId, inputDigest: frame.inputDigest, input: frame.input };
}

/** Removes only an owned, private Unix socket that is provably stale and unchanged after probing. */
export async function recoverStalePermissionHookSocket(
  socketPath: string,
  probe: PermissionHookSocketProbe = probePermissionHookSocket,
): Promise<boolean> {
  let before;
  try { before = await lstat(socketPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const uid = process.getuid?.();
  if (!before.isSocket() || before.isSymbolicLink() || uid === undefined || before.uid !== uid) {
    throw new Error("refusing to replace an untrusted permission hook socket path");
  }
  if ((before.mode & 0o077) !== 0) throw new Error("permission hook socket permissions are unsafe");

  const status = await probe(socketPath);
  if (status === "active") throw new Error("permission hook socket is already active");

  let after;
  try { after = await lstat(socketPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!after.isSocket() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino
    || after.uid !== before.uid || (after.mode & 0o077) !== 0) {
    throw new Error("permission hook socket changed during stale-path check; refusing to remove it");
  }
  await unlink(socketPath);
  return true;
}

function isPermissionRequestInput(value: unknown): value is PermissionRequestHookInput {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<PermissionRequestHookInput>;
  return input.hook_event_name === "PermissionRequest" && typeof input.session_id === "string"
    && typeof input.transcript_path === "string" && typeof input.cwd === "string" && typeof input.tool_name === "string"
    && Object.hasOwn(input, "tool_input");
}

function isPermissionDecision(value: unknown): value is PermissionHookDecision {
  if (!value || typeof value !== "object") return false;
  const decision = value as { behavior?: unknown; message?: unknown; updatedInput?: unknown; updatedPermissions?: unknown; interrupt?: unknown };
  if (decision.behavior === "deny") return (decision.message === undefined || typeof decision.message === "string")
    && (decision.interrupt === undefined || typeof decision.interrupt === "boolean");
  if (decision.behavior !== "allow") return false;
  return (decision.updatedInput === undefined || (typeof decision.updatedInput === "object" && decision.updatedInput !== null && !Array.isArray(decision.updatedInput)))
    && (decision.updatedPermissions === undefined || Array.isArray(decision.updatedPermissions));
}

async function ensureSecureStateDir(stateDir: string): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const info = await lstat(stateDir);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()) throw new Error("permission hook state directory must be a real directory owned by this uid");
  await chmod(stateDir, 0o700);
  const secured = await lstat(stateDir);
  if ((secured.mode & 0o077) !== 0) throw new Error("permission hook state directory must have mode 0700");
}

function probePermissionHookSocket(socketPath: string): Promise<"active" | "stale"> {
  return new Promise((resolveProbe, rejectProbe) => {
    const socket = connect(socketPath);
    let settled = false;
    const finish = (status?: "active" | "stale", error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) rejectProbe(error);
      else resolveProbe(status!);
    };
    const timer = setTimeout(() => finish(undefined, new Error("permission hook socket probe timed out; refusing to remove it")), 500);
    socket.once("connect", () => finish("active"));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") finish("stale");
      else finish(undefined, error);
    });
  });
}

/** Utility for tests and clients: stateDir is secured by the service, and socket is its fixed child. */
export function permissionHookSocketPath(stateDir: string): string {
  return join(resolve(stateDir), "claude-permission-hook.sock");
}
