# Architecture

The bridge is a single-user service for one private Feishu group. It has no
HTTP listener or public callback: messages and card actions arrive over the
authenticated Feishu WebSocket connection.

```text
                         Feishu WebSocket
                               |
             message / card / menu event router
                               |
SQLite state + one-time authorization
                    |                         |
  JSONL history <-- import and deduplicate --> app-server turns
       |                                         |
 ~/.codex/sessions                         codex app-server --stdio
       |                                         |
  imported Feishu topic <--- bounded, serialized stream updates
```

The public `SyncService` remains a compatibility facade for `index.ts` and
existing integrations. Its runtime is composed from five narrow services:
`SessionImporter` owns JSONL files and cursors, `TaskScheduler` owns durable
FIFO work and cancellation scopes, `TurnCoordinator` owns app-server turns and
live output, `ApprovalService` owns one-time grants and request resolvers, and
`FeishuRouter` owns the message/menu/card entry points. Each service owns its
short-lived maps; modules exchange immutable DTOs and never reach into another
service's private state.

`codex app-server --stdio` is the only execution backend for Feishu-initiated
work. New sessions use `thread/start`; existing sessions use `thread/resume`;
both create work with `turn/start`. There is no `codex exec` or automatic
fallback path. App-server notifications own live Feishu output. JSONL remains
the local source for history import, externally started CLI sessions, and
restart reconciliation.

Every task re-resolves its cwd through `realpath` immediately before
`thread/start` or `turn/start`. The resulting canonical directory is the only
writable root in normal Default mode. Plan is read-only and network-disabled;
normal Default is `workspace-write` and network-disabled. Root uses
`dangerFullAccess` only inside an explicitly configured dedicated container
that passes UID, capability, and runtime-socket preflight. It requires an
atomic, one-task authorization and cannot become a session-wide grant.

SQLite is the durable coordination boundary. It records session-to-JSONL paths,
Feishu delivery mappings, cursors, task/turn state, one-time app-server
requests, task Root grants, and inbound-event state. Events are claimed as
`processing` and only become `completed` after business work succeeds;
transient failure is retryable while permanent failure is retained for
diagnosis. App-server epoch changes mark active work interrupted rather than
replaying a turn that could already have made changes.

The watcher gives low-latency JSONL import. Periodic scans compare file metadata
with the durable cursor first, then parse only changed files. App-server stream
notifications are serialized per `(sessionId, turnId)` and batched before a
Feishu card update, avoiding competing card sequence updates. See
[design.md](design.md) for state transitions, module ownership, and release
tests.
