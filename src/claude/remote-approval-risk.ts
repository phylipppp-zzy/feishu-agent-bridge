import { createHash } from "node:crypto";
import { networkCommandLabel, unwrapShellCommand } from "../execution-policy.js";

export type RemoteApprovalRiskLevel = "low" | "high" | "unknown";

export interface RemoteApprovalRisk {
  riskLevel: RemoteApprovalRiskLevel;
  reasons: string[];
  needsSecondConfirmation: boolean;
  /** Binds a second confirmation to the exact input; parameter changes must create a new approval. */
  inputDigest: string;
}

const SECRET_MARKER = /(?:\.ssh|id_rsa|known_hosts|\.aws|\.azure|\.config\/gcloud|kubeconfig|shadow|passwd|credential|secret|token|api[_-]?key|password|cookie|authorization|private[_-]?key)/i;
const SECRET_VALUE = /(?:authorization|cookie|token|password|secret|api[_-]?key|credential)\s*[:=]\s*[^\s,"'}]+/i;
const PRIVILEGE_OR_RUNTIME = /(?:^|[\s;&|])(sudo|su|doas|setcap|capsh|unshare|nsenter|mount|umount|docker|podman|containerd|crictl)(?:$|[\s;&|])/i;
const SERVICE_CHANGE = /\b(?:systemctl|service|supervisorctl|launchctl|pm2)\b.{0,100}\b(?:restart|reload|stop|start|enable|disable)\b|\b(?:restart|reload|stop|start|enable|disable)\b.{0,80}\b(?:service|daemon|systemd)\b/i;
const GIT_PUSH = /(?:^|[\s;&|(])git\s+(?:-\S+\s+)*(?:-C\s+\S+\s+)*(?:push)\b/i;
const FORCE_PUSH = /\bgit\s+(?:-\S+\s+)*(?:-C\s+\S+\s+)*push\b[^;&|]*\s(?:--force(?:-with-lease)?|-[fF])(?:\s|$)/i;
const COSTLY = /\b(?:terraform\s+apply|pulumi\s+up|tofu\s+apply|aws\s+(?:ec2\s+run-instances|sagemaker\s+create)|gcloud\s+compute\s+instances\s+create|az\s+vm\s+create|runpod|vastai|modal\s+deploy)\b|--max-budget-usd\b|\b(?:billing|paid instance|计费实例|启动实例|付费作业)\b/i;
const DESTRUCTIVE = /(?:^|[\s;&|(])(?:rm|rmdir|shred|dd|mkfs(?:\.\w+)?|wipefs|git\s+reset\s+--hard|git\s+clean\s+-[a-z]*f|truncate)(?:$|[\s;&|])/i;
const FEISHU_OUTBOUND = /(?:feishu|飞书|lark|im\.message|send(?:text|card|message)|reply(?:text|card|message)).{0,100}(?:send|post|message|test|测试)|(?:send|post|message|test|测试).{0,100}(?:feishu|飞书|lark|im\.message)/i;
const SHELL_META = /[;&|<>`$\n\r]/;

function digest(toolName: string, input: unknown): string {
  return createHash("sha256").update(JSON.stringify([toolName, input])).digest("hex");
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function inputStrings(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 8) return out;
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) inputStrings(item, out, depth + 1);
  else {
    const record = object(value);
    if (record) for (const [key, child] of Object.entries(record)) { out.push(key); inputStrings(child, out, depth + 1); }
  }
  return out;
}

function commandInput(toolInput: unknown): string | null {
  const record = object(toolInput);
  if (typeof record?.command === "string") return record.command;
  if (Array.isArray(record?.command) && record.command.every((part) => typeof part === "string")) return (record.command as string[]).join(" ");
  return null;
}

function result(toolName: string, input: unknown, riskLevel: RemoteApprovalRiskLevel, reasons: string[]): RemoteApprovalRisk {
  return { riskLevel, reasons, needsSecondConfirmation: riskLevel !== "low", inputDigest: digest(toolName, input) };
}

/**
 * Heuristic classification for an additional confirmation step. This is not an authorization
 * policy or a complete shell parser: unknown commands remain unknown and should require review.
 */
export function classifyRemoteApprovalRisk(toolName: string, toolInput: unknown): RemoteApprovalRisk {
  const allStrings = inputStrings(toolInput);
  const encoded = JSON.stringify(toolInput);
  if (SECRET_MARKER.test(allStrings.join("\n")) || SECRET_VALUE.test(encoded)) {
    return result(toolName, toolInput, "high", ["可能涉及密钥、认证信息或敏感文件"]);
  }

  if (/^(?:WebFetch|WebSearch|Fetch|Network)$/i.test(toolName)) {
    return result(toolName, toolInput, "high", ["工具会访问外部网络"]);
  }
  if (toolName === "Bash" || toolName === "Shell") {
    const raw = commandInput(toolInput);
    if (!raw) return result(toolName, toolInput, "unknown", ["无法从shell工具输入中识别明确命令"]);
    const command = unwrapShellCommand(raw);
    const normalized = command.replace(/\\\n/g, "").replace(/["'\\]/g, "");
    if (FORCE_PUSH.test(normalized)) return result(toolName, toolInput, "high", ["git force push可能改写远端历史"]);
    if (GIT_PUSH.test(normalized)) return result(toolName, toolInput, "high", ["git push会向远端仓库发送内容"]);
    if (SERVICE_CHANGE.test(normalized)) return result(toolName, toolInput, "high", ["操作会启停或重启服务"]);
    if (FEISHU_OUTBOUND.test(normalized)) return result(toolName, toolInput, "high", ["命令可能向飞书发送外部消息"]);
    if (COSTLY.test(normalized)) return result(toolName, toolInput, "high", ["操作可能启动计费资源或产生费用"]);
    if (PRIVILEGE_OR_RUNTIME.test(normalized)) return result(toolName, toolInput, "high", ["命令涉及提权或容器运行环境"]);
    if (DESTRUCTIVE.test(normalized)) return result(toolName, toolInput, "high", ["命令可能删除或破坏数据"]);
    const network = networkCommandLabel(normalized);
    if (network || /(?:^|[\s;&|(])(?:curl|wget|http|ftp|nc|netcat|scp|rsync|ssh)(?:[\s;&|)]|$)/i.test(normalized)) {
      return result(toolName, toolInput, "high", [network ?? "命令会访问网络或传输数据"]);
    }
    if (SHELL_META.test(command)) return result(toolName, toolInput, "unknown", ["shell包含组合、重定向或求值语法，静态分类不可靠"]);
    const simple = /^\s*(?:pwd|git\s+(?:status|diff|log|show))(?:\s|$)/.test(normalized)
      || (/^\s*(?:ls|stat|file|wc|head|tail|cat|rg|grep|find)\b/.test(normalized)
        && !/(?:^|\s)(?:\/|~\/|\.\.?(?:\/|\s|$))/.test(normalized));
    if (simple) return result(toolName, toolInput, "low", ["命令属于已识别的本地只读检查"]);
    return result(toolName, toolInput, "unknown", ["shell命令不在有限的只读识别范围内"]);
  }

  if (["Read", "Glob", "Grep", "Search"].includes(toolName)) {
    const paths = allStrings.join("\n");
    if (SECRET_MARKER.test(paths)) return result(toolName, toolInput, "high", ["读取目标可能包含密钥或敏感文件"]);
    const record = object(toolInput);
    const target = [record?.file_path, record?.path, record?.notebook_path, record?.pattern].find((value) => typeof value === "string");
    if (typeof target !== "string" || target.startsWith("/") || /(?:^|\/)\.\.(?:\/|$)/.test(target)) {
      return result(toolName, toolInput, "unknown", ["无法根据工具输入确认读取目标处于授权工作区"]);
    }
    return result(toolName, toolInput, "low", ["工具属于本地只读查看"]);
  }

  if (COSTLY.test(encoded)) return result(toolName, toolInput, "high", ["请求可能启动计费资源或产生费用"]);
  return result(toolName, toolInput, "unknown", [`未为 ${toolName || "未知工具"} 定义明确的低风险规则`]);
}
