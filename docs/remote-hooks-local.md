# Remote permission hook: local preparation only

This change prepares a reversible user-run settings helper. It does not install a hook, start the bridge, invoke Claude Code, or approve any real permission request.

## Local evidence

- The installed `@anthropic-ai/claude-agent-sdk` 0.3.287 `sdk.d.ts` declares command hook options `async` and `asyncRewake` near line 7012. Its `StopHookInput` near line 9534 contains `hook_event_name`, session metadata, `stop_hook_active`, optional assistant text, `background_tasks`, and `session_crons`. `StopHookSpecificOutput` only declares `hookEventName: "Stop"` and optional `additionalContext` near line 9556.
- The same SDK declares `PermissionRequestHookInput` with `tool_name`, `tool_input`, optional permission suggestions, optional MCP provenance, and base metadata including optional `agent_id`/`agent_type`; it has no declared explicit user-vs-model origin field. `agent_id` can mark a subagent call, but absence does not prove a direct user request. This is a schema observation, not evidence that an installed Claude CLI cannot supply extra fields.
- `scripts/claude-hook.mjs` records `Stop` as `idle` and always exits successfully. It does not implement a remote-work pickup, return a Stop decision, or use `asyncRewake`.
- `src/claude/hooks-config.ts` currently registers the local presence hooks as shell command strings. This helper uses the SDK's `args` array for the separate permission client so paths and socket names do not pass through a shell.

The declarations establish local SDK types only. They do not establish the installed CLI's support/version, event delivery behavior, whether exit code 2 wakes a stopped model, or that a non-user-originated permission request is safe to authorize.

## PermissionRequest setup helper

`scripts/prepare-claude-remote-hooks.mjs` imports the local plan and settings-file helpers through the already installed `tsx` package. It never chooses a default `~/.claude/settings.json`; the operator must supply a target path. The default hook target is `scripts/claude-permission-hook.mjs` from this checkout, which is prepared by the parallel E implementation. Its CLI contract is `--socket <absolute Unix socket path> [--timeout-ms <milliseconds>]`; the integrated server socket is planned as `<stateDir>/permission-hook/claude-permission-hook.sock`. The client waits up to 600,000 ms and the hook timeout is 610 seconds, leaving time for the client to return a deny result after its wait expires.

Preview a disposable fixture:

```sh
node scripts/prepare-claude-remote-hooks.mjs \
  --settings /tmp/claude-hooks-test/settings.json \
  --socket /tmp/claude-hooks-test/permission-hook/claude-permission-hook.sock
```

To apply to that explicitly chosen file, append `--apply`. The helper writes a timestamped backup and uses the existing atomic settings writer. It adds one `PermissionRequest` command group, keeps unrelated groups/settings, rejects malformed target structures, and uses `command` + `args` so path characters are not evaluated by a shell. `--remove` previews removal; `--remove --apply` removes only this permission client entry and retains other handlers. The helper checks the E script is readable before applying an install. Permission approval is disabled by default; the user should deploy and enable the socket service first, then run the settings helper themselves. This preparation task has not enabled the service, started or restarted the bridge, or edited a user settings file.

Undo by running the helper with the same explicit `--settings` path, the same checkout (or `--hook-script` absolute path), and `--remove --apply`; a fresh backup is created before removal. Ownership is matched by the exact absolute script path in the `args` array, so a same-basename script in another checkout is retained. The backup files remain available for manual restoration.

## B: Stop / asyncRewake experiment fixture

`src/claude/remote-hooks-plan.ts` exports `stopHookSchemaFixture()` and `stopAsyncRewakeSchemaFixture()`. They are schema fixtures only; the manual settings helper deliberately does not register a Stop hook. The candidate handler requires an actual pickup client that can query the bridge, distinguish an empty queue from failure, and return the expected status. The existing `claude-hook.mjs` cannot serve that role.

Before considering activation, a separate controlled local experiment must verify, against the actual target CLI version and an isolated config directory:

1. Whether a registered command hook accepts `asyncRewake` and receives the declared Stop payload.
2. Whether a successful “no work” response leaves the conversation stopped, and which exact exit/output path wakes the model for available work.
3. Whether the delivery request creates a normal user message or another message class. PermissionRequest's declared input has no origin field, so automatic agent/tool requests cannot be presumed equivalent to a user prompt.
4. Whether repeated Stop invocations, subagent Stops, background tasks, or `stop_hook_active` can duplicate work or create a wake loop.

This task uses no API-backed Claude run, even with a test prompt. The fixture test does not claim any of these behaviors passed.

## Offline verification

`node --import tsx --test test/remote-hooks-plan.test.ts` uses temporary directories and a dummy client file. It covers shell-free command arguments, merge idempotence, malformed settings refusal, reversible removal, Stop schema fixture fields, preview-only behavior, backup creation, and apply/remove against temporary settings only.
