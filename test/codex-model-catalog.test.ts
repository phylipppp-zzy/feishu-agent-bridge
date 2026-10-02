import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CodexCliProbe } from "../src/codex.js";
import { BridgeDatabase } from "../src/db.js";
import { SyncService } from "../src/sync.js";
import type { BridgeConfig, ModelCapability } from "../src/types.js";
import { cardAction, FakeFeishu, title, waitFor } from "./codex-harness.js";

const model = (slug: string, efforts = ["low", "medium", "high"]): ModelCapability =>
  ({ slug, displayName: slug.toUpperCase(), description: slug, defaultReasoningEffort: efforts[0]!, supportedReasoningEfforts: efforts });

class FakeProbe {
  calls = 0;
  version = "codex-cli 0.154.0";
  next: () => Promise<ModelCapability[]> = async () => [model("gpt-5.6-sol")];
  async listModels(): Promise<ModelCapability[]> { this.calls += 1; return this.next(); }
  async sandboxSmokeTest(): Promise<boolean> { return true; }
  async versionText(): Promise<string> { return this.version; }
}

async function setup(home: string) {
  const config: BridgeConfig = { appId: "app", appSecret: "secret", allowedRoot: home, codexHome: join(home, ".codex"), codexBin: "/bin/false",
    stateDir: join(home, "state"), bindToken: "token", scanIntervalMs: 60_000, activeSessionQuietMs: 1 };
  const db = new BridgeDatabase(config.stateDir);
  db.setSetting("feishu.chat_id", "chat-1"); db.setSetting("feishu.open_id", "user-1");
  const probe = new FakeProbe();
  const codex = { listModels: () => probe.listModels(), version: () => probe.versionText(), sandboxSmokeTest: () => probe.sandboxSmokeTest() } as unknown as CodexCliProbe;
  const feishu = new FakeFeishu();
  const service = new SyncService(config, db, feishu, codex);
  const internals = service as unknown as { refreshModels(): Promise<boolean>; models: ModelCapability[] };
  return { db, feishu, service, probe, internals };
}

async function withHome(work: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "codex-models-"));
  try { await work(home); } finally { await rm(home, { recursive: true, force: true }); }
}

const meta = (db: BridgeDatabase) => JSON.parse(db.getSetting("codex.model_catalog.meta.v1") ?? "{}") as { refreshedAtMs?: number; attemptedAtMs?: number; codexVersion?: string; lastError?: string | null };

test("F02: a failed or empty refresh keeps the last good catalog and says it is stale; concurrent refreshes share one read", () => withHome(async (home) => {
  const env = await setup(home);
  assert.equal(await env.internals.refreshModels(), true);
  assert.deepEqual(env.internals.models.map((item) => item.slug), ["gpt-5.6-sol"]);
  assert.equal(meta(env.db).codexVersion, "codex-cli 0.154.0");

  env.probe.next = async () => [];
  assert.equal(await env.internals.refreshModels(), false);
  env.probe.next = async () => { throw new Error("debug models timed out"); };
  assert.equal(await env.internals.refreshModels(), false);
  assert.deepEqual(env.internals.models.map((item) => item.slug), ["gpt-5.6-sol"]);
  assert.deepEqual(JSON.parse(env.db.getSetting("codex.model_catalog.v1")!).map((item: ModelCapability) => item.slug), ["gpt-5.6-sol"]);
  assert.match(meta(env.db).lastError ?? "", /timed out/);

  let release!: (models: ModelCapability[]) => void;
  env.probe.next = () => new Promise((resolve) => { release = resolve; });
  const calls = env.probe.calls;
  const first = env.internals.refreshModels(); const second = env.internals.refreshModels();
  await waitFor(() => env.probe.calls === calls + 1);
  release([model("gpt-5.6-sol"), model("gpt-6.1-sol", ["low", "medium", "high", "xhigh"])]);
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(env.probe.calls, calls + 1);
  assert.equal(meta(env.db).lastError, null);
  // Efforts come from the catalog, per model.
  assert.deepEqual(env.internals.models.find((item) => item.slug === "gpt-6.1-sol")?.supportedReasoningEfforts, ["low", "medium", "high", "xhigh"]);
  env.db.close();
}));

test("F02: an old catalog is refreshed when the model menu opens, and cards for models that disappeared are refused", () => withHome(async (home) => {
  const env = await setup(home);
  await env.internals.refreshModels();
  // Thirty-one minutes later the newer Codex lists Sol 6.1.
  env.db.setSetting("codex.model_catalog.meta.v1", JSON.stringify({ ...meta(env.db), refreshedAtMs: Date.now() - 31 * 60_000, attemptedAtMs: Date.now() - 31 * 60_000 }));
  env.probe.version = "codex-cli 0.159.2";
  env.probe.next = async () => [model("gpt-6.1-sol")];
  const menu = await env.service.onCardAction(cardAction("new"));
  const projects = JSON.stringify(menu);
  assert.ok(projects.length > 0);
  env.db.setSetting("wizard.new.user-1", JSON.stringify({ id: "w1", mode: "new", chatId: "chat-1", cwd: home, expiresAt: Date.now() + 60_000 }));
  const card = await env.service.onCardAction(cardAction("show_models", { wizardId: "w1", wizardMode: "new" }, "c2"));
  assert.match(JSON.stringify(card), /模型目录读取自本机 Codex/);
  await waitFor(() => meta(env.db).codexVersion === "codex-cli 0.159.2");
  assert.deepEqual(env.internals.models.map((item) => item.slug), ["gpt-6.1-sol"]);
  const stale = await env.service.onCardAction(cardAction("select_model", { wizardId: "w1", wizardMode: "new", model: "gpt-5.6-sol" }, "c3"));
  assert.match(JSON.stringify(stale), /该模型已不可用/);
  const fresh = await env.service.onCardAction(cardAction("select_model", { wizardId: "w1", wizardMode: "new", model: "gpt-6.1-sol" }, "c4"));
  assert.doesNotMatch(JSON.stringify(fresh), /不可用/);
  assert.notEqual(title((fresh as { card?: Record<string, unknown> }).card), "操作失败");
  env.db.close();
}));

test("F02: a malformed cached catalog is ignored instead of breaking the menu", () => withHome(async (home) => {
  const env = await setup(home);
  env.db.setSetting("codex.model_catalog.v1", "{not json");
  env.db.setSetting("codex.model_catalog.meta.v1", "[]");
  env.probe.next = async () => { throw new Error("codex not found"); };
  assert.equal(await env.internals.refreshModels(), false);
  assert.deepEqual(env.internals.models, []);
  env.db.close();
}));
