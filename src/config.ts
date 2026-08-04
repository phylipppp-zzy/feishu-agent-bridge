import { homedir } from "node:os";
import { resolve } from "node:path";
import type { BridgeConfig } from "./types.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function cardUiVersion(): 1 | 2 {
  const value = process.env.FEISHU_CARD_UI_VERSION ?? "1";
  if (value === "1" || value === "2") return Number(value) as 1 | 2;
  throw new Error("FEISHU_CARD_UI_VERSION must be 1 or 2");
}

export function loadConfig(): BridgeConfig {
  const home = homedir();
  return {
    appId: required("FEISHU_APP_ID"),
    appSecret: required("FEISHU_APP_SECRET"),
    bindToken: required("FEISHU_BIND_TOKEN"),
    allowedRoot: resolve(process.env.ALLOWED_ROOT ?? home),
    codexHome: resolve(process.env.CODEX_HOME ?? `${home}/.codex`),
    codexBin: process.env.CODEX_BIN ?? "codex",
    stateDir: resolve(process.env.STATE_DIR ?? `${home}/.local/state/feishu-codex-bridge`),
    scanIntervalMs: positiveInteger("SCAN_INTERVAL_MS", 10_000),
    activeSessionQuietMs: positiveInteger("ACTIVE_SESSION_QUIET_MS", 5_000),
    cardUiVersion: cardUiVersion(),
  };
}
