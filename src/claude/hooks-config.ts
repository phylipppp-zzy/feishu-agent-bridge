import { isAbsolute } from "node:path";

/**
 * Registration of scripts/claude-hook.mjs in a Claude Code settings.json. Pure functions shared by
 * the installer, the hook uninstaller and doctor.
 *
 * Format (https://code.claude.com/docs/en/hooks): `hooks.<Event>` is an array of matcher groups
 * `{ matcher?, hooks: [handler] }`. An omitted matcher matches every occurrence of the event, and
 * events without matcher support ignore it, so bridge groups omit it. A command handler is
 * `{ type: "command", command, timeout }`; without `args` the command runs through `sh -c`, and
 * `timeout` is in seconds.
 */

export const BRIDGE_HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "Stop", "StopFailure", "Notification", "SessionEnd"] as const;
export type BridgeHookEvent = (typeof BRIDGE_HOOK_EVENTS)[number];

/** Seconds. SessionEnd hooks share a 1.5 s budget that a longer per-hook timeout raises, up to 60 s. */
export const BRIDGE_HOOK_TIMEOUT_SECONDS = 10;

type Settings = Record<string, unknown>;

export interface BridgeHookCommandParts {
  nodeBin: string;
  hookScript: string;
  stateDir: string;
}

function isRecord(value: unknown): value is Settings {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** POSIX shell single quoting; inside '...' only the quote itself needs escaping. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function bridgeHookCommand(nodeBin: string, hookScript: string, stateDir: string): string {
  for (const [label, path] of [["node", nodeBin], ["hook 脚本", hookScript], ["STATE_DIR", stateDir]] as const) {
    // Hooks run in the session's cwd, so a relative path would point somewhere else in every project.
    if (!isAbsolute(path)) throw new Error(`${label} 路径必须是绝对路径：${path}`);
  }
  return `${shellQuote(nodeBin)} ${shellQuote(hookScript)} --state-dir ${shellQuote(stateDir)}`;
}

/** Recognizes entries written by this bridge, from any checkout or STATE_DIR. */
export function isBridgeHookCommand(command: unknown): boolean {
  return typeof command === "string" && command.includes("claude-hook.mjs") && command.includes("--state-dir");
}

/** Inverse of bridgeHookCommand; null for commands in any other shape (e.g. edited by hand). */
export function parseBridgeHookCommand(command: string): BridgeHookCommandParts | null {
  const word = String.raw`'((?:[^']|'\\'')*)'`;
  const match = new RegExp(`^${word} ${word} --state-dir ${word}$`).exec(command);
  if (!match) return null;
  const unquote = (value: string | undefined) => (value ?? "").replaceAll(`'\\''`, "'");
  return { nodeBin: unquote(match[1]), hookScript: unquote(match[2]), stateDir: unquote(match[3]) };
}

function handlersOf(group: unknown): unknown[] | null {
  return isRecord(group) && Array.isArray(group.hooks) ? group.hooks : null;
}

function isBridgeHandler(handler: unknown): boolean {
  return isRecord(handler) && isBridgeHookCommand(handler.command);
}

function hasBridgeHandler(group: unknown): boolean {
  return handlersOf(group)?.some(isBridgeHandler) ?? false;
}

function bridgeGroup(command: string): Settings {
  return { hooks: [{ type: "command", command, timeout: BRIDGE_HOOK_TIMEOUT_SECONDS }] };
}

/** Exactly the group mergeBridgeHooks writes, so an unchanged file is not rewritten. */
function isExactBridgeGroup(group: unknown, command: string): boolean {
  const handlers = handlersOf(group);
  if (!isRecord(group) || Object.keys(group).length !== 1 || handlers?.length !== 1) return false;
  const handler = handlers[0];
  return isRecord(handler) && Object.keys(handler).length === 3 && handler.type === "command" &&
    handler.command === command && handler.timeout === BRIDGE_HOOK_TIMEOUT_SECONDS;
}

/**
 * Drops bridge handlers (a group keeps its other handlers and disappears only when none remain) and
 * inserts `replacement` right after the group at `insertAt`, so a replaced entry keeps its position.
 */
function withoutBridgeHandlers(groups: unknown[], insertAt = -1, replacement?: Settings): unknown[] {
  const result: unknown[] = [];
  groups.forEach((group, index) => {
    const handlers = handlersOf(group);
    if (!handlers || !handlers.some(isBridgeHandler)) result.push(group);
    else {
      const remaining = handlers.filter((handler) => !isBridgeHandler(handler));
      if (remaining.length) result.push({ ...(group as Settings), hooks: remaining });
    }
    if (index === insertAt && replacement) result.push(replacement);
  });
  return result;
}

const HOOKS_NOT_OBJECT = "Claude Code 设置中的 hooks 不是 JSON 对象";
const eventNotArray = (event: string) => `Claude Code 设置中的 hooks.${event} 不是数组`;
const NOTHING_CHANGED = "。为避免覆盖你的配置，未做任何修改；请先手动修正 settings.json 后重试。";

/**
 * Ensures each bridge event has exactly one bridge group `{ hooks: [{ type, command, timeout }] }`.
 * An outdated bridge group (e.g. the repository moved) is replaced in place; every other hook and
 * setting is kept. Unexpected structures abort with an error instead of being overwritten.
 */
export function mergeBridgeHooks(settings: Settings, command: string): { settings: Settings; changed: boolean } {
  if (!isBridgeHookCommand(command)) throw new Error(`不是本桥接的 hook 命令：${command}`);
  const next = structuredClone(settings);
  if (next.hooks !== undefined && !isRecord(next.hooks)) throw new Error(HOOKS_NOT_OBJECT + NOTHING_CHANGED);
  const hooks: Settings = isRecord(next.hooks) ? next.hooks : {};
  for (const event of BRIDGE_HOOK_EVENTS) {
    if (hooks[event] !== undefined && !Array.isArray(hooks[event])) throw new Error(eventNotArray(event) + NOTHING_CHANGED);
  }
  let changed = false;
  for (const event of BRIDGE_HOOK_EVENTS) {
    const groups = (hooks[event] as unknown[] | undefined) ?? [];
    const bridgeGroups = groups.filter(hasBridgeHandler);
    if (bridgeGroups.length === 1 && isExactBridgeGroup(bridgeGroups[0], command)) continue;
    const first = groups.findIndex(hasBridgeHandler);
    const updated = withoutBridgeHandlers(groups, first, bridgeGroup(command));
    if (first < 0) updated.push(bridgeGroup(command));
    hooks[event] = updated;
    changed = true;
  }
  if (changed) next.hooks = hooks;
  return { settings: next, changed };
}

/**
 * Removes only bridge handlers, from every event; event arrays left empty are deleted. Malformed
 * parts cannot hold bridge entries written by mergeBridgeHooks, so they are left untouched.
 */
export function removeBridgeHooks(settings: Settings): { settings: Settings; changed: boolean } {
  const next = structuredClone(settings);
  const hooks = next.hooks;
  if (!isRecord(hooks)) return { settings: next, changed: false };
  let changed = false;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups) || !groups.some(hasBridgeHandler)) continue;
    const remaining = withoutBridgeHandlers(groups);
    if (remaining.length) hooks[event] = remaining;
    else delete hooks[event];
    changed = true;
  }
  return { settings: next, changed };
}

export interface BridgeHookEventStatus {
  event: BridgeHookEvent;
  /** Bridge commands registered for the event; normally exactly one. */
  commands: string[];
  installed: boolean;
  /** Exactly one bridge command, equal to the expected one; null when no command was given. */
  matchesExpected: boolean | null;
}

export interface BridgeHooksStatus {
  events: BridgeHookEventStatus[];
  /** Structures that prevent reading the hooks, in the same wording mergeBridgeHooks uses. */
  problems: string[];
  /** `"disableAllHooks": true` in this file stops every hook, including the bridge's. */
  disableAllHooks: boolean;
}

export function bridgeHooksStatus(settings: Settings, command?: string): BridgeHooksStatus {
  const problems: string[] = [];
  if (settings.hooks !== undefined && !isRecord(settings.hooks)) problems.push(HOOKS_NOT_OBJECT);
  const hooks = isRecord(settings.hooks) ? settings.hooks : {};
  const events = BRIDGE_HOOK_EVENTS.map((event): BridgeHookEventStatus => {
    const groups = hooks[event];
    if (groups !== undefined && !Array.isArray(groups)) problems.push(eventNotArray(event));
    const commands = (Array.isArray(groups) ? groups : []).flatMap((group) => (handlersOf(group) ?? [])
      .filter(isBridgeHandler).map((handler) => (handler as Settings).command as string));
    return {
      event,
      commands,
      installed: commands.length > 0,
      matchesExpected: command === undefined ? null : commands.length === 1 && commands[0] === command,
    };
  });
  return { events, problems, disableAllHooks: settings.disableAllHooks === true };
}
