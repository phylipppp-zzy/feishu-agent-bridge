import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import type { BridgeConfig, RemoteRequestType } from "./types.js";

export interface RootPreflightResult { ok: boolean; reasons: string[]; }
const SOCKETS = ["/var/run/docker.sock", "/run/docker.sock", "/var/run/podman/podman.sock", "/run/podman/podman.sock", "/run/containerd/containerd.sock"];
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

const DANGEROUS = /(?:\bsudo\b|\bsu\b|\bdoas\b|setcap|capsh|unshare|nsenter|mount\s|docker|podman|containerd|\/var\/run\/|curl\s+.*(?:token|secret)|(?:api[_-]?key|password|secret|credential)\s*[=:])/i;
export function remoteApprovalAllowed(type: RemoteRequestType, params: Record<string, unknown>, allowedMcpServers: readonly string[]): { allowed: boolean; reason?: string } {
  if (type === "user_input" && /(secret|password|token|credential|api[_-]?key)/i.test(JSON.stringify(params))) return { allowed: false, reason: "secret input is forbidden in Feishu" };
  if (type === "mcp_elicitation") { const name = typeof params.serverName === "string" ? params.serverName : typeof params.server_name === "string" ? params.server_name : ""; if (!name || !allowedMcpServers.includes(name)) return { allowed: false, reason: "MCP server is not on the allowlist" }; }
  if ((type === "command_approval" || type === "file_approval" || type === "permissions") && DANGEROUS.test(JSON.stringify(params))) return { allowed: false, reason: "privilege escalation, runtime socket access, or sensitive-data handling is forbidden" };
  return { allowed: true };
}
