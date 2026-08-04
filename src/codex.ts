import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CodexRunRequest, CodexRunResult, ModelCapability } from "./types.js";

const execFileAsync = promisify(execFile);

export function codexArgs(request: CodexRunRequest): string[] {
  const args = ["-a", "never", "-s", "workspace-write"];
  if (request.model) args.push("-m", request.model);
  if (request.reasoningEffort) args.push("-c", `model_reasoning_effort="${request.reasoningEffort}"`);
  args.push("exec");
  if (request.sessionId) args.push("resume", "--skip-git-repo-check", "--json", request.sessionId);
  else args.push("--skip-git-repo-check", "--json", "-C", request.cwd);
  for (const image of request.imagePaths ?? []) args.push("-i", image);
  args.push("-");
  return args;
}

export function parseModelCatalog(raw: string): ModelCapability[] {
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; } catch { throw new Error("Codex model catalog is not valid JSON"); }
  const models = value && typeof value === "object" && Array.isArray((value as { models?: unknown }).models)
    ? (value as { models: unknown[] }).models : [];
  return models.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const model = entry as Record<string, unknown>;
    const slug = typeof model.slug === "string" ? model.slug : "";
    if (!slug || model.visibility !== "list") return [];
    const efforts = Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels.flatMap((item) =>
      item && typeof item === "object" && typeof (item as { effort?: unknown }).effort === "string"
        ? [(item as { effort: string }).effort] : []) : [];
    const defaultReasoningEffort = typeof model.default_reasoning_level === "string" ? model.default_reasoning_level : efforts[0];
    if (!defaultReasoningEffort || !efforts.includes(defaultReasoningEffort)) return [];
    return [{
      slug,
      displayName: typeof model.display_name === "string" ? model.display_name : slug,
      description: typeof model.description === "string" ? model.description : "",
      defaultReasoningEffort,
      supportedReasoningEfforts: efforts,
    }];
  });
}

function assistantText(event: Record<string, unknown>): string | null {
  if (event.type === "item.completed") {
    const item = event.item as Record<string, unknown> | undefined;
    if (item?.type === "agent_message" && typeof item.text === "string") return item.text;
  }
  if (event.type === "event_msg") {
    const payload = event.payload as Record<string, unknown> | undefined;
    if (payload?.type === "agent_message" && typeof payload.message === "string") return payload.message;
  }
  return null;
}

function sessionIdFrom(event: Record<string, unknown>): string | null {
  if (event.type === "thread.started" && typeof event.thread_id === "string") return event.thread_id;
  if (event.type === "session_meta") {
    const payload = event.payload as Record<string, unknown> | undefined;
    const id = payload?.session_id ?? payload?.id;
    if (typeof id === "string") return id;
  }
  return null;
}

export class CodexRunner {
  constructor(private readonly bin: string, private readonly codexHome: string) {}

  async version(): Promise<string> {
    const { stdout } = await execFileAsync(this.bin, ["--version"], { env: { ...process.env, CODEX_HOME: this.codexHome } });
    return stdout.trim();
  }

  async listModels(): Promise<ModelCapability[]> {
    const { stdout } = await execFileAsync(this.bin, ["debug", "models"], {
      env: { ...process.env, CODEX_HOME: this.codexHome }, maxBuffer: 1_000_000,
    });
    return parseModelCatalog(stdout);
  }

  run(request: CodexRunRequest): Promise<CodexRunResult> {
    const args = codexArgs(request);

    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, args, {
        cwd: request.cwd,
        env: { ...process.env, CODEX_HOME: this.codexHome },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdoutCarry = "";
      let stderr = "";
      let sessionId = request.sessionId ?? "";
      const assistantMessages: string[] = [];

      const consumeLine = (line: string) => {
        if (!line.trim()) return;
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          sessionId ||= sessionIdFrom(event) ?? "";
          const text = assistantText(event);
          if (text) assistantMessages.push(text);
        } catch { /* stderr and exit status carry the actionable failure */ }
      };

      let killTimer: NodeJS.Timeout | null = null;
      const abort = () => {
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 10_000);
        killTimer.unref();
      };
      request.signal?.addEventListener("abort", abort, { once: true });
      child.stdin.end(request.prompt);
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (data: string) => { stderr += data; });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (data: string) => {
        stdoutCarry += data;
        const lines = stdoutCarry.split("\n");
        stdoutCarry = lines.pop() ?? "";
        for (const line of lines) consumeLine(line);
      });
      child.on("error", reject);
      child.on("close", (code) => {
        request.signal?.removeEventListener("abort", abort);
        if (killTimer) clearTimeout(killTimer);
        consumeLine(stdoutCarry);
        if (!sessionId && code === 0) return reject(new Error("Codex completed without a session id"));
        resolve({ sessionId, exitCode: code ?? 1, assistantMessages, stderr });
      });
    });
  }
}
