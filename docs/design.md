# Detailed Design

This is the maintainer contract for the implementation. The operator guides are
[README.md](../README.md) and [README.en.md](../README.en.md).

## Scope and non-negotiable boundaries

The bridge connects one bound Feishu user in one private group to local Codex
sessions. It receives Feishu events through a WebSocket connection only; it
does not expose an HTTP server or public callback endpoint.

| Boundary | Rule | Enforcement |
| --- | --- | --- |
| Execution backend | Feishu work uses `codex app-server --stdio` only. Never add `codex exec` or a fallback. | `src/app-server.ts`, `src/turn-coordinator.ts` |
| Working directory | Resolve with `realpath` before both thread and turn creation; it must remain under `ALLOWED_ROOT`. | `src/path-policy.ts`, `src/turn-coordinator.ts` |
| Plan | Read-only sandbox, no network, never needs Root authorization. | turn construction in `src/sync-runtime.ts` |
| Normal Default | `workspaceWrite` for the canonical cwd only, no network. | turn construction in `src/sync-runtime.ts` |
| Root Default | `dangerFullAccess` only in a preflight-approved dedicated container and only after one task-scoped authorization. | `src/execution-policy.ts`, `src/db.ts` |
| Remote approval | Never authorize credentials, privilege escalation, sandbox bypass, runtime sockets, out-of-root writes, sensitive-data export, or non-allowlisted MCP. | `src/execution-policy.ts` |
| Secrets | Never solicit secret input in Feishu or persist it. | request policy in `src/sync-runtime.ts` |
| Display | App-server notifications own live display. JSONL imports history/external sessions and must not echo an app-server delivery. | `src/turn-coordinator.ts`, `src/session-importer.ts` |

## Runtime components

`src/index.ts` composes the service without adding policy. Functional ownership
is deliberately separated even where a coordinator invokes the components:

| Component | Responsibility | Must not decide |
| --- | --- | --- |
| `config` | Environment validation and safe defaults. | Feishu routing or state mutation. |
| `codex` | Read-only CLI probing: version, model catalogue, sandbox smoke test. | Executing user work. |
| `app-server` | JSON-RPC transport, schema compatibility, RPC timeouts, backpressure, epoch/exit lifecycle. | Feishu card policy. |
| `execution-policy` | Root container preflight and remote-request allowlist. | Delivering messages. |
| `session-parser` | Tolerant, visibility-filtered JSONL parsing. | Scheduling or network calls. |
| `db` | Schema migrations, SQLite transactions, task/turn/grant/event persistence and retention. | Feishu API calls. |
| `feishu` | SDK/WebSocket normalization, serialized rate-limited API calls, files and CardKit transport. | Authorization decisions. |
| `cards` | Pure v2 card construction (with explicit v1 rollback configuration). | Side effects or trust decisions. |
| `session-importer` | Watches and incrementally imports JSONL, reconciles history, and suppresses live-delivery duplicates. | Task execution, approvals, or Feishu routing. |
| `task-scheduler` | Owns the durable FIFO task queue, workers, terminal-state protection, and explicit cancellation scopes. | App-server protocol, Feishu APIs, or approval resolver state. |
| `turn-coordinator` | Owns app-server turns, serialized notifications, bounded streaming, images, and active-turn state. | Feishu command routing or durable queue policy. |
| `approval-service` | Owns one-time Root grants, remote approvals, user choices, resolvers, and expiry. | Raw protocol payload persistence or app-server execution. |
| `feishu-router` | Routes message, menu, and card entry points through claim/authorization boundaries and delegates work asynchronously. | Direct app-server RPC or private module maps. |
| `sync` | Compatibility facade that composes the runtime and preserves the existing public entry points. | Business workflow ownership; concrete state lives in the modules above. |

Do not create a second mutable in-memory queue as an optimization. Durable
SQLite state is the authority; local maps only serialize short-lived delivery
or active-process work and are always cleared on terminal state or epoch loss.

## Durable data and migration

`BridgeDatabase` lives at `${STATE_DIR}/bridge.sqlite`, defaults to
`~/.local/state/feishu-codex-bridge/bridge.sqlite`, and enables WAL, foreign
keys, and a busy timeout. Migrations must be additive or explicitly rebuild a
table when a SQLite `CHECK` constraint changes. Add migration coverage before
altering the schema.

| Data | Purpose | Retention |
| --- | --- | --- |
| `sessions`, `file_cursors`, `messages` | JSONL path index, incremental parsing and Feishu delivery deduplication. | Required for imported history. |
| `task_queue`, `turn_runs`, `turn_items` | Task state, turn diagnostics and bounded review metadata. | Terminal rows: 30 days. |
| `task_root_grants` | One nonce per Root task; scope includes task, session, cwd, user, chat and app-server epoch. | Resolved rows: 7 days. |
| `server_requests` | One-time app-server input/approval requests. | Resolved rows: 7 days. |
| `inbound_events` | Event idempotency: `processing`, `completed`, retryable or permanent failure. | completed/retryable: 7 days; permanent failure: 30 days. |
| `failures` | Aggregated infrastructure diagnostics. | Resolved failures: 30 days; unresolved retained. |

Old session-level `root_grants` are revoked on startup and never migrated as a
valid authorization. Old running work is marked `interrupted`, never replayed.

## Task and authorization state

The task queue is the concurrency and recovery boundary. It permits these
states:

```text
pending -> awaiting_root_consent -> pending -> running
running -> awaiting_input | awaiting_approval | awaiting_sync
running/awaiting_* -> completed | failed | cancelled | interrupted
```

`awaiting_sync` is retained only as a legacy upgrade marker; new tasks use
`pending`, `awaiting_root_consent`, `running`, and terminal states. Terminal states
never transition back to executable work.
All cancellation sources call the same cancellation path: `/cancel`, a card,
Root rejection, timeout, service shutdown, or app-server exit. It interrupts a
turn when possible, cancels queue state and requests, removes task images, and
updates Feishu best-effort.

Root authorization uses an atomic SQLite flow:

1. The coordinator creates a pending grant with a random nonce bound to exactly
   one queued task and shows a Root-risk card containing only that nonce.
2. Approve, reject and expiry check the nonce, user, chat and current epoch in
   one transaction. Rejection cancels only the bound task.
3. Immediately before `turn/start`, the grant is atomically consumed against
   the task id, session id, canonical cwd and epoch. A second click, old card,
   cross-user action, restart, expired grant or altered cwd fails closed.

The Root preflight requires explicit acknowledgement, UID 0, a detectable
container, no effective `CAP_SYS_ADMIN` or `CAP_SYS_MODULE`, and no readable and
writable Docker, Podman or containerd socket. Any failure disables Root work and
is recorded for doctor/diagnostics.

## App-server turns and lifecycle

For a new task the coordinator calls `thread/start` with the canonical cwd; for
an existing task it calls `thread/resume`. It starts work through `turn/start`
with the saved model/effort and one of the sandbox policies above. Each request
has an operation-specific timeout. The app-server transport serializes stdin
writes, observes backpressure, validates the generated protocol schema, and
increments an epoch whenever it restarts.

An exit, epoch change or RPC failure first persists active tasks as
`interrupted`, clears active resolvers/streams, then attempts Feishu card
updates asynchronously. It must not automatically restart or replay a turn
which might already have written files. A later user message creates a fresh
task.

`turn/completed` commits local terminal state and cleanup before the Feishu
update. A failed card update therefore cannot keep a session locked.

## Inbound/outbound delivery

On incoming message delivery the service claims `message:<messageId>` as
`processing`. It sets the event to `completed` only after the router succeeds.
Network, timeout, 429 and 5xx failures become retryable; permanent failures are
not retried. The same classification is used by the Feishu client, which retries
only those transient categories with bounded exponential backoff and does not
sleep after its final failed attempt.

App-server notifications are serialized per `(sessionId, turnId)`. Their body
is batched at 500 ms; persistent turn data stores times and input/final-output
hashes rather than every delta. A matching JSONL record is mapped to the
app-server delivery instead of sent again. Long output is bounded and emitted
as a short card plus Markdown attachment.

Tool reviews only persist/send an allowlisted summary: kind, status, command
summary, changed filenames, and truncated non-sensitive result. Never send
protocol payloads or complete command output to Feishu.

Input images use a task-specific temporary directory. The limit is five images,
10 MiB each and 25 MiB total; download is size-bounded and all paths are
removed in `finally`. Startup removes directories older than 24 hours.

## JSONL import and recovery

JSONL is a local, private Codex format. Parse only fields needed for metadata,
visible user/assistant/progress text and supported choice requests. Unknown
records are ignored. A per-file cursor preserves partial trailing lines;
delivery is saved before advancing the cursor. Watcher events provide latency;
periodic scans compare the saved size/mtime before parsing, and per-file queues
prevent overlapping reads.

The persisted session path is the normal lookup index; broad JSONL searches are
only a recovery fallback. Historical import may create roots and visible
messages. It does not own live app-server output and filters subagent records.

## Tests and release

Every behavior change needs focused unit/migration coverage. Safety tests must
cover traversal and symlink escape, nonce replay, cross-user/session cards,
Root preflight failures, secret input, dangerous approvals and runtime sockets.
Integration tests use a fake app-server for exit, timeout, cancellation,
duplicate/ordered notifications and failed Feishu delivery.

Before release run:

```bash
npm run check
npm test
npm run build
npm run doctor
git diff --check
```

Then verify in a private group: normal Default, Plan, Root approve/reject,
images, long streaming output, an external CLI JSONL session, restart recovery,
and duplicate inbound events. `doctor` and private-group checks require a real
configured deployment and are not implied by unit tests.
