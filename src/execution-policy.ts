import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ApprovalContext, BridgeConfig, RemoteRequestType, SafeApprovalSummary } from "./types.js";

export interface RootPreflightResult { ok: boolean; reasons: string[]; }
/** thread/start and thread/resume use SandboxMode; turn/start uses SandboxPolicy. */
export function threadSandboxMode(policy: Record<string, unknown>): "read-only" | "workspace-write" | "danger-full-access" {
  if (policy.type === "readOnly") return "read-only";
  if (policy.type === "workspaceWrite") return "workspace-write";
  if (policy.type === "dangerFullAccess") return "danger-full-access";
  throw new Error("Unsupported thread sandbox policy");
}
const SOCKETS = ["/var/run/docker.sock", "/run/docker.sock", "/var/run/podman/podman.sock", "/run/podman/podman.sock", "/var/run/containerd/containerd.sock"];
const CAP_SYS_MODULE = 16n;
const CAP_SYS_ADMIN = 21n;
async function text(path: string): Promise<string> { try { return await readFile(path, "utf8"); } catch { return ""; } }
async function accessibleSocket(path: string): Promise<boolean> { try { const info = await stat(path); await access(path, constants.R_OK | constants.W_OK); return info.isSocket(); } catch { return false; } }

export async function rootExecutionPreflight(config: BridgeConfig): Promise<RootPreflightResult> {
  if (config.executionMode !== "root-danger-full-access") return { ok: false, reasons: ["Root mode is not configured"] };
  const reasons: string[] = [];
  if (typeof process.getuid === "function" && process.getuid() !== 0) reasons.push("process UID is not 0");
  const cgroup = await text("/proc/1/cgroup"); const mountInfo = await text("/proc/self/mountinfo");
  const inContainer = cgroup.includes("docker") || cgroup.includes("containerd") || cgroup.includes("kubepods") || mountInfo.includes("/docker/") || mountInfo.includes("/containers/");
  if (!inContainer) reasons.push("dedicated container environment was not detected");
  const status = await text("/proc/self/status"); const cap = /^CapEff:\s*([0-9a-f]+)$/mi.exec(status)?.[1];
  if (!cap) reasons.push("effective capabilities cannot be inspected"); else { const effective = BigInt("0x" + cap); if ((effective & (1n << CAP_SYS_ADMIN)) !== 0n) reasons.push("CAP_SYS_ADMIN is present"); if ((effective & (1n << CAP_SYS_MODULE)) !== 0n) reasons.push("CAP_SYS_MODULE is present"); }
  for (const socket of SOCKETS) if (await accessibleSocket(socket)) reasons.push("container runtime socket is accessible: " + socket);
  return { ok: reasons.length === 0, reasons };
}

const SENSITIVE = /(?:\.ssh|id_rsa|known_hosts|\.aws|\.azure|\.config\/gcloud|kubeconfig|shadow|passwd|credentials?|secret|token|api[_-]?key|password|cookie|authorization|private[_-]?key)/i;
const FORBIDDEN_COMMAND = /(?:^|[\s;&|])(sudo|su|doas|setcap|capsh|unshare|nsenter|mount|umount|docker|podman|containerd|crictl)(?:$|[\s;&|])/i;
const UPLOAD_COMMAND = /(?:curl|wget|http|ftp|nc|netcat|scp|rsync)(?:\s|$)/i;
const SOCKET_PATH = /(?:\/var\/run|\/run|\/proc\/1\/root|docker\.sock|podman|containerd)/i;
const KNOWN_PERMISSION_TYPES = new Set(["fs_read", "fs_write", "network", "process", "clipboard", "mcp"]);

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, resolve(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}
function commandText(params: Record<string, unknown>): string { return typeof params.command === "string" ? params.command : Array.isArray(params.command) ? params.command.filter((v): v is string => typeof v === "string").join(" ") : ""; }
function safeCommand(command: string): string { return command.replace(/(?:authorization|cookie|token|password|secret|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[REDACTED]").slice(0, 200); }

export function remoteApprovalSummary(type: RemoteRequestType, params: Record<string, unknown>, context?: ApprovalContext): SafeApprovalSummary {
  const summary: SafeApprovalSummary = { type };
  const reason = typeof params.reason === "string" ? params.reason.replace(/\s+/g, " ").slice(0, 300) : undefined;
  if (reason) summary.reason = reason;
  const command = commandText(params); if (command) summary.commandSummary = safeCommand(command);
  const rawPaths = Array.isArray(params.changes) ? params.changes : Array.isArray(params.paths) ? params.paths : [];
  const paths = rawPaths.filter((v): v is string => typeof v === "string").slice(0, 50).map((p) => context ? relative(context.canonicalCwd, resolve(p)).slice(0, 240) : p.slice(0, 240));
  if (paths.length) summary.relativePaths = paths;
  const permissions = Array.isArray(params.permissions) ? params.permissions : [];
  const kinds = permissions.map((p) => typeof p === "object" && p ? (p as Record<string, unknown>).type : undefined).filter((v): v is string => typeof v === "string");
  if (kinds.length) summary.permissionKinds = [...new Set(kinds)].slice(0, 20);
  const mcp = typeof params.serverName === "string" ? params.serverName : typeof params.server_name === "string" ? params.server_name : undefined;
  if (mcp) summary.mcpServer = mcp.slice(0, 120);
  return summary;
}

export function remoteApprovalAllowed(type: RemoteRequestType, params: Record<string, unknown>, allowedMcpServers: readonly string[], context?: ApprovalContext): { allowed: boolean; reason?: string; summary?: SafeApprovalSummary } {
  const summary = remoteApprovalSummary(type, params, context);
  const encoded = JSON.stringify(params);
  if (type === "user_input") {
    if (/(secret|password|token|credential|api[_-]?key|verification|captcha|login)/i.test(encoded)) return { allowed: false, reason: "secret or authentication input is forbidden in Feishu", summary };
    return { allowed: true, summary };
  }
  if (!context) return { allowed: false, reason: "approval context is required", summary };
  if (context.collaborationMode === "plan") return { allowed: false, reason: "Plan mode is read-only and cannot approve side effects", summary };
  if (type === "mcp_elicitation") {
    if (!summary.mcpServer || !allowedMcpServers.includes(summary.mcpServer)) return { allowed: false, reason: "MCP server is not on the allowlist", summary };
    if (/(secret|credential|token|password|authorization|api[_-]?key)/i.test(encoded)) return { allowed: false, reason: "MCP authentication and secrets are forbidden", summary };
    return { allowed: true, summary };
  }
  if (SENSITIVE.test(encoded) || SOCKET_PATH.test(encoded) || FORBIDDEN_COMMAND.test(encoded)) return { allowed: false, reason: "privilege escalation, sensitive data, or runtime socket access is forbidden", summary };
  if (type === "command_approval") {
    const command = commandText(params);
    if (!command || UPLOAD_COMMAND.test(command) || /[<>\x60]|(?:^|[\s])(?:sh|bash|zsh|fish|env|xargs)(?:\s|$)/i.test(command)) return { allowed: false, reason: "command cannot be safely reviewed or may upload data", summary };
  }
  if (type === "file_approval") {
    const grantRoot = typeof params.grantRoot === "string" ? params.grantRoot : typeof params.grant_root === "string" ? params.grant_root : context.canonicalCwd;
    if (!inside(context.canonicalCwd, grantRoot)) return { allowed: false, reason: "writes outside the authorized workspace are forbidden", summary };
  }
  if (type === "permissions") {
    const permissions = Array.isArray(params.permissions) ? params.permissions : null;
    if (!permissions) return { allowed: false, reason: "permission request shape is not recognized", summary };
    for (const permission of permissions) {
      if (!permission || typeof permission !== "object") return { allowed: false, reason: "permission request shape is not recognized", summary };
      const item = permission as Record<string, unknown>; const kind = typeof item.type === "string" ? item.type : "";
      if (!KNOWN_PERMISSION_TYPES.has(kind)) return { allowed: false, reason: "permission type is not allowlisted", summary };
      if (kind === "fs_write" || kind === "fs_read") { const path = typeof item.path === "string" ? item.path : ""; if (!path || !inside(context.canonicalCwd, path) || SENSITIVE.test(path)) return { allowed: false, reason: "filesystem access is outside the authorized workspace or sensitive", summary }; }
      if (kind === "network" || kind === "process" || kind === "clipboard") return { allowed: false, reason: "network, process, and clipboard escalation are forbidden", summary };
    }
  }
  return { allowed: true, summary };
}
