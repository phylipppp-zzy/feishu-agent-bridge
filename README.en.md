# Feishu-Codex Full Sync Bridge

[中文说明](README.md)

Maintainer design: [docs/design.md](docs/design.md)

The repository also contains a Feishu bridge for Claude Code sessions, which mirrors them into a private Feishu group and can continue them from there, with its own Feishu app, private group and service; see [docs/claude.md](docs/claude.md) (Chinese).

This service mirrors local Codex conversations from `~/.codex/sessions` into a private Feishu topic group and lets you continue each conversation from its corresponding topic. It is a Feishu front end for the local Codex CLI: it does not install a Feishu desktop client, open an HTTP port, or require a public callback URL. Messages and card actions arrive over a Feishu WebSocket long connection.

## What It Does

- Scans and continuously watches `~/.codex/sessions/**/*.jsonl`. Each Codex `session_id` maps to a Feishu root message; topic replies form the readable conversation.
- Sends only readable user messages, Codex text, and progress updates to Feishu. Messages sent in a session topic (including messages added to a running turn) are not posted again as `User` entries; the prompt of a new session is shown once in its new topic.
- Provides JSON 2.0 console cards, project -> model -> reasoning effort -> task creation, session search, topic continuation, image input, pause, retry, and cancellation.
- Sends bodies over 50,000 characters as Markdown attachments. Downloaded images are stored in a controlled `0600` temporary directory and removed after Codex receives them.
- Stores mappings, parsing offsets, deduplication keys, and failures in `~/.local/state/feishu-codex-bridge/bridge.sqlite`.
- Keeps raw Codex JSONL on the local machine only. The bridge does not upload raw archives.
- Runs Feishu turns through the persistent `codex app-server --stdio`; JSONL is retained for history import, external CLI sessions, and recovery only.
- Plan turns are read-only with networking disabled. Default turns use `workspace-write` for the canonical task directory with networking disabled. Root is an explicit, one-task authorization for a preflight-checked dedicated container only; there is no `codex exec` fallback.
- Loads visible models and supported reasoning efforts from `codex debug models` at startup and caches them in SQLite. If no valid model directory is available, new sessions are blocked and `/retry` can refresh it.
- Internally, JSONL import, durable scheduling, app-server turns, approvals, and Feishu routing are split across `SessionImporter`, `TaskScheduler`, `TurnCoordinator`, `ApprovalService`, and `FeishuRouter`. `SyncService` remains only as a compatibility facade and owns no cross-module queues or active state.

## One-Command Installation

The supported target is Linux with systemd. Before installation, you need:

- Node.js 22 or later and npm.
- Codex CLI installed, logged in, and available in the terminal.
- A Feishu account permitted to create a self-built app. If your tenant requires approval, an administrator must approve the submitted app version after installation.

After downloading the repository, run this from its root:

```bash
./install.sh
```

If a ZIP download did not preserve the executable bit, run `bash install.sh` instead. Do not use `sudo`: install as the same normal user that runs Codex. When Node, Codex, or Codex login is missing, the installer prints copyable repair commands. It never performs remote bootstrap commands, sudo, or login on your behalf.

The installer:

1. Installs locked dependencies and runs type checks, tests, and the build.
2. Prints a Feishu device authorization link. After authorization, it creates a separate self-built app for the current user.
3. Stores credentials in a `0600` recovery file, configures the minimum permissions, WebSocket events, card callback, bot capability, bot menu, and app visibility, then submits a version for publication.
4. Generates a binding token and writes App ID/Secret to `~/.config/feishu-codex-bridge/env` with mode `0600`.
5. Generates a user-level systemd unit using the actual repository, Node, and Codex paths, then starts it immediately. No manual service start is needed after installation.
6. Runs `doctor`, a read-only check. It prints the binding command only after the Feishu bot API is available.

The installer never uploads local JSONL, reuses the repository author's Feishu credentials, paths, or SQLite data, or creates a second app when rerun. Rerun `./install.sh` to repair an incomplete installation, refresh required Feishu configuration, or regenerate the user service while preserving its existing app, configuration, and binding state.

### What To Do When The Installer Ends

- **It prints “Installation complete” and a `/bind` command:** the service is already running. Create a private topic group, add the new bot, and send the shown command in that group.
- **It says the app awaits administrator approval:** the service is installed but the bot is not usable yet. Approve the app version in the Feishu developer console, run `npm run doctor` in the repository to verify it, then run `./install.sh` once more to display the existing `/bind` command. This reuses the same app and token.
- **It reports another error:** follow the copyable repair command printed by the installer and rerun `./install.sh`. Do not create or start a systemd unit manually.

The successful command looks like:

```text
@bot /bind <token-generated-by-the-installer>
```

`doctor` is a read-only diagnostic command. It does not create a Feishu app or start, stop, or restart the service. It checks Feishu bot availability, environment-file permissions, Codex login, and the user service:

```bash
npm run doctor
```

After a successful bind, send `/help`. The service scans the current user's `~/.codex/sessions`; the default allowed working root is that user's home directory. The server needs no GUI, Feishu desktop client, or public port. Open the terminal's device authorization link on another computer or in the Feishu mobile app if the server is headless.

### Existing App and Manual Fallback

To use an existing Feishu self-built app, authorize with its owner or administrator account:

```bash
./install.sh --existing-app <cli_xxx>
```

This does not create a second app. It completes the bridge permissions, WebSocket event/callback, bot menu, and visibility limited to the authorizing user. Existing legacy instances are not visibility-migrated by an ordinary upgrade; use this explicit mode to migrate them.

If tenant policy prevents device-authorized creation or updates, configure the app in the Feishu developer console first, then run:

```bash
mkdir -p ~/.config/feishu-codex-bridge
cp deploy/env.example ~/.config/feishu-codex-bridge/env
chmod 600 ~/.config/feishu-codex-bridge/env
$EDITOR ~/.config/feishu-codex-bridge/env
./install.sh --from-env
```

`--from-env` never changes the Feishu console. You must restrict app visibility to the deployer, configure the bot, minimum permissions, long-connection events, card callback, and publish a version before running it. This mode still installs and starts the local service and runs `doctor`; only bind once the terminal prints the `/bind` command.

## Manual Feishu Configuration

Normal installation configures the developer console automatically. Use this only for the manual fallback:

1. Go to <https://open.feishu.cn/app>, create a self-built app, add bot capability, and make it visible only to the deployer.
2. Request application permissions:
   - `im:message:send_as_bot` to send bot messages, cards, and attachments.
   - `im:message.group_at_msg:readonly` to receive group messages that mention the bot.
   - `im:message` to read bot root messages and update a card after an action.
   - `im:message.group_msg` to read root messages in the bound private group for topic metadata. This can read group messages, so grant it only for the dedicated private group.
   - `im:resource` to download user images and send long Markdown attachments.
3. Under Events and Callbacks, choose long connection delivery. Subscribe to `im.message.receive_v1`, `application.bot.menu_v6`, and callback `card.action.trigger`.
4. Optionally add event-type bot-menu items with keys `codex.home`, `codex.new`, `codex.sessions`, `codex.search`, and `codex.service`.
5. Create and publish a version, then create a private topic group containing only authorized users and the bot.

Card buttons return over the same WebSocket connection. No public IP, domain, tunnel, Verification Token, or Encrypt Key is required. Do not request unrelated contact-directory or group-management permissions.

The manual environment file must include `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `FEISHU_BIND_TOKEN`, and the card version. Production uses JSON 2.0:

```dotenv
FEISHU_CARD_UI_VERSION=2
```

To temporarily roll back card construction, set this to `1`, then run the restart command under Operations. Version 1 does not support the new form-submission flow. `--from-env` generates and starts the user service; only a deployment that deliberately does not use the installer must create a unit from [`deploy/feishu-codex-bridge.service`](deploy/feishu-codex-bridge.service).

Bind with:

```text
/bind <FEISHU_BIND_TOKEN>
```

Binding records the group ID and current user's `open_id`, then starts historical synchronization. A token cannot bind a second group or user.

### Move To a New Group

Create a new private topic group and add the bot and authorized user. Change `FEISHU_BIND_TOKEN` to a new random value in `~/.config/feishu-codex-bridge/env`, preserving mode `0600`, then run:

```bash
systemctl --user stop feishu-codex-bridge.service
$EDITOR ~/.config/feishu-codex-bridge/env
npm run rebind -- --confirm
systemctl --user start feishu-codex-bridge.service
```

This backs up SQLite and resets only the Feishu group binding, topic mappings, sent-message deduplication, and JSONL offsets. It does not delete local JSONL, saved session model settings, or messages in the old group. Send `@bot /bind <new-token>` in the new group. Binding triggers a complete rescan; `/sync` can be used to observe it.

## Everyday Use

### Create and Continue Sessions

The easiest entry is the **Codex Console** card. Choose **New session**, then choose project, Codex model, supported reasoning effort, and enter the task in the card. Use chat instead for images, combined text-and-image prompts, or prompts longer than 1,000 characters. Every valid choice extends the wizard for 10 minutes; old, expired, and duplicate cards cannot overwrite the current wizard.

You can also send:

```text
/new <directory> <prompt>
```

`/new` saves the prompt and image references, then shows model and reasoning cards. It executes automatically after selection. The directory must exist, resolve under the install user's home directory, and cannot escape through traversal or symlinks.

To continue an existing session, reply directly in that session's topic. No `@bot` is needed there. The bridge resumes the mapped `session_id` through app-server `thread/resume` and `turn/start`. A continuation waits if the same session is active in local Codex or in the bridge, preventing concurrent writes.

Selected model and reasoning effort persist with the `session_id`. For a mapped topic, use the root card's **Change model** action or send `/model` to open the same selection flow. The text fallback is:

```text
/model <model> <reasoning-effort>
```

This atomically changes future continuations. `/model` in a group root does not modify any session. This release does not implement `/plan`, service tiers, or speed tiers.

### Console, Commands, and Search

In the bound private group, known slash commands do not need an `@bot`. A normal group-root prompt still must mention the bot. Send `/` by itself to display a panel with New, Search, Recent, Console, Service Management, and Help. Unknown `/xxx` commands only show that panel and never submit work to Codex.

Inside a session topic, sending `/` by itself posts the session's root card again at the bottom of the topic (model, mode and turn review), so a long topic need not be scrolled back up. Only commands starting with `/` reach the bridge there; every other message goes to Codex, as it would in the terminal. The plain-word shortcuts below (such as `status`, `retry`, or `pause` in Chinese) work only at the group root; inside a topic they are sent to Codex as ordinary messages.

- `/help`, `help`, `?`: show help.
- `/`: show the command panel.
- `/sessions`: open the session-search card.
- `/search <keywords>`: search project directory, first user-message summary, and short session ID. Multiple words use AND matching.
- `new`, `project`, `sessions`, `recent`, `status`: open the corresponding card.
- `/status`: show indexed sessions, active tasks, failures, and the allowed root.
- `/sync`: rescan local sessions immediately.
- `/pause`, `/resume-sync`: pause or resume synchronization and continuations.
- `/retry`: resolve infrastructure failures only after the model directory and app-server recover, then rescan from persistent offsets.
- `/cancel`: cancel a bridge-started task, current wizard, or current choice in the topic.
- `/model`: choose model and reasoning effort in a mapped session topic.

Recent sessions are grouped by project and shown eight at a time. Search queries SQLite only; they do not scan full JSONL. Examples:

```text
/search example-project
/search GUI Agent
/search <short-session-id>
```

## When Codex Needs Your Answer

Implementation choices and business confirmations are presented as real Feishu card buttons. If a card expires or cannot be used, reply `1` in the same topic to choose the first option, or reply with free text. Answer ordinary questions directly in the topic.

- In a Feishu-started turn, a Codex question card lists its options and walks through multiple questions in order; the answers take effect within the current turn. "Don't answer" lets Codex continue the turn without an answer.
- Questions asked by Codex in a local terminal are shown as cards too. While the terminal is still waiting, answer in the terminal and the card closes itself. An answer given in Feishu is queued and sent as a new message after the terminal finishes the turn or exits; if the terminal answers first, the queued answer is cancelled.
- A question already answered in the terminal or in Feishu never produces a new card, and later ordinary messages in the topic are not taken as its answer.

Cards may ask for confirmation to:

- Search public information or recent commits in candidate projects.
- Choose dependencies, research direction, implementation, or a plan.
- Modify files within an already authorized working directory.

Cards only express business intent. They never bypass path validation or the sandbox policy. The bridge never offers remote approval for sudo, privilege escalation, passwords, keys, tokens, verification codes, CAPTCHA, authentication, sandbox bypass, runtime sockets, writes outside the allowed root, or private-data export to external services. Secret input in Feishu is always rejected.

Command approval cards show the command to run in a code block, without the `/bin/bash -lc` wrapper Codex adds. Commands that use network transfer tools (curl, wget, scp, …), nested shells, redirection, privilege escalation, or sensitive paths cannot be approved from Feishu: the bridge declines them and posts an “auto-declined” card in the topic explaining why, and Codex receives the refusal and tries another way.

## Synchronization and Privacy

Feishu receives readable conversation content only: user messages, assistant text, and progress updates. System and developer instructions, internal events, tool parameters, and tool output stay in local JSONL.

Raw JSONL is not uploaded. Old Feishu attachments are not deleted automatically. The retired `UPLOAD_RAW_ARCHIVES` environment setting is ignored and can be removed during maintenance.

At a group root, a normal prompt must mention the current bot and the bridge verifies the mentioned bot `open_id`. Known slash commands from the bound user are the exception. In a mapped topic, text, images, and numeric choices can be sent without mentioning the bot. At a group root, an image prompt should be one rich-text message containing the bot mention, prompt text, and image.

## Codex Execution Boundary

- Working directories must pass `realpath` and remain under installer-written `ALLOWED_ROOT`, which defaults to the install user's home directory. Traversal and symlink escape are rejected.
- Feishu turns do not use `codex exec`; new and resumed sessions use app-server `thread/*` and `turn/*` requests.
- Plan uses a read-only sandbox with networking disabled. Normal Default uses `workspace-write` for the canonical cwd with networking disabled.
- `root-danger-full-access` is available only when its explicit acknowledgement is configured and the process is UID 0 inside a dedicated container with neither `CAP_SYS_ADMIN` nor `CAP_SYS_MODULE` nor an accessible Docker, Podman, or containerd socket. Each Root task needs a separate one-time authorization; restart and epoch changes revoke all outstanding authorizations.
- Active-task and JSONL-activity protection prevents the bridge and local Codex from writing the same session concurrently.
- New and resumed sessions pass stored model and reasoning-effort settings to app-server. Historical sessions without saved settings retain local Codex defaults.

## Service Lifecycle and Operations

The installer starts the user service immediately; users do not need a manual start command. With `linger=no`, the first SSH login can also start an enabled user service, and later SSH connections reuse it. When the last login session for that user exits, the service stops; the next login starts it again.

An administrator may make it persist without any logged-in session:

```bash
sudo loginctl enable-linger "$USER"
```

Daily read-only checks:

```bash
npm run doctor
npm run check
npm test
systemctl --user status feishu-codex-bridge.service
journalctl --user -u feishu-codex-bridge.service --since today
```

Only after upgrading source code or editing configuration manually, rebuild and restart to load the new output:

```bash
npm run build
systemctl --user restart feishu-codex-bridge.service
```

## Known Limitations

- A Feishu deep link must be verified separately in desktop and mobile clients. If one client cannot locate a root message, use project, summary, and short session ID in search results.
- The installer configures the bot menu. Manual fallback deployments must configure the event keys, subscribe to `application.bot.menu_v6`, and publish again. The `/` command panel does not depend on a configured bot menu.
- A WebSocket long connection receives messages only after sending; it cannot show native slash-command completion while the user is typing.

After upgrading Codex or the Feishu SDK, run tests and verify JSONL event handling, card callbacks, topic continuation, and image input in a test group. Unknown JSONL event types are logged and ignored rather than sent to the readable view.
