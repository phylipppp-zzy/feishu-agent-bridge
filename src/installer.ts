import { randomBytes } from "node:crypto";
import * as Lark from "@larksuiteoapi/node-sdk";

type ApplicationConfigData = NonNullable<Parameters<Lark.Client["application"]["v7"]["applicationConfig"]["patch"]>[0]>["data"];

export const FEISHU_SCOPES = [
  "im:message:send_as_bot",
  "im:message.group_at_msg:readonly",
  "im:message",
  "im:message.group_msg",
  "im:resource",
  "application:application:patch",
  // CardKit is used only for ephemeral per-turn streaming output.
  "cardkit:card:write",
  // Allows doctor to read this app's own online version/configuration.
  "application:application:self_manage",
] as const;

export const FEISHU_EVENTS = ["im.message.receive_v1", "application.bot.menu_v6"] as const;
export const FEISHU_CALLBACKS = ["card.action.trigger"] as const;

export const FEISHU_MENUS = [
  { name: "控制台", eventKey: "codex.home" },
  { name: "新建会话", eventKey: "codex.new" },
  { name: "最近会话", eventKey: "codex.sessions" },
  { name: "搜索会话", eventKey: "codex.search" },
  { name: "服务管理", eventKey: "codex.service" },
] as const;

export function feishuDevelopmentConfig(ownerOpenId: string): NonNullable<ApplicationConfigData> {
  return {
    scope: { add_scopes: FEISHU_SCOPES.map((scope_name) => ({ scope_name, token_type: "tenant" as const })) },
    event: { subscription_type: "websocket", add_events: [...FEISHU_EVENTS] },
    callback: { callback_type: "websocket", add_callbacks: [...FEISHU_CALLBACKS] },
    visibility: { is_visible_to_all: false, visible_list: { user_ids: [ownerOpenId] } },
  };
}

export interface RegisteredApp {
  appId: string;
  appSecret: string;
  ownerOpenId?: string;
}

export interface ProvisionedApp extends RegisteredApp {
  publishVersion?: string;
}

function ensureApiSuccess(operation: string, response: { code?: number | undefined; msg?: string | undefined }): void {
  if (response.code && response.code !== 0) throw new Error(`${operation} failed: ${response.msg ?? `code ${response.code}`}`);
}

/** App identity and wording that differ between the Codex and Claude bridges. */
export interface FeishuAppProfile {
  source: string;
  presetName: string;
  presetDesc: string;
  botDescription: string;
  releaseRemark: string;
  releaseChangelog: string;
}

export const CODEX_APP_PROFILE: FeishuAppProfile = {
  source: "feishu-codex-bridge",
  presetName: "Codex Bridge - {user}",
  presetDesc: "在飞书话题中同步和继续本机 Codex 会话",
  botDescription: "发送 / 打开 Codex 操作面板",
  releaseRemark: "Initial installation by feishu-codex-bridge",
  releaseChangelog: "Enable the Codex bridge bot, WebSocket events, cards and menus.",
};

export const CLAUDE_APP_PROFILE: FeishuAppProfile = {
  source: "feishu-claude-bridge",
  presetName: "Claude Bridge - {user}",
  presetDesc: "在飞书话题中查看本机 Claude Code 会话",
  botDescription: "发送 / 打开 Claude 操作面板",
  releaseRemark: "Initial installation by feishu-claude-bridge",
  releaseChangelog: "Enable the Claude bridge bot, WebSocket events and cards.",
};

export async function registerFeishuApp(
  onVerificationUrl: (url: string, expireIn: number) => void,
  existingAppId?: string,
  profile: FeishuAppProfile = CODEX_APP_PROFILE,
): Promise<RegisteredApp> {
  const registered = await Lark.registerApp({
    source: profile.source,
    ...(existingAppId ? { appId: existingAppId } : { createOnly: true }),
    appPreset: { name: profile.presetName, desc: profile.presetDesc },
    addons: {
      preset: false,
      scopes: { tenant: [...FEISHU_SCOPES] },
      events: { items: { tenant: [...FEISHU_EVENTS] } },
      callbacks: { items: [...FEISHU_CALLBACKS] },
    },
    onQRCodeReady: ({ url, expireIn }) => onVerificationUrl(url, expireIn),
  });
  return {
    appId: registered.client_id,
    appSecret: registered.client_secret,
    ...(registered.user_info?.open_id ? { ownerOpenId: registered.user_info.open_id } : {}),
  };
}

export async function configureFeishuApp(appId: string, appSecret: string, ownerOpenId: string, profile: FeishuAppProfile = CODEX_APP_PROFILE): Promise<{ publishVersion?: string }> {
  const client = new Lark.Client({
    appId,
    appSecret,
    appType: Lark.AppType.SelfBuild,
    domain: Lark.Domain.Feishu,
  });
  const config = await client.application.v7.applicationConfig.patch({
    path: { app_id: appId },
    params: { user_id_type: "open_id" },
    data: feishuDevelopmentConfig(ownerOpenId),
  });
  ensureApiSuccess("configure Feishu permissions and WebSocket subscriptions", config);

  const ability = await client.application.v7.applicationAbility.patch({
    path: { app_id: appId },
    data: {
      bot: {
        enable: true,
        i18ns: [{ i18n_key: "zh_cn", get_started_desc: profile.botDescription }],
      },
    },
  });
  ensureApiSuccess("configure Feishu bot capability", ability);

  const published = await client.application.v7.applicationPublish.create({
    path: { app_id: appId },
    data: {
      mobile_default_ability: "bot",
      pc_default_ability: "bot",
      remark: profile.releaseRemark,
      changelog: profile.releaseChangelog,
    },
  });
  ensureApiSuccess("submit Feishu application release", published);
  return published.data?.version ? { publishVersion: published.data.version } : {};
}

export async function provisionFeishuApp(onVerificationUrl: (url: string, expireIn: number) => void, profile: FeishuAppProfile = CODEX_APP_PROFILE): Promise<ProvisionedApp> {
  const registered = await registerFeishuApp(onVerificationUrl, undefined, profile);
  if (!registered.ownerOpenId) throw new Error("Feishu registration did not return the installing user's open_id");
  return { ...registered, ...await configureFeishuApp(registered.appId, registered.appSecret, registered.ownerOpenId, profile) };
}

function quoted(value: string): string {
  if (/\r|\n/.test(value)) throw new Error("Configuration values cannot contain newlines");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function systemdQuoted(value: string): string { return quoted(value.replaceAll("%", "%%")); }

/**
 * A path for settings such as WorkingDirectory= and EnvironmentFile=. systemd takes their whole
 * value literally (only Exec lines support quoting), so quotes would become part of the path.
 */
function systemdPath(value: string): string {
  if (!value.startsWith("/") || value !== value.trim() || /[\r\n"\\]/.test(value)) {
    throw new Error(`systemd path must be absolute and free of quotes, backslashes and line breaks: ${value}`);
  }
  return value.replaceAll("%", "%%");
}

export function generateBindToken(): string { return randomBytes(24).toString("base64url"); }

export function renderEnvironment(values: Record<string, string>): string {
  return `${Object.entries(values).map(([key, value]) => {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`Invalid environment key: ${key}`);
    return `${key}=${quoted(value)}`;
  }).join("\n")}\n`;
}

export function parseEnvironment(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 1) throw new Error(`Invalid environment line: ${line}`);
    const key = trimmed.slice(0, index);
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`Invalid environment key: ${key}`);
    const raw = trimmed.slice(index + 1).trim();
    if (raw.startsWith('"')) {
      if (!raw.endsWith('"') || raw.length < 2) throw new Error(`Unterminated quoted environment value: ${key}`);
      values[key] = raw.slice(1, -1).replace(/\\([\\"])/g, "$1");
    } else values[key] = raw;
  }
  return values;
}

export function renderSystemdUnit(input: { projectDir: string; nodeBin: string; environmentFile: string; description?: string; entry?: string }): string {
  return `[Unit]
Description=${input.description ?? "Feishu to Codex session bridge"}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${systemdPath(input.projectDir)}
Environment=NODE_ENV=production
EnvironmentFile=${systemdPath(input.environmentFile)}
ExecStart=${systemdQuoted(input.nodeBin)} ${systemdQuoted(`${input.projectDir}/${input.entry ?? "dist/src/index.js"}`)}
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
KillMode=mixed
UMask=0077
NoNewPrivileges=true
RestrictSUIDSGID=true
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=default.target
`;
}
