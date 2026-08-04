import { randomBytes } from "node:crypto";
import * as Lark from "@larksuiteoapi/node-sdk";

type ApplicationConfigData = NonNullable<Parameters<Lark.Client["application"]["v7"]["applicationConfig"]["patch"]>[0]>["data"];

export const FEISHU_SCOPES = [
  "im:message:send_as_bot",
  "im:message.group_at_msg:readonly",
  "im:message",
  "im:message.group_msg",
  "im:resource",
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

export async function registerFeishuApp(
  onVerificationUrl: (url: string, expireIn: number) => void,
  existingAppId?: string,
): Promise<RegisteredApp> {
  const registered = await Lark.registerApp({
    source: "feishu-codex-bridge",
    ...(existingAppId ? { appId: existingAppId } : { createOnly: true }),
    appPreset: { name: "Codex Bridge - {user}", desc: "在飞书话题中同步和继续本机 Codex 会话" },
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

export async function configureFeishuApp(appId: string, appSecret: string, ownerOpenId: string): Promise<{ publishVersion?: string }> {
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
        i18ns: [{ i18n_key: "zh_cn", get_started_desc: "发送 / 打开 Codex 操作面板" }],
        bot_menu_enable: true,
        bot_menu_display_strategy: 3,
        bot_menus: FEISHU_MENUS.map((menu, index) => ({
          menu_id: `codex_menu_${index + 1}`,
          sort: index + 1,
          default_name: menu.name,
          event_key: menu.eventKey,
          menu_content_type: 2,
        })),
      },
    },
  });
  ensureApiSuccess("configure Feishu bot capability", ability);

  const published = await client.application.v7.applicationPublish.create({
    path: { app_id: appId },
    data: {
      mobile_default_ability: "bot",
      pc_default_ability: "bot",
      remark: "Initial installation by feishu-codex-bridge",
      changelog: "Enable the Codex bridge bot, WebSocket events, cards and menus.",
    },
  });
  ensureApiSuccess("submit Feishu application release", published);
  return published.data?.version ? { publishVersion: published.data.version } : {};
}

export async function provisionFeishuApp(onVerificationUrl: (url: string, expireIn: number) => void): Promise<ProvisionedApp> {
  const registered = await registerFeishuApp(onVerificationUrl);
  if (!registered.ownerOpenId) throw new Error("Feishu registration did not return the installing user's open_id");
  return { ...registered, ...await configureFeishuApp(registered.appId, registered.appSecret, registered.ownerOpenId) };
}

function quoted(value: string): string {
  if (/\r|\n/.test(value)) throw new Error("Configuration values cannot contain newlines");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function systemdQuoted(value: string): string { return quoted(value.replaceAll("%", "%%")); }

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

export function renderSystemdUnit(input: { projectDir: string; nodeBin: string; environmentFile: string }): string {
  return `[Unit]
Description=Feishu to Codex session bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${systemdQuoted(input.projectDir)}
Environment=NODE_ENV=production
EnvironmentFile=${systemdQuoted(input.environmentFile)}
ExecStart=${systemdQuoted(input.nodeBin)} ${systemdQuoted(`${input.projectDir}/dist/src/index.js`)}
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
