import { basename, isAbsolute } from "node:path";

type JsonObject = Record<string, unknown>;

export const PERMISSION_HOOK_TIMEOUT_SECONDS = 610;
export const PERMISSION_HOOK_SCRIPT_NAME = "claude-permission-hook.mjs";

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validatedGroups(settings: JsonObject, event: string): { hooks: JsonObject; groups: unknown[] } {
  if (settings.hooks !== undefined && !isObject(settings.hooks)) throw new Error("settings.hooks must be an object; refusing to overwrite it");
  const hooks: JsonObject = isObject(settings.hooks) ? settings.hooks : {};
  const value = hooks[event];
  if (value !== undefined && !Array.isArray(value)) throw new Error(`settings.hooks.${event} must be an array; refusing to overwrite it`);
  const groups = (value as unknown[] | undefined) ?? [];
  for (const group of groups) {
    if (!isObject(group) || !Array.isArray(group.hooks)) throw new Error(`settings.hooks.${event} contains an invalid hook group; refusing to overwrite it`);
    if (group.matcher !== undefined && typeof group.matcher !== "string") throw new Error(`settings.hooks.${event} contains an invalid matcher; refusing to overwrite it`);
  }
  return { hooks, groups };
}

function isOurPermissionHook(handler: unknown, hookScript: string): boolean {
  if (!isObject(handler) || handler.type !== "command" || !Array.isArray(handler.args)) return false;
  return handler.args[0] === hookScript && handler.args.includes("--socket");
}

function exactHook(handler: unknown, command: string, args: string[]): boolean {
  if (!isObject(handler)) return false;
  return handler.type === "command" && handler.command === command && JSON.stringify(handler.args) === JSON.stringify(args) &&
    handler.timeout === PERMISSION_HOOK_TIMEOUT_SECONDS;
}

function commandGroup(command: string, args: string[]): JsonObject {
  return { hooks: [{ type: "command", command, args, timeout: PERMISSION_HOOK_TIMEOUT_SECONDS }] };
}

/** Add or update only the bridge's PermissionRequest hook; every unrelated hook is retained. */
export function installRemotePermissionHook(
  settings: JsonObject,
  options: { nodeBin: string; hookScript: string; socketPath: string },
): { settings: JsonObject; changed: boolean; diff: string } {
  for (const [name, value] of Object.entries(options)) {
    if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path: ${value}`);
  }
  if (basename(options.hookScript) !== PERMISSION_HOOK_SCRIPT_NAME) throw new Error(`hookScript must name ${PERMISSION_HOOK_SCRIPT_NAME}`);
  const { hooks, groups } = validatedGroups(settings, "PermissionRequest");
  const args = [options.hookScript, "--socket", options.socketPath];
  const bridgeGroups = groups.filter((group) => {
    const handlers = (group as JsonObject).hooks as unknown[];
    return handlers.some((handler: unknown) => isOurPermissionHook(handler, options.hookScript));
  });
  if (bridgeGroups.length === 1) {
    const group = bridgeGroups[0] as JsonObject;
    const handlers = group.hooks as unknown[];
    if (group.matcher === undefined && handlers.length === 1 && exactHook(handlers[0], options.nodeBin, args)) {
      return { settings: structuredClone(settings), changed: false, diff: "(no changes)" };
    }
  }
  const next = structuredClone(settings);
  const nextHooks: JsonObject = isObject(next.hooks) ? next.hooks : {};
  const nextGroups = groups.map((group) => {
    const record = group as JsonObject;
    const handlers = record.hooks as unknown[];
    const remaining = handlers.filter((handler) => !isOurPermissionHook(handler, options.hookScript));
    return remaining.length === handlers.length ? record : { ...record, hooks: remaining };
  }).filter((group) => (group as JsonObject).hooks instanceof Array && ((group as JsonObject).hooks as unknown[]).length > 0);
  nextGroups.push(commandGroup(options.nodeBin, args));
  nextHooks.PermissionRequest = nextGroups;
  next.hooks = nextHooks;
  return {
    settings: next,
    changed: true,
    diff: [
      "--- settings.json (planned; not written)",
      "+++ settings.json",
      `+ hooks.PermissionRequest += ${JSON.stringify(commandGroup(options.nodeBin, args), null, 2).replaceAll("\n", "\n+ ")}`,
      "  unrelated hook groups and settings are preserved",
    ].join("\n"),
  };
}

/** Remove only groups containing this bridge's permission hook, retaining other handlers. */
export function removeRemotePermissionHook(settings: JsonObject, hookScript: string): { settings: JsonObject; changed: boolean; diff: string } {
  if (!isAbsolute(hookScript) || basename(hookScript) !== PERMISSION_HOOK_SCRIPT_NAME) throw new Error(`hookScript must be an absolute path to ${PERMISSION_HOOK_SCRIPT_NAME}`);
  const { groups } = validatedGroups(settings, "PermissionRequest");
  let changed = false;
  const next = structuredClone(settings);
  if (!isObject(next.hooks)) return { settings: next, changed: false, diff: "(no changes)" };
  const remainingGroups = groups.map((group) => {
    const record = group as JsonObject;
    const handlers = record.hooks as unknown[];
    const remaining = handlers.filter((handler) => !isOurPermissionHook(handler, hookScript));
    if (remaining.length !== handlers.length) changed = true;
    return remaining.length === handlers.length ? record : { ...record, hooks: remaining };
  }).filter((group) => ((group as JsonObject).hooks as unknown[]).length > 0);
  if (!changed) return { settings: next, changed: false, diff: "(no changes)" };
  if (remainingGroups.length) next.hooks.PermissionRequest = remainingGroups;
  else delete next.hooks.PermissionRequest;
  if (Object.keys(next.hooks).length === 0) delete next.hooks;
  return { settings: next, changed: true, diff: "--- settings.json (planned; not written)\n+++ settings.json\n- bridge PermissionRequest handler removed\n  unrelated hook groups and settings are preserved" };
}

/** Fixture is based on the installed SDK's StopHookInput declaration; it does not simulate CLI behavior. */
export function stopHookSchemaFixture(): JsonObject {
  return {
    hook_event_name: "Stop",
    session_id: "fixture-session-0001",
    transcript_path: "/tmp/claude-hook-fixture/transcript.jsonl",
    cwd: "/tmp/claude-hook-fixture",
    stop_hook_active: false,
    last_assistant_message: "fixture assistant response",
    background_tasks: [],
    session_crons: [],
  };
}

/** Candidate only: the hook command and asyncRewake semantics still require a real local experiment. */
export function stopAsyncRewakeSchemaFixture(): JsonObject {
  return { type: "command", command: "/absolute/test/hook", async: true, asyncRewake: true };
}
