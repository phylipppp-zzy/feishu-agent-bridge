import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ModelCapability } from "./types.js";

const execFileAsync = promisify(execFile);

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
    return [{ slug, displayName: typeof model.display_name === "string" ? model.display_name : slug,
      description: typeof model.description === "string" ? model.description : "", defaultReasoningEffort,
      supportedReasoningEfforts: efforts }];
  });
}

/** Read-only CLI diagnostics. All task execution goes through CodexAppServer. */
export class CodexCliProbe {
  constructor(private readonly bin: string, private readonly codexHome: string) {}

  async version(timeoutMs = 15_000): Promise<string> {
    const { stdout } = await execFileAsync(this.bin, ["--version"], { env: { ...process.env, CODEX_HOME: this.codexHome }, timeout: timeoutMs });
    return stdout.trim();
  }

  async sandboxSmokeTest(): Promise<boolean> {
    try {
      await execFileAsync(this.bin, ["sandbox", "--", "/usr/bin/true"], { env: { ...process.env, CODEX_HOME: this.codexHome } });
      return true;
    } catch { return false; }
  }

  async listModels(timeoutMs = 30_000): Promise<ModelCapability[]> {
    const { stdout } = await execFileAsync(this.bin, ["debug", "models"], {
      env: { ...process.env, CODEX_HOME: this.codexHome }, maxBuffer: 1_000_000, timeout: timeoutMs,
    });
    return parseModelCatalog(stdout);
  }
}
