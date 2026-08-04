# Architecture

```text
~/.codex/sessions/**/*.jsonl
            |
       byte cursor + parser
            |
            +---- visible messages --------> Feishu topic
                                                   |
                                              @bot reply
                                                   |
realpath policy --> per-session mutex --> codex exec/resume --json
                                                   |
                                            JSONL append loop
```

Interactive cards are sent through the message API. Both message events and `card.action.trigger` button actions arrive through the authenticated Feishu WebSocket long connection. The bridge does not expose an HTTP listener or require a public callback endpoint.

The JSONL files are private Codex state rather than a versioned public API. They remain only on the local host; the bridge tolerates unknown record types and tests only the minimal fields required for metadata and visible-message extraction. Codex execution uses the locally verified CLI boundary instead of experimental app-server interfaces.

SQLite commits the Feishu message ID before advancing past successfully delivered work. A restart re-reads an earlier byte range when necessary, while message hashes prevent duplicate delivery. Filesystem events provide low latency and a periodic scan recovers missed events.
