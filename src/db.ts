import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FileCursor, PendingServerRequest, QueuedTask, SessionMetadata, TaskRootGrant, TurnOutput, TurnState } from "./types.js";


export class BridgeDatabase {
  readonly db: DatabaseSync;
  readonly serviceEpoch = randomUUID();

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(stateDir, "bridge.sqlite"));
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        cwd TEXT NOT NULL,
        started_at TEXT NOT NULL,
        source TEXT NOT NULL,
        first_user_text TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        collaboration_mode TEXT NOT NULL DEFAULT 'default',
        root_message_id TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS file_cursors (
        path TEXT PRIMARY KEY,
        session_id TEXT,
        parsed_offset INTEGER NOT NULL DEFAULT 0,
        archived_offset INTEGER NOT NULL DEFAULT 0,
        carry TEXT NOT NULL DEFAULT '',
        size INTEGER NOT NULL DEFAULT 0,
        mtime_ms REAL NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS messages (
        message_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        feishu_message_id TEXT,
        direction TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS archive_parts (
        session_id TEXT NOT NULL,
        start_offset INTEGER NOT NULL,
        end_offset INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        feishu_message_id TEXT NOT NULL,
        PRIMARY KEY(session_id, start_offset, end_offset)
      );
      CREATE TABLE IF NOT EXISTS failures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operation TEXT NOT NULL,
        payload TEXT NOT NULL,
        error TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 1,
        resolved INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    this.ensureColumn("sessions", "root_app_link", "TEXT");
    this.ensureColumn("sessions", "model", "TEXT");
    this.ensureColumn("sessions", "reasoning_effort", "TEXT");
    this.ensureColumn("sessions", "title", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("sessions", "collaboration_mode", "TEXT NOT NULL DEFAULT 'default'");
    this.ensureColumn("sessions", "chat_id", "TEXT");
    this.ensureColumn("sessions", "thread_id", "TEXT");
    this.ensureColumn("sessions", "session_card_message_id", "TEXT");
    this.ensureColumn("sessions", "session_card_version", "INTEGER NOT NULL DEFAULT 1");
    this.ensureColumn("sessions", "lifecycle", "TEXT NOT NULL DEFAULT 'active'");
    this.ensureColumn("sessions", "lifecycle_updated_at_ms", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("sessions", "created_by_task_id", "TEXT");
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS sessions_created_by_task ON sessions(created_by_task_id) WHERE created_by_task_id IS NOT NULL");
    this.ensureColumn("messages", "source_path", "TEXT");
    this.ensureColumn("messages", "source_kind", "TEXT");
    this.ensureColumn("messages", "recalled_at", "TEXT");
    this.ensureColumn("messages", "recall_state", "TEXT");
    this.db.exec(`CREATE TABLE IF NOT EXISTS run_status (
      session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
      message_id TEXT,
      state TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      updated_at_ms INTEGER NOT NULL DEFAULT 0
    );`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS task_queue (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('new','resume')),
      session_id TEXT,
      cwd TEXT NOT NULL,
      prompt TEXT NOT NULL,
      image_keys TEXT NOT NULL DEFAULT '[]',
      source_message_id TEXT NOT NULL UNIQUE,
      chat_id TEXT NOT NULL,
      root_message_id TEXT,
      model TEXT,
      reasoning_effort TEXT,
      status TEXT NOT NULL CHECK(status IN ('pending','running','awaiting_sync','completed','failed','cancelled','interrupted')),
      run_card_message_id TEXT,
      expected_session_id TEXT,
      sync_status TEXT NOT NULL DEFAULT 'none',
      last_sync_offset INTEGER,
      error TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS task_queue_session_status ON task_queue(session_id,status,created_at_ms);
    CREATE TABLE IF NOT EXISTS choice_queue (
      request_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS choice_queue_session_created ON choice_queue(session_id,created_at_ms);`);
    this.ensureColumn("task_queue", "expected_session_id", "TEXT");
    this.ensureColumn("task_queue", "sync_status", "TEXT NOT NULL DEFAULT 'none'");
    this.ensureColumn("task_queue", "last_sync_offset", "INTEGER");
    this.ensureColumn("task_queue", "turn_id", "TEXT");
    this.ensureColumn("task_queue", "engine", "TEXT NOT NULL DEFAULT 'exec'");
    this.ensureColumn("task_queue", "root_grant_nonce", "TEXT");
    this.ensureColumn("task_queue", "terminal_reason", "TEXT");
    this.migrateTaskQueueStatusConstraint();
    // The status-constraint migration rebuilds task_queue, so add new columns afterwards.
    this.ensureColumn("task_queue", "root_grant_nonce", "TEXT");
    this.ensureColumn("task_queue", "terminal_reason", "TEXT");
    this.ensureColumn("task_queue", "phase", "TEXT");
    this.ensureColumn("task_queue", "task_fingerprint", "TEXT");
    this.ensureColumn("task_queue", "creation_attempt_id", "TEXT");
    this.ensureColumn("task_queue", "creation_started_at_ms", "INTEGER");
    this.ensureColumn("task_queue", "retry_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("task_queue", "next_attempt_at_ms", "INTEGER");
    this.ensureColumn("task_queue", "expires_at_ms", "INTEGER");
    this.ensureColumn("task_queue", "action_nonce", "TEXT");
    this.ensureColumn("task_queue", "unarchive_approved", "INTEGER NOT NULL DEFAULT 0");
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS task_queue_action_nonce ON task_queue(action_nonce) WHERE action_nonce IS NOT NULL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS turn_runs (
      turn_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, epoch INTEGER NOT NULL, mode TEXT NOT NULL,
      state TEXT NOT NULL, root_message_id TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', plan TEXT NOT NULL DEFAULT '',
      stream_json TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS turn_runs_session_state ON turn_runs(session_id,state);
    CREATE TABLE IF NOT EXISTS turn_outputs (
      turn_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, root_message_id TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL, content TEXT NOT NULL,
      card_status TEXT NOT NULL CHECK(card_status IN ('pending','sent','failed','uncertain')), card_message_id TEXT,
      file_status TEXT NOT NULL CHECK(file_status IN ('none','pending','sent','failed','uncertain')), file_message_id TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS turn_outputs_open ON turn_outputs(card_status,file_status);
    CREATE TABLE IF NOT EXISTS app_server_deliveries (session_id TEXT NOT NULL, turn_id TEXT NOT NULL, role TEXT NOT NULL, started_at_ms INTEGER, ended_at_ms INTEGER, content_hash TEXT NOT NULL, content_bytes INTEGER NOT NULL DEFAULT 0, feishu_message_id TEXT, source_message_id TEXT, source_path TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, PRIMARY KEY(session_id,turn_id,role));
    CREATE INDEX IF NOT EXISTS app_server_deliveries_hash ON app_server_deliveries(session_id,role,content_hash);
    CREATE TABLE IF NOT EXISTS turn_items (
      turn_id TEXT NOT NULL, item_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}', feishu_message_id TEXT, updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY(turn_id,item_id)
    );
    CREATE TABLE IF NOT EXISTS server_requests (
      nonce TEXT PRIMARY KEY, rpc_id_json TEXT NOT NULL, epoch INTEGER NOT NULL, type TEXT NOT NULL,
      session_id TEXT NOT NULL, turn_id TEXT, item_id TEXT, open_id TEXT NOT NULL, chat_id TEXT NOT NULL,
      root_message_id TEXT NOT NULL, card_message_id TEXT, payload TEXT NOT NULL, status TEXT NOT NULL,
      expires_at_ms INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS server_requests_session_status ON server_requests(session_id,status);
    CREATE TABLE IF NOT EXISTS inbound_events (
      event_id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('processing','completed','retryable_failed','permanent_failed')),
      error TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS inbound_events_status ON inbound_events(status,updated_at_ms);
    CREATE TABLE IF NOT EXISTS task_root_grants (
      nonce TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE REFERENCES task_queue(id) ON DELETE CASCADE,
      session_id TEXT, task_fingerprint TEXT NOT NULL DEFAULT 'legacy', canonical_cwd TEXT NOT NULL, open_id TEXT NOT NULL, chat_id TEXT NOT NULL,
      epoch INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','approved','denied','expired','consumed','cancelled')),
      created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS task_root_grants_scope ON task_root_grants(session_id,status,expires_at_ms);
    CREATE TABLE IF NOT EXISTS root_grants (
      session_id TEXT PRIMARY KEY, cwd TEXT NOT NULL, open_id TEXT NOT NULL, epoch INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
    );`);
    this.migrateTaskRootGrants();
    this.ensureColumn("inbound_events", "claim_token", "TEXT");
    this.ensureColumn("inbound_events", "service_epoch", "TEXT");
    this.ensureColumn("inbound_events", "lease_until_ms", "INTEGER");
    this.ensureColumn("inbound_events", "attempt_count", "INTEGER NOT NULL DEFAULT 0");
    this.db.prepare("UPDATE inbound_events SET status='retryable_failed',error='service restarted during event processing',updated_at_ms=? WHERE status='processing' AND (service_epoch IS NULL OR service_epoch<>?)").run(Date.now(), this.serviceEpoch);
    this.ensureColumn("turn_runs", "started_at_ms", "INTEGER");
    this.ensureColumn("turn_runs", "ended_at_ms", "INTEGER");
    this.ensureColumn("turn_runs", "input_hash", "TEXT");
    this.ensureColumn("turn_runs", "final_output_hash", "TEXT");
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private migrateTaskQueueStatusConstraint(): void {
    const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='task_queue'").get() as { sql?: string } | undefined;
    if (row?.sql?.includes("'creation_uncertain'")) return;
    this.db.exec("PRAGMA foreign_keys=OFF");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`CREATE TABLE task_queue_next (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('new','resume')), session_id TEXT, cwd TEXT NOT NULL, prompt TEXT NOT NULL,
        image_keys TEXT NOT NULL DEFAULT '[]', source_message_id TEXT NOT NULL UNIQUE, chat_id TEXT NOT NULL, root_message_id TEXT, model TEXT, reasoning_effort TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending','authorized','creating_thread','thread_created','starting_turn','running','awaiting_root_consent','awaiting_writer','awaiting_unarchive','creation_uncertain','awaiting_input','awaiting_approval','awaiting_sync','completed','failed','cancelled','interrupted','expired')),
        run_card_message_id TEXT, expected_session_id TEXT, sync_status TEXT NOT NULL DEFAULT 'none', last_sync_offset INTEGER, turn_id TEXT, engine TEXT NOT NULL DEFAULT 'app_server', error TEXT,
        root_grant_nonce TEXT, terminal_reason TEXT, phase TEXT, task_fingerprint TEXT, creation_attempt_id TEXT, creation_started_at_ms INTEGER, retry_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at_ms INTEGER, expires_at_ms INTEGER, action_nonce TEXT, unarchive_approved INTEGER NOT NULL DEFAULT 0, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
      );
      INSERT INTO task_queue_next(id,kind,session_id,cwd,prompt,image_keys,source_message_id,chat_id,root_message_id,model,reasoning_effort,status,run_card_message_id,expected_session_id,sync_status,last_sync_offset,turn_id,engine,error,root_grant_nonce,terminal_reason,created_at_ms,updated_at_ms)
      SELECT id,kind,session_id,cwd,prompt,image_keys,source_message_id,chat_id,root_message_id,model,reasoning_effort,status,run_card_message_id,expected_session_id,COALESCE(sync_status,'none'),last_sync_offset,turn_id,engine,error,root_grant_nonce,terminal_reason,created_at_ms,updated_at_ms FROM task_queue;
      DROP TABLE task_queue; ALTER TABLE task_queue_next RENAME TO task_queue;
      CREATE INDEX task_queue_session_status ON task_queue(session_id,status,created_at_ms);`);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    finally { this.db.exec("PRAGMA foreign_keys=ON"); }
  }

  private migrateTaskRootGrants(): void {
    const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='task_root_grants'").get() as { sql?: string } | undefined;
    if (!row?.sql || row.sql.includes("task_fingerprint TEXT")) return;
    this.db.exec("PRAGMA foreign_keys=OFF");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`CREATE TABLE task_root_grants_next (nonce TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE REFERENCES task_queue(id) ON DELETE CASCADE, session_id TEXT, task_fingerprint TEXT NOT NULL, canonical_cwd TEXT NOT NULL, open_id TEXT NOT NULL, chat_id TEXT NOT NULL, epoch INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','approved','denied','expired','consumed','cancelled')), created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
      INSERT INTO task_root_grants_next(nonce,task_id,session_id,task_fingerprint,canonical_cwd,open_id,chat_id,epoch,expires_at_ms,status,created_at_ms,updated_at_ms) SELECT nonce,task_id,session_id,COALESCE((SELECT task_fingerprint FROM task_queue WHERE id=task_id),'legacy:'||task_id),canonical_cwd,open_id,chat_id,epoch,expires_at_ms,status,created_at_ms,updated_at_ms FROM task_root_grants;
      DROP TABLE task_root_grants; ALTER TABLE task_root_grants_next RENAME TO task_root_grants; CREATE INDEX task_root_grants_scope ON task_root_grants(session_id,status,expires_at_ms);`);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    finally { this.db.exec("PRAGMA foreign_keys=ON"); }
  }

  close(): void { this.db.close(); }

  getSetting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }

  deleteSetting(key: string): void { this.db.prepare("DELETE FROM settings WHERE key=?").run(key); }

  listSettings(prefix: string): Array<{ key: string; value: string }> {
    return this.db.prepare("SELECT key,value FROM settings WHERE substr(key,1,?)=? ORDER BY key").all(prefix.length, prefix) as Array<{ key: string; value: string }>;
  }

  getCursor(path: string): FileCursor {
    const row = this.db.prepare("SELECT path, session_id, parsed_offset, archived_offset, carry, size, mtime_ms FROM file_cursors WHERE path = ?").get(path) as Record<string, unknown> | undefined;
    if (!row) return { path, sessionId: null, parsedOffset: 0, archivedOffset: 0, carry: "", size: 0, mtimeMs: 0 };
    return {
      path: String(row.path), sessionId: row.session_id ? String(row.session_id) : null,
      parsedOffset: Number(row.parsed_offset), archivedOffset: Number(row.archived_offset),
      carry: String(row.carry), size: Number(row.size), mtimeMs: Number(row.mtime_ms),
    };
  }

  saveCursor(cursor: FileCursor): void {
    this.db.prepare(`INSERT INTO file_cursors(path,session_id,parsed_offset,archived_offset,carry,size,mtime_ms)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET session_id=excluded.session_id,
      parsed_offset=excluded.parsed_offset, archived_offset=excluded.archived_offset, carry=excluded.carry,
      size=excluded.size, mtime_ms=excluded.mtime_ms`).run(cursor.path, cursor.sessionId, cursor.parsedOffset,
      cursor.archivedOffset, cursor.carry, cursor.size, cursor.mtimeMs);
  }

  upsertSession(session: SessionMetadata): void {
    this.db.prepare(`INSERT INTO sessions(session_id,path,cwd,started_at,source,first_user_text,title,collaboration_mode,model,reasoning_effort,lifecycle,lifecycle_updated_at_ms,created_by_task_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET path=excluded.path,cwd=excluded.cwd,
      started_at=excluded.started_at,source=excluded.source,
      first_user_text=CASE WHEN excluded.first_user_text<>'' THEN excluded.first_user_text ELSE sessions.first_user_text END,
      title=CASE WHEN excluded.title<>'' THEN excluded.title ELSE sessions.title END,
      collaboration_mode=COALESCE(excluded.collaboration_mode,sessions.collaboration_mode),
      model=COALESCE(excluded.model,sessions.model),reasoning_effort=COALESCE(excluded.reasoning_effort,sessions.reasoning_effort),
      lifecycle=CASE WHEN excluded.lifecycle_updated_at_ms>0 THEN excluded.lifecycle ELSE sessions.lifecycle END,
      lifecycle_updated_at_ms=MAX(sessions.lifecycle_updated_at_ms,excluded.lifecycle_updated_at_ms),
      created_by_task_id=COALESCE(excluded.created_by_task_id,sessions.created_by_task_id),updated_at=CURRENT_TIMESTAMP`).run(
      session.sessionId, session.path, session.cwd, session.startedAt, session.source, session.firstUserText,
      session.title ?? "", session.collaborationMode ?? "default",
      session.model ?? null, session.reasoningEffort ?? null, session.lifecycle ?? "active",
      session.lifecycleUpdatedAtMs ?? (session.lifecycle ? Date.now() : 0), session.createdByTaskId ?? null,
    );
  }

  getSession(sessionId: string): (SessionMetadata & { rootMessageId: string | null; rootAppLink: string | null; chatId: string | null; threadId: string | null; sessionCardMessageId: string | null }) | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE session_id=?").get(sessionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      sessionId: String(row.session_id), path: String(row.path), cwd: String(row.cwd),
      startedAt: String(row.started_at), source: String(row.source), firstUserText: String(row.first_user_text),
      title: row.title ? String(row.title) : null,
      collaborationMode: row.collaboration_mode === "plan" ? "plan" : "default",
      rootMessageId: row.root_message_id ? String(row.root_message_id) : null,
      rootAppLink: row.root_app_link ? String(row.root_app_link) : null,
      chatId: row.chat_id ? String(row.chat_id) : null,
      threadId: row.thread_id ? String(row.thread_id) : null,
      sessionCardMessageId: row.session_card_message_id ? String(row.session_card_message_id) : null,
      model: row.model ? String(row.model) : null,
      reasoningEffort: row.reasoning_effort ? String(row.reasoning_effort) : null,
      lifecycle: (["archived", "deleted", "abandoned"].includes(String(row.lifecycle)) ? String(row.lifecycle) : "active") as NonNullable<SessionMetadata["lifecycle"]>,
      lifecycleUpdatedAtMs: Number(row.lifecycle_updated_at_ms ?? 0), createdByTaskId: row.created_by_task_id ? String(row.created_by_task_id) : null,
    };
  }

  getSessionByRoot(rootId: string): (SessionMetadata & { rootMessageId: string; rootAppLink: string | null; chatId: string | null; threadId: string | null; sessionCardMessageId: string | null }) | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE root_message_id=?").get(rootId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      sessionId: String(row.session_id), path: String(row.path), cwd: String(row.cwd),
      startedAt: String(row.started_at), source: String(row.source), firstUserText: String(row.first_user_text),
      title: row.title ? String(row.title) : null,
      collaborationMode: row.collaboration_mode === "plan" ? "plan" : "default",
      rootMessageId: String(row.root_message_id),
      rootAppLink: row.root_app_link ? String(row.root_app_link) : null,
      chatId: row.chat_id ? String(row.chat_id) : null,
      threadId: row.thread_id ? String(row.thread_id) : null,
      sessionCardMessageId: row.session_card_message_id ? String(row.session_card_message_id) : null,
      model: row.model ? String(row.model) : null,
      reasoningEffort: row.reasoning_effort ? String(row.reasoning_effort) : null,
      lifecycle: (["archived", "deleted", "abandoned"].includes(String(row.lifecycle)) ? String(row.lifecycle) : "active") as NonNullable<SessionMetadata["lifecycle"]>,
      lifecycleUpdatedAtMs: Number(row.lifecycle_updated_at_ms ?? 0), createdByTaskId: row.created_by_task_id ? String(row.created_by_task_id) : null,
    };
  }

  getSessionByCardMessage(messageId: string): (SessionMetadata & { rootMessageId: string; rootAppLink: string | null; chatId: string | null; threadId: string | null; sessionCardMessageId: string | null }) | null {
    const row = this.db.prepare("SELECT root_message_id FROM sessions WHERE session_card_message_id=?").get(messageId) as { root_message_id?: string } | undefined;
    return row?.root_message_id ? this.getSessionByRoot(row.root_message_id) : null;
  }

  setSessionRoot(sessionId: string, rootMessageId: string, rootAppLink: string | null = null, chatId: string | null = null, threadId: string | null = null): void {
    this.db.prepare("UPDATE sessions SET root_message_id=?,root_app_link=?,chat_id=COALESCE(?,chat_id),thread_id=COALESCE(?,thread_id),updated_at=CURRENT_TIMESTAMP WHERE session_id=?")
      .run(rootMessageId, rootAppLink, chatId, threadId, sessionId);
  }

  setSessionLink(sessionId: string, rootAppLink: string): void {
    this.db.prepare("UPDATE sessions SET root_app_link=?,updated_at=CURRENT_TIMESTAMP WHERE session_id=?").run(rootAppLink, sessionId);
  }

  setSessionModel(sessionId: string, model: string | null, reasoningEffort: string | null): void {
    this.db.prepare("UPDATE sessions SET model=?,reasoning_effort=?,updated_at=CURRENT_TIMESTAMP WHERE session_id=?")
      .run(model, reasoningEffort, sessionId);
  }

  setSessionTitle(sessionId: string, title: string | null, preview?: string): void {
    this.db.prepare("UPDATE sessions SET title=CASE WHEN ?<>'' THEN ? ELSE title END, first_user_text=CASE WHEN ?<>'' THEN ? ELSE first_user_text END, updated_at=CURRENT_TIMESTAMP WHERE session_id=?")
      .run(title ?? "", title ?? "", preview ?? "", preview ?? "", sessionId);
  }

  setSessionLifecycle(sessionId: string, lifecycle: NonNullable<SessionMetadata["lifecycle"]>, updatedAtMs = Date.now()): void {
    this.db.prepare("UPDATE sessions SET lifecycle=?,lifecycle_updated_at_ms=?,updated_at=CURRENT_TIMESTAMP WHERE session_id=? AND lifecycle_updated_at_ms<=?")
      .run(lifecycle, updatedAtMs, sessionId, updatedAtMs);
  }

  setCollaborationMode(sessionId: string, mode: "default" | "plan"): void {
    this.db.prepare("UPDATE sessions SET collaboration_mode=?,updated_at=CURRENT_TIMESTAMP WHERE session_id=?").run(mode, sessionId);
  }

  setSessionPath(sessionId: string, path: string): void {
    this.db.prepare("UPDATE sessions SET path=?,updated_at=CURRENT_TIMESTAMP WHERE session_id=?").run(path, sessionId);
  }

  listSessions(): Array<SessionMetadata & { rootMessageId: string | null; rootAppLink: string | null; chatId: string | null; threadId: string | null; sessionCardMessageId: string | null }> {
    return (this.db.prepare("SELECT session_id FROM sessions ORDER BY started_at").all() as Array<{ session_id: string }>)
      .map((row) => this.getSession(row.session_id)!).filter(Boolean);
  }

  listRecentSessions(limit = 10, search = "", offset = 0): Array<SessionMetadata & { rootMessageId: string | null; rootAppLink: string | null; chatId: string | null; threadId: string | null; sessionCardMessageId: string | null }> {
    const terms = [...search.trim()].slice(0, 120).join("").split(/\s+/).filter(Boolean).slice(0, 8);
    const clauses = terms.map(() => "(cwd LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR first_user_text LIKE ? ESCAPE '\\' OR substr(session_id,1,8) LIKE ? ESCAPE '\\')");
    const params = terms.flatMap((term) => {
      const pattern = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
      return [pattern, pattern, pattern, pattern];
    });
    return (this.db.prepare(`SELECT session_id FROM sessions WHERE ${clauses.length ? clauses.join(" AND ") : "1=1"} ORDER BY started_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as Array<{ session_id: string }>)
      .map((row) => this.getSession(row.session_id)!).filter(Boolean);
  }

  hasMoreRecentSessions(search: string, offset: number, shown: number): boolean {
    const terms = [...search.trim()].slice(0, 120).join("").split(/\s+/).filter(Boolean).slice(0, 8);
    const clauses = terms.map(() => "(cwd LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR first_user_text LIKE ? ESCAPE '\\' OR substr(session_id,1,8) LIKE ? ESCAPE '\\')");
    const params = terms.flatMap((term) => {
      const pattern = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
      return [pattern, pattern, pattern, pattern];
    });
    const row = this.db.prepare(`SELECT COUNT(*) count FROM sessions WHERE ${clauses.length ? clauses.join(" AND ") : "1=1"}`).get(...params) as { count: number };
    return Number(row.count) > offset + shown;
  }

  listRecentDirectories(limit = 8): Array<{ cwd: string; latest: string; count: number }> {
    return this.db.prepare(`SELECT cwd,MAX(started_at) latest,COUNT(*) count FROM sessions
      GROUP BY cwd ORDER BY latest DESC LIMIT ?`).all(limit) as Array<{ cwd: string; latest: string; count: number }>;
  }

  setSessionCardMessage(sessionId: string, messageId: string): void {
    this.db.prepare("UPDATE sessions SET session_card_message_id=?,updated_at=CURRENT_TIMESTAMP WHERE session_id=?").run(messageId, sessionId);
  }

  sessionCardVersion(sessionId: string): number {
    const row = this.db.prepare("SELECT session_card_version FROM sessions WHERE session_id=?").get(sessionId) as { session_card_version?: number } | undefined;
    return Number(row?.session_card_version ?? 1);
  }

  bumpSessionCardVersion(sessionId: string): number {
    this.db.prepare("UPDATE sessions SET session_card_version=session_card_version+1,updated_at=CURRENT_TIMESTAMP WHERE session_id=?").run(sessionId);
    return this.sessionCardVersion(sessionId);
  }

  setRunStatus(sessionId: string, state: string, detail: string, messageId: string | null = null): void {
    this.db.prepare(`INSERT INTO run_status(session_id,message_id,state,detail,updated_at_ms) VALUES(?,?,?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET message_id=COALESCE(excluded.message_id,run_status.message_id),state=excluded.state,detail=excluded.detail,updated_at_ms=excluded.updated_at_ms`)
      .run(sessionId, messageId, state, detail, Date.now());
  }

  upsertAppServerDelivery(delivery: { sessionId: string; turnId: string; role: string; startedAtMs?: number | null; endedAtMs?: number | null; contentHash: string; contentBytes: number; feishuMessageId?: string | null; sourceMessageId?: string | null; sourcePath?: string | null }): void {
    this.db.prepare("INSERT INTO app_server_deliveries(session_id,turn_id,role,started_at_ms,ended_at_ms,content_hash,content_bytes,feishu_message_id,source_message_id,source_path,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id,turn_id,role) DO UPDATE SET started_at_ms=COALESCE(excluded.started_at_ms,app_server_deliveries.started_at_ms),ended_at_ms=COALESCE(excluded.ended_at_ms,app_server_deliveries.ended_at_ms),content_hash=excluded.content_hash,content_bytes=excluded.content_bytes,feishu_message_id=COALESCE(excluded.feishu_message_id,app_server_deliveries.feishu_message_id),source_message_id=COALESCE(excluded.source_message_id,app_server_deliveries.source_message_id),source_path=COALESCE(excluded.source_path,app_server_deliveries.source_path),updated_at_ms=excluded.updated_at_ms").run(delivery.sessionId, delivery.turnId, delivery.role, delivery.startedAtMs ?? null, delivery.endedAtMs ?? null, delivery.contentHash, delivery.contentBytes, delivery.feishuMessageId ?? null, delivery.sourceMessageId ?? null, delivery.sourcePath ?? null, Date.now(), Date.now());
  }
  findAppServerDelivery(sessionId: string, role: string, contentHash: string): { turnId: string; feishuMessageId: string | null } | null {
    let row = this.db.prepare("SELECT turn_id,feishu_message_id FROM app_server_deliveries WHERE session_id=? AND role=? AND content_hash=? ORDER BY updated_at_ms DESC LIMIT 1").get(sessionId, role, contentHash) as { turn_id?: string; feishu_message_id?: string } | undefined;
    if (!row?.feishu_message_id && role === "assistant") {
      row = this.db.prepare("SELECT i.turn_id,i.feishu_message_id FROM turn_items i JOIN turn_runs r ON r.turn_id=i.turn_id WHERE r.session_id=? AND i.kind='agentMessage' AND i.feishu_message_id IS NOT NULL AND json_extract(i.payload,'$.assistantTextHash')=? ORDER BY i.updated_at_ms DESC LIMIT 1")
        .get(sessionId, contentHash) as { turn_id?: string; feishu_message_id?: string } | undefined;
    }
    return row?.turn_id ? { turnId: row.turn_id, feishuMessageId: row.feishu_message_id ? String(row.feishu_message_id) : null } : null;
  }

  getRunStatus(sessionId: string): { messageId: string | null; state: string; detail: string; updatedAtMs: number } | null {
    const row = this.db.prepare("SELECT message_id,state,detail,updated_at_ms FROM run_status WHERE session_id=?").get(sessionId) as Record<string, unknown> | undefined;
    return row ? { messageId: row.message_id ? String(row.message_id) : null, state: String(row.state), detail: String(row.detail), updatedAtMs: Number(row.updated_at_ms) } : null;
  }

  saveTurn(turn: TurnState): void {
    const stream = turn.stream ? JSON.stringify(turn.stream) : null;
    this.db.prepare(`INSERT INTO turn_runs(turn_id,session_id,epoch,mode,state,root_message_id,text,plan,stream_json,started_at_ms,ended_at_ms,input_hash,final_output_hash,created_at_ms,updated_at_ms)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(turn_id) DO UPDATE SET state=excluded.state,text=excluded.text,plan=excluded.plan,stream_json=excluded.stream_json,ended_at_ms=COALESCE(excluded.ended_at_ms,turn_runs.ended_at_ms),final_output_hash=COALESCE(excluded.final_output_hash,turn_runs.final_output_hash),updated_at_ms=excluded.updated_at_ms`)
      .run(turn.turnId, turn.sessionId, turn.epoch, turn.mode, turn.state, turn.rootMessageId, turn.text, turn.plan, stream, turn.startedAtMs ?? Date.now(), turn.endedAtMs ?? null, turn.inputHash ?? null, turn.finalOutputHash ?? null, Date.now(), Date.now());
  }

  getTurn(turnId: string): TurnState | null {
    const row = this.db.prepare("SELECT * FROM turn_runs WHERE turn_id=?").get(turnId) as Record<string, unknown> | undefined;
    if (!row) return null;
    let stream: TurnState["stream"];
    try { stream = row.stream_json ? JSON.parse(String(row.stream_json)) as TurnState["stream"] : undefined; } catch { stream = undefined; }
    return { sessionId: String(row.session_id), turnId: String(row.turn_id), epoch: Number(row.epoch),
      mode: row.mode === "plan" ? "plan" : "default", state: String(row.state) as TurnState["state"],
      rootMessageId: String(row.root_message_id), text: String(row.text ?? ""), plan: String(row.plan ?? ""),
      ...(typeof row.started_at_ms === "number" ? { startedAtMs: Number(row.started_at_ms) } : {}), ...(typeof row.ended_at_ms === "number" ? { endedAtMs: Number(row.ended_at_ms) } : {}),
      ...(row.input_hash ? { inputHash: String(row.input_hash) } : {}), ...(row.final_output_hash ? { finalOutputHash: String(row.final_output_hash) } : {}), ...(stream ? { stream } : {}) };
  }

  activeTurn(sessionId: string): TurnState | null {
    const row = this.db.prepare("SELECT turn_id FROM turn_runs WHERE session_id=? AND state IN ('running','awaiting_input','awaiting_approval') ORDER BY updated_at_ms DESC LIMIT 1").get(sessionId) as { turn_id?: string } | undefined;
    return row?.turn_id ? this.getTurn(row.turn_id) : null;
  }

  latestTurn(sessionId: string): TurnState | null {
    const row = this.db.prepare("SELECT turn_id FROM turn_runs WHERE session_id=? ORDER BY COALESCE(ended_at_ms,updated_at_ms) DESC LIMIT 1").get(sessionId) as { turn_id?: string } | undefined;
    return row?.turn_id ? this.getTurn(row.turn_id) : null;
  }

  private reviewPayload(payload: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    if (typeof payload.assistantTextHash === "string" && /^[a-f0-9]{64}$/.test(payload.assistantTextHash)) result.assistantTextHash = payload.assistantTextHash;
    if (typeof payload.type === "string") result.type = payload.type.slice(0, 120);
    if (typeof payload.status === "string") result.status = payload.status.slice(0, 80);
    if (typeof payload.command === "string") result.command = payload.command.replace(/(?:authorization|cookie|token|password|secret|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[REDACTED]").slice(0, 200);
    if (typeof payload.reason === "string") result.reason = payload.reason.replace(/\s+/g, " ").slice(0, 300);
    if (typeof payload.summary === "string") result.summary = payload.summary.replace(/(?:authorization|cookie|token|password|secret|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[REDACTED]").slice(0, 500);
    if (typeof payload.aggregatedOutput === "string") result.aggregatedOutput = payload.aggregatedOutput.replace(/(?:authorization|cookie|token|password|secret|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[REDACTED]").slice(0, 2_000);
    if (Array.isArray(payload.changes)) result.changes = payload.changes.filter((item): item is string => typeof item === "string").slice(0, 50).map((item) => item.split(/[\\/]/).pop()!.slice(0, 160));
    if (Array.isArray(payload.permissionKinds)) result.permissionKinds = payload.permissionKinds.filter((item): item is string => typeof item === "string").slice(0, 20);
    if (typeof payload.mcpServer === "string") result.mcpServer = payload.mcpServer.slice(0, 120);
    return result;
  }
  saveTurnItem(turnId: string, itemId: string, kind: string, status: string, payload: Record<string, unknown>, feishuMessageId: string | null = null): void {
    this.db.prepare(`INSERT INTO turn_items(turn_id,item_id,kind,status,payload,feishu_message_id,updated_at_ms) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(turn_id,item_id) DO UPDATE SET kind=excluded.kind,status=excluded.status,payload=excluded.payload,feishu_message_id=COALESCE(excluded.feishu_message_id,turn_items.feishu_message_id),updated_at_ms=excluded.updated_at_ms`)
      .run(turnId, itemId, kind, status, JSON.stringify(this.reviewPayload(payload)), feishuMessageId, Date.now());
  }

  listTurnItems(turnId: string): Array<{ itemId: string; kind: string; status: string; payload: Record<string, unknown> }> {
    return (this.db.prepare("SELECT item_id,kind,status,payload FROM turn_items WHERE turn_id=? ORDER BY updated_at_ms").all(turnId) as Array<Record<string, unknown>>).map((row) => {
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(String(row.payload)) as Record<string, unknown>; } catch { /* corrupt data remains safely empty */ }
      return { itemId: String(row.item_id), kind: String(row.kind), status: String(row.status), payload };
    });
  }

  setTurnAssistantDelivery(turnId: string, messageId: string): void {
    this.db.prepare("UPDATE turn_items SET feishu_message_id=?,updated_at_ms=? WHERE turn_id=? AND kind='agentMessage' AND status='completed'")
      .run(messageId, Date.now(), turnId);
  }

  saveServerRequest(request: PendingServerRequest): void {
    this.db.prepare(`INSERT INTO server_requests(nonce,rpc_id_json,epoch,type,session_id,turn_id,item_id,open_id,chat_id,root_message_id,card_message_id,payload,status,expires_at_ms,created_at_ms,updated_at_ms)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(nonce) DO UPDATE SET card_message_id=excluded.card_message_id,status=excluded.status,updated_at_ms=excluded.updated_at_ms`)
      .run(request.nonce, JSON.stringify(request.rpcId), request.epoch, request.type, request.sessionId, request.turnId, request.itemId,
        request.openId, request.chatId, request.rootMessageId, request.cardMessageId, JSON.stringify(request.payload), request.status,
        request.expiresAt, Date.now(), Date.now());
  }

  getServerRequest(nonce: string): PendingServerRequest | null {
    const row = this.db.prepare("SELECT * FROM server_requests WHERE nonce=?").get(nonce) as Record<string, unknown> | undefined;
    if (!row) return null;
    try {
      return { nonce: String(row.nonce), rpcId: JSON.parse(String(row.rpc_id_json)) as string | number, epoch: Number(row.epoch),
        type: String(row.type) as PendingServerRequest["type"], sessionId: String(row.session_id), turnId: row.turn_id ? String(row.turn_id) : null,
        itemId: row.item_id ? String(row.item_id) : null, openId: String(row.open_id), chatId: String(row.chat_id), rootMessageId: String(row.root_message_id),
        cardMessageId: row.card_message_id ? String(row.card_message_id) : null, payload: JSON.parse(String(row.payload)) as Record<string, unknown>,
        status: String(row.status) as PendingServerRequest["status"], expiresAt: Number(row.expires_at_ms) };
    } catch { return null; }
  }

  hasServerRequestForItem(sessionId: string, itemId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM server_requests WHERE session_id=? AND item_id=? LIMIT 1").get(sessionId, itemId));
  }

  nextServerRequest(sessionId: string, type?: PendingServerRequest["type"]): PendingServerRequest | null {
    const row = this.db.prepare(`SELECT nonce FROM server_requests WHERE session_id=? AND status='pending'${type ? " AND type=?" : ""} ORDER BY created_at_ms LIMIT 1`)
      .get(...(type ? [sessionId, type] : [sessionId])) as { nonce?: string } | undefined;
    return row?.nonce ? this.getServerRequest(row.nonce) : null;
  }

  claimServerRequest(nonce: string, openId: string, chatId: string, epoch: number): PendingServerRequest | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const request = this.getServerRequest(nonce);
      if (!request || request.status !== "pending" || request.openId !== openId || request.chatId !== chatId || request.epoch !== epoch || request.expiresAt <= Date.now()) {
        this.db.exec("COMMIT"); return null;
      }
      this.db.prepare("UPDATE server_requests SET status='submitting',updated_at_ms=? WHERE nonce=? AND status='pending'").run(Date.now(), nonce);
      this.db.exec("COMMIT");
      return { ...request, status: "submitting" };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  /**
   * Claims a request whose answer time is up, so the timeout can decline it. Unlike a person's
   * claim it ignores the expiry (which has passed by definition); only a still-pending request is taken.
   */
  timeOutServerRequest(nonce: string): PendingServerRequest | null {
    const changed = this.db.prepare("UPDATE server_requests SET status='submitting',updated_at_ms=? WHERE nonce=? AND status='pending'").run(Date.now(), nonce);
    if (Number(changed.changes) !== 1) return null;
    const request = this.getServerRequest(nonce);
    return request ? { ...request, status: "submitting" } : null;
  }

  setServerRequestCard(nonce: string, cardMessageId: string): void {
    this.db.prepare("UPDATE server_requests SET card_message_id=?,updated_at_ms=? WHERE nonce=?").run(cardMessageId, Date.now(), nonce);
  }

  setServerRequestStatus(nonce: string, status: PendingServerRequest["status"]): void {
    this.db.prepare("UPDATE server_requests SET status=?,updated_at_ms=? WHERE nonce=?").run(status, Date.now(), nonce);
  }

  resolveServerRequestsByRpcId(rpcId: string | number, epoch: number): PendingServerRequest[] {
    // The id may come back as a number or as its string form.
    const encoded = JSON.stringify(rpcId);
    const alternative = typeof rpcId === "number" ? JSON.stringify(String(rpcId)) : /^-?\d+$/.test(rpcId) ? rpcId : encoded;
    const rows = this.db.prepare("SELECT nonce FROM server_requests WHERE rpc_id_json IN (?,?) AND epoch=? AND status IN ('pending','submitting')").all(encoded, alternative, epoch) as Array<{ nonce: string }>;
    this.db.prepare("UPDATE server_requests SET status='resolved',updated_at_ms=? WHERE rpc_id_json IN (?,?) AND epoch=? AND status IN ('pending','submitting')").run(Date.now(), encoded, alternative, epoch);
    return rows.flatMap((row) => this.getServerRequest(row.nonce) ? [this.getServerRequest(row.nonce)!] : []);
  }

  expireServerRequests(epoch?: number): PendingServerRequest[] {
    const rows = this.db.prepare(`SELECT nonce FROM server_requests WHERE status IN ('pending','submitting')${epoch === undefined ? "" : " AND epoch=?"}`).all(...(epoch === undefined ? [] : [epoch])) as Array<{ nonce: string }>;
    this.db.prepare(`UPDATE server_requests SET status='expired',updated_at_ms=? WHERE status IN ('pending','submitting')${epoch === undefined ? "" : " AND epoch=?"}`).run(Date.now(), ...(epoch === undefined ? [] : [epoch]));
    return rows.flatMap((row) => this.getServerRequest(row.nonce) ? [this.getServerRequest(row.nonce)!] : []);
  }

  /** Old session-wide grants are deliberately invalid after every restart. */
  cancelServerRequestsForSession(sessionId: string): PendingServerRequest[] {
    const rows = this.db.prepare("SELECT nonce FROM server_requests WHERE session_id=? AND status IN ('pending','submitting')").all(sessionId) as Array<{ nonce: string }>;
    this.db.prepare("UPDATE server_requests SET status='declined',updated_at_ms=? WHERE session_id=? AND status IN ('pending','submitting')").run(Date.now(), sessionId);
    return rows.flatMap(({ nonce }) => this.getServerRequest(nonce) ? [this.getServerRequest(nonce)!] : []);
  }

  revokeLegacyRootGrants(): void { this.db.prepare("DELETE FROM root_grants").run(); }

  private taskRootGrantFromRow(row: Record<string, unknown>): TaskRootGrant {
    return { nonce: String(row.nonce), taskId: String(row.task_id), sessionId: row.session_id ? String(row.session_id) : null,
      taskFingerprint: String(row.task_fingerprint), canonicalCwd: String(row.canonical_cwd), openId: String(row.open_id), chatId: String(row.chat_id),
      epoch: Number(row.epoch), expiresAt: Number(row.expires_at_ms), status: String(row.status) as TaskRootGrant["status"] };
  }

  createTaskRootGrant(grant: Omit<TaskRootGrant, "status">): TaskRootGrant {
    this.db.prepare("INSERT INTO task_root_grants(nonce,task_id,session_id,task_fingerprint,canonical_cwd,open_id,chat_id,epoch,expires_at_ms,status,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?)")
      .run(grant.nonce, grant.taskId, grant.sessionId, grant.taskFingerprint, grant.canonicalCwd, grant.openId, grant.chatId, grant.epoch, grant.expiresAt, Date.now(), Date.now());
    this.db.prepare("UPDATE task_queue SET root_grant_nonce=?,updated_at_ms=? WHERE id=?").run(grant.nonce, Date.now(), grant.taskId);
    return { ...grant, status: "pending" };
  }

  getTaskRootGrant(nonce: string): TaskRootGrant | null {
    const row = this.db.prepare("SELECT * FROM task_root_grants WHERE nonce=?").get(nonce) as Record<string, unknown> | undefined;
    return row ? this.taskRootGrantFromRow(row) : null;
  }

  getTaskRootGrantForTask(taskId: string): TaskRootGrant | null {
    const row = this.db.prepare("SELECT * FROM task_root_grants WHERE task_id=?").get(taskId) as Record<string, unknown> | undefined;
    return row ? this.taskRootGrantFromRow(row) : null;
  }

  approveTaskRootGrant(nonce: string, openId: string, chatId: string, epoch: number): TaskRootGrant | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT * FROM task_root_grants WHERE nonce=? AND status='pending' AND open_id=? AND chat_id=? AND epoch=? AND expires_at_ms>?").get(nonce, openId, chatId, epoch, Date.now()) as Record<string, unknown> | undefined;
      if (!row) { this.db.exec("COMMIT"); return null; }
      this.db.prepare("UPDATE task_root_grants SET status='approved',updated_at_ms=? WHERE nonce=? AND status='pending'").run(Date.now(), nonce);
      this.db.prepare("UPDATE task_queue SET status=CASE WHEN kind='new' THEN 'authorized' ELSE 'pending' END,phase=CASE WHEN kind='new' THEN 'authorized' ELSE phase END,updated_at_ms=? WHERE id=? AND status='awaiting_root_consent'").run(Date.now(), String(row.task_id));
      this.db.exec("COMMIT");
      return this.getTaskRootGrant(nonce);
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  consumeTaskRootGrant(taskId: string, sessionId: string | null, canonicalCwd: string, epoch: number, taskFingerprint?: string): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare("UPDATE task_root_grants SET status='consumed',updated_at_ms=? WHERE task_id=? AND session_id IS ? AND canonical_cwd=? AND epoch=? AND status='approved' AND expires_at_ms>? AND (? IS NULL OR task_fingerprint=?)")
        .run(Date.now(), taskId, sessionId, canonicalCwd, epoch, Date.now(), taskFingerprint ?? null, taskFingerprint ?? null);
      this.db.exec("COMMIT");
      return result.changes === 1;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  beginNewTaskCreation(taskId: string, taskFingerprint: string, canonicalCwd: string, epoch: number, attemptId: string, now = Date.now()): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const grant = this.db.prepare("SELECT 1 FROM task_root_grants WHERE task_id=? AND session_id IS NULL AND task_fingerprint=? AND canonical_cwd=? AND epoch=? AND status='approved' AND expires_at_ms>?").get(taskId, taskFingerprint, canonicalCwd, epoch, now);
      const task = this.db.prepare("SELECT 1 FROM task_queue WHERE id=? AND kind='new' AND session_id IS NULL AND status='authorized' AND task_fingerprint=?").get(taskId, taskFingerprint);
      if (!grant || !task) { this.db.exec("COMMIT"); return false; }
      this.db.prepare("UPDATE task_root_grants SET status='consumed',updated_at_ms=? WHERE task_id=? AND status='approved'").run(now, taskId);
      this.db.prepare("UPDATE task_queue SET status='creating_thread',phase='creating_thread',creation_attempt_id=?,creation_started_at_ms=?,updated_at_ms=? WHERE id=? AND status='authorized'").run(attemptId, now, now, taskId);
      this.db.exec("COMMIT"); return true;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  persistCreatedSession(taskId: string, session: SessionMetadata): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const task = this.db.prepare("SELECT 1 FROM task_queue WHERE id=? AND kind='new' AND session_id IS NULL AND status='creating_thread'").get(taskId);
      if (!task) { this.db.exec("COMMIT"); return false; }
      this.upsertSession({ ...session, lifecycle: "active", lifecycleUpdatedAtMs: Date.now(), createdByTaskId: taskId });
      this.db.prepare("UPDATE task_queue SET session_id=?,expected_session_id=?,status='thread_created',phase='thread_created',updated_at_ms=? WHERE id=? AND session_id IS NULL AND status='creating_thread'").run(session.sessionId, session.sessionId, Date.now(), taskId);
      this.db.exec("COMMIT"); return true;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  denyTaskRootGrant(nonce: string, openId: string, chatId: string, epoch: number, status: "denied" | "cancelled" = "denied"): TaskRootGrant | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT * FROM task_root_grants WHERE nonce=? AND status IN ('pending','approved') AND open_id=? AND chat_id=? AND epoch=?").get(nonce, openId, chatId, epoch) as Record<string, unknown> | undefined;
      if (!row) { this.db.exec("COMMIT"); return null; }
      this.db.prepare("UPDATE task_root_grants SET status=?,updated_at_ms=? WHERE nonce=?").run(status, Date.now(), nonce);
      this.db.prepare("UPDATE task_queue SET status='cancelled',terminal_reason='Root authorization was declined',updated_at_ms=? WHERE id=? AND status NOT IN ('completed','failed','cancelled','interrupted','expired')").run(Date.now(), String(row.task_id));
      this.db.exec("COMMIT");
      return this.getTaskRootGrant(nonce);
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  expireTaskRootGrants(epoch?: number): TaskRootGrant[] {
    const rows = this.db.prepare("SELECT * FROM task_root_grants WHERE status IN ('pending','approved') AND (expires_at_ms<=? OR epoch<>?)").all(Date.now(), epoch ?? -1) as Record<string, unknown>[];
    if (!rows.length) return [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        this.db.prepare("UPDATE task_root_grants SET status='expired',updated_at_ms=? WHERE nonce=? AND status IN ('pending','approved')").run(Date.now(), String(row.nonce));
        this.db.prepare("UPDATE task_queue SET status='cancelled',terminal_reason='Root authorization expired',updated_at_ms=? WHERE id=? AND status IN ('awaiting_root_consent','authorized')").run(Date.now(), String(row.task_id));
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return rows.map((row) => ({ ...this.taskRootGrantFromRow(row), status: "expired" }));
  }

  enqueueTask(task: QueuedTask): boolean {
    const result = this.db.prepare(`INSERT OR IGNORE INTO task_queue(
      id,kind,session_id,cwd,prompt,image_keys,source_message_id,chat_id,root_message_id,model,reasoning_effort,status,run_card_message_id,expected_session_id,sync_status,last_sync_offset,turn_id,engine,root_grant_nonce,terminal_reason,phase,task_fingerprint,creation_attempt_id,creation_started_at_ms,retry_count,next_attempt_at_ms,expires_at_ms,action_nonce,unarchive_approved,created_at_ms,updated_at_ms
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      task.id, task.kind, task.sessionId, task.cwd, task.prompt, JSON.stringify(task.imageKeys), task.sourceMessageId,
      task.chatId, task.rootMessageId, task.model, task.reasoningEffort, task.status, task.runCardMessageId,
      task.expectedSessionId, task.syncStatus, task.lastSyncOffset, task.turnId ?? null, "app_server", task.rootGrantNonce ?? null, task.terminalReason ?? null, task.phase ?? null, task.taskFingerprint ?? null,
      task.creationAttemptId ?? null, task.creationStartedAtMs ?? null, task.retryCount ?? 0, task.nextAttemptAtMs ?? null, task.expiresAtMs ?? null, task.actionNonce ?? null, task.unarchiveApproved ? 1 : 0, Date.now(), Date.now(),
    );
    return result.changes > 0;
  }

  getTask(id: string): QueuedTask | null {
    const row = this.db.prepare("SELECT * FROM task_queue WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return row ? this.taskFromRow(row) : null;
  }

  claimNextTask(sessionId: string | null): QueuedTask | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const query = sessionId === null
        ? "SELECT * FROM task_queue WHERE session_id IS NULL AND status IN ('pending','authorized','thread_created') AND (next_attempt_at_ms IS NULL OR next_attempt_at_ms<=strftime('%s','now')*1000) ORDER BY created_at_ms LIMIT 1"
        : "SELECT * FROM task_queue q WHERE q.session_id=? AND q.status IN ('pending','authorized','thread_created') AND (q.next_attempt_at_ms IS NULL OR q.next_attempt_at_ms<=strftime('%s','now')*1000) AND NOT EXISTS (SELECT 1 FROM task_queue older WHERE older.session_id=q.session_id AND older.status IN ('awaiting_writer','awaiting_unarchive','awaiting_root_consent','authorized','creating_thread','thread_created','starting_turn','creation_uncertain','awaiting_input','awaiting_approval') AND (older.created_at_ms<q.created_at_ms OR (older.created_at_ms=q.created_at_ms AND older.id<q.id))) ORDER BY q.created_at_ms,q.id LIMIT 1";
      const row = (sessionId === null ? this.db.prepare(query).get() : this.db.prepare(query).get(sessionId)) as Record<string, unknown> | undefined;
      if (!row) { this.db.exec("COMMIT"); return null; }
      this.db.prepare("UPDATE task_queue SET status=CASE WHEN status='pending' THEN 'running' ELSE status END,updated_at_ms=? WHERE id=? AND status IN ('pending','authorized','thread_created')").run(Date.now(), String(row.id));
      this.db.exec("COMMIT");
      return this.getTask(String(row.id));
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  updateTask(id: string, status: QueuedTask["status"], details: {
    error?: string | null; runCardMessageId?: string | null; expectedSessionId?: string | null;
    syncStatus?: QueuedTask["syncStatus"]; lastSyncOffset?: number | null; turnId?: string | null; sessionId?: string | null; terminalReason?: string | null;
    phase?: string | null; taskFingerprint?: string | null; creationAttemptId?: string | null; creationStartedAtMs?: number | null; retryCount?: number; nextAttemptAtMs?: number | null; expiresAtMs?: number | null; actionNonce?: string | null; unarchiveApproved?: boolean;
  } = {}): void {
    const current = this.getTask(id);
    if (current && ["completed", "failed", "cancelled", "interrupted", "expired"].includes(current.status) && current.status !== status) return;
    this.db.prepare(`UPDATE task_queue SET status=?,error=COALESCE(?,error),terminal_reason=COALESCE(?,terminal_reason),run_card_message_id=COALESCE(?,run_card_message_id),
      session_id=COALESCE(?,session_id),expected_session_id=COALESCE(?,expected_session_id),sync_status=COALESCE(?,sync_status),last_sync_offset=COALESCE(?,last_sync_offset),turn_id=COALESCE(?,turn_id),
      phase=COALESCE(?,phase),task_fingerprint=COALESCE(?,task_fingerprint),creation_attempt_id=COALESCE(?,creation_attempt_id),creation_started_at_ms=COALESCE(?,creation_started_at_ms),
      retry_count=COALESCE(?,retry_count),next_attempt_at_ms=COALESCE(?,next_attempt_at_ms),expires_at_ms=COALESCE(?,expires_at_ms),action_nonce=COALESCE(?,action_nonce),unarchive_approved=COALESCE(?,unarchive_approved),updated_at_ms=? WHERE id=?`)
      .run(status, details.error ?? null, details.terminalReason ?? null, details.runCardMessageId ?? null, details.sessionId ?? null, details.expectedSessionId ?? null,
        details.syncStatus ?? null, details.lastSyncOffset ?? null, details.turnId ?? null, details.phase ?? null, details.taskFingerprint ?? null, details.creationAttemptId ?? null,
        details.creationStartedAtMs ?? null, details.retryCount ?? null, details.nextAttemptAtMs ?? null, details.expiresAtMs ?? null, details.actionNonce ?? null,
        details.unarchiveApproved === undefined ? null : details.unarchiveApproved ? 1 : 0, Date.now(), id);
  }

  attachTaskRunCard(id: string, messageId: string | null): void {
    // Card delivery can complete after a scheduler claim or even task completion.
    // Attaching delivery metadata must never rewind the task state.
    this.db.prepare("UPDATE task_queue SET run_card_message_id=COALESCE(?,run_card_message_id),updated_at_ms=? WHERE id=?")
      .run(messageId, Date.now(), id);
  }

  transitionTask(id: string, status: QueuedTask["status"], details: Parameters<BridgeDatabase["updateTask"]>[2] = {}): boolean {
    const current = this.getTask(id);
    if (!current || ["completed", "failed", "cancelled", "interrupted", "expired"].includes(current.status)) return false;
    this.updateTask(id, status, details);
    return true;
  }

  pendingTaskSessionIds(): Array<string | null> {
    return (this.db.prepare("SELECT DISTINCT session_id FROM task_queue WHERE status IN ('pending','authorized','thread_created')").all() as Array<{ session_id: string | null }>)
      .map((row) => row.session_id);
  }

  deferTaskForWriter(taskId: string, now = Date.now()): QueuedTask | null {
    const current = this.getTask(taskId);
    if (!current || ["completed", "failed", "cancelled", "interrupted", "expired"].includes(current.status)) return current;
    const expiresAt = current.expiresAtMs ?? now + 30 * 60_000;
    if (now >= expiresAt) { this.updateTask(taskId, "expired", { terminalReason: "Local Codex writer did not release the thread within 30 minutes", phase: "expired" }); return this.getTask(taskId); }
    const retryCount = (current.retryCount ?? 0) + 1;
    const delays = [5_000, 10_000, 20_000, 30_000];
    this.updateTask(taskId, "awaiting_writer", { phase: "awaiting_writer", retryCount, nextAttemptAtMs: now + (delays[Math.min(retryCount - 1, delays.length - 1)] ?? 30_000), expiresAtMs: expiresAt });
    return this.getTask(taskId);
  }

  releaseDueWriterTasks(now = Date.now()): Array<string | null> {
    this.db.prepare("UPDATE task_queue SET status='expired',phase='expired',terminal_reason='Local Codex writer did not release the thread within 30 minutes',updated_at_ms=? WHERE status='awaiting_writer' AND expires_at_ms<=?").run(now, now);
    const rows = this.db.prepare("SELECT DISTINCT session_id FROM task_queue WHERE status='awaiting_writer' AND next_attempt_at_ms<=? AND expires_at_ms>?").all(now, now) as Array<{ session_id: string | null }>;
    this.db.prepare("UPDATE task_queue SET status='pending',updated_at_ms=? WHERE status='awaiting_writer' AND next_attempt_at_ms<=? AND expires_at_ms>?").run(now, now, now);
    return rows.map((row) => row.session_id);
  }

  awaitUnarchive(taskId: string, actionNonce: string): QueuedTask | null {
    this.updateTask(taskId, "awaiting_unarchive", { phase: "awaiting_unarchive", actionNonce, unarchiveApproved: false });
    return this.getTask(taskId);
  }

  approveUnarchive(actionNonce: string): QueuedTask | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT id FROM task_queue WHERE action_nonce=? AND status='awaiting_unarchive' AND unarchive_approved=0").get(actionNonce) as { id?: string } | undefined;
      if (!row?.id) { this.db.exec("COMMIT"); return null; }
      this.db.prepare("UPDATE task_queue SET unarchive_approved=1,updated_at_ms=? WHERE id=? AND status='awaiting_unarchive' AND unarchive_approved=0").run(Date.now(), row.id);
      this.db.exec("COMMIT"); return this.getTask(row.id);
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  getTaskByActionNonce(actionNonce: string): QueuedTask | null {
    const row = this.db.prepare("SELECT * FROM task_queue WHERE action_nonce=?").get(actionNonce) as Record<string, unknown> | undefined;
    return row ? this.taskFromRow(row) : null;
  }

  cancelUnarchive(actionNonce: string): QueuedTask | null {
    const task = this.getTaskByActionNonce(actionNonce);
    if (!task || task.status !== "awaiting_unarchive" || task.unarchiveApproved) return null;
    this.updateTask(task.id, "cancelled", { terminalReason: "Unarchive was declined", phase: "cancelled" });
    return this.getTask(task.id);
  }

  repairHistoricalDuplicateNewTask(): Array<NonNullable<ReturnType<BridgeDatabase["getSession"]>>> {
    const taskId = "4bcdfe40-f225-4c76-a888-3f773ff7d6a7";
    const sessionIds = ["01a02f01-f4ba-74e3-aae1-b32726266501", "01a02f02-3c7f-7e82-a490-c272fce922ee"];
    const placeholders = sessionIds.map(() => "?").join(",");
    const turnCount = Number((this.db.prepare(`SELECT COUNT(*) count FROM turn_runs WHERE session_id IN (${placeholders})`).get(...sessionIds) as { count: number }).count);
    const deliveryCount = Number((this.db.prepare(`SELECT COUNT(*) count FROM app_server_deliveries WHERE session_id IN (${placeholders})`).get(...sessionIds) as { count: number }).count);
    if (turnCount || deliveryCount) return [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE task_queue SET status='cancelled',phase='cancelled',terminal_reason='旧版状态机重复创建，提示词未执行',error='legacy duplicate thread creation before Root grant consumption',updated_at_ms=? WHERE id=?").run(Date.now(), taskId);
      for (const sessionId of sessionIds) this.db.prepare("UPDATE sessions SET lifecycle='abandoned',lifecycle_updated_at_ms=?,updated_at=CURRENT_TIMESTAMP WHERE session_id=?").run(Date.now(), sessionId);
      this.db.prepare("UPDATE task_root_grants SET status='cancelled',updated_at_ms=? WHERE task_id=? AND status IN ('pending','approved','expired')").run(Date.now(), taskId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return sessionIds.flatMap((sessionId) => { const session = this.getSession(sessionId); return session ? [session] : []; });
  }

  creationUncertainTasks(): QueuedTask[] {
    return (this.db.prepare("SELECT * FROM task_queue WHERE status='creation_uncertain' AND kind='new' AND session_id IS NULL ORDER BY created_at_ms").all() as Record<string, unknown>[])
      .map((row) => this.taskFromRow(row));
  }

  claimUncertainCreatedSession(taskId: string, session: SessionMetadata): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const task = this.db.prepare("SELECT 1 FROM task_queue WHERE id=? AND kind='new' AND session_id IS NULL AND status='creation_uncertain'").get(taskId);
      const mapped = this.db.prepare("SELECT 1 FROM sessions WHERE session_id=? OR created_by_task_id=?").get(session.sessionId, taskId);
      if (!task || mapped) { this.db.exec("COMMIT"); return false; }
      this.upsertSession({ ...session, lifecycle: "active", lifecycleUpdatedAtMs: Date.now(), createdByTaskId: taskId });
      this.db.prepare("UPDATE task_queue SET session_id=?,expected_session_id=?,status='thread_created',phase='thread_created',error=NULL,next_attempt_at_ms=NULL,updated_at_ms=? WHERE id=? AND status='creation_uncertain' AND session_id IS NULL").run(session.sessionId, session.sessionId, Date.now(), taskId);
      this.db.exec("COMMIT"); return true;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  approvedUnarchiveTasks(): QueuedTask[] {
    return (this.db.prepare("SELECT * FROM task_queue WHERE status='awaiting_unarchive' AND unarchive_approved=1 ORDER BY created_at_ms").all() as Record<string, unknown>[])
      .map((row) => this.taskFromRow(row));
  }

  requeueUnarchivedTask(taskId: string): boolean {
    const result = this.db.prepare("UPDATE task_queue SET status='pending',phase='pending',updated_at_ms=? WHERE id=? AND status='awaiting_unarchive' AND unarchive_approved=1").run(Date.now(), taskId);
    return result.changes === 1;
  }

  awaitingSyncTasks(): QueuedTask[] {
    return (this.db.prepare("SELECT * FROM task_queue WHERE status='awaiting_sync' ORDER BY created_at_ms").all() as Record<string, unknown>[])
      .map((row) => this.taskFromRow(row));
  }

  /** `keepTurnIds`: turns still running in Codex, whose tasks end with the turn rather than here. */
  cancelTasks(rootMessageId: string | null, sessionId: string | null, reason: string, keepTurnIds: readonly string[] = []): QueuedTask[] {
    const query = sessionId
      ? "SELECT * FROM task_queue WHERE session_id=? AND status NOT IN ('completed','failed','cancelled','interrupted','expired')"
      : rootMessageId
        ? "SELECT * FROM task_queue WHERE root_message_id=? AND status NOT IN ('completed','failed','cancelled','interrupted','expired')"
        : "SELECT * FROM task_queue WHERE 1=0";
    const value = sessionId ?? rootMessageId;
    const all = value === null ? this.db.prepare(query).all() as Record<string, unknown>[] : this.db.prepare(query).all(value) as Record<string, unknown>[];
    const rows = all.filter((row) => !(typeof row.turn_id === "string" && keepTurnIds.includes(row.turn_id)));
    if (!rows.length) return [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const ids = rows.map((row) => String(row.id));
      for (const id of ids) {
        this.db.prepare("UPDATE task_queue SET status='cancelled',terminal_reason=?,updated_at_ms=? WHERE id=? AND status NOT IN ('completed','failed','cancelled','interrupted','expired')").run(reason, Date.now(), id);
        this.db.prepare("UPDATE task_root_grants SET status='cancelled',updated_at_ms=? WHERE task_id=? AND status IN ('pending','approved')").run(Date.now(), id);
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return rows.map((row) => this.taskFromRow(row));
  }

  cancelTasksBySession(sessionId: string, reason: string, keepTurnIds: readonly string[] = []): QueuedTask[] { return this.cancelTasks(null, sessionId, reason, keepTurnIds); }
  cancelTasksByRoot(rootMessageId: string, reason: string, keepTurnIds: readonly string[] = []): QueuedTask[] { return this.cancelTasks(rootMessageId, null, reason, keepTurnIds); }
  cancelAllTasks(reason: string): QueuedTask[] {
    const rows = this.db.prepare("SELECT * FROM task_queue WHERE status NOT IN ('completed','failed','cancelled','interrupted','expired')").all() as Record<string, unknown>[];
    if (!rows.length) return [];
    this.db.exec("BEGIN IMMEDIATE");
    try { for (const row of rows) { const id = String(row.id); this.db.prepare("UPDATE task_queue SET status='cancelled',terminal_reason=?,updated_at_ms=? WHERE id=? AND status NOT IN ('completed','failed','cancelled','interrupted','expired')").run(reason, Date.now(), id); this.db.prepare("UPDATE task_root_grants SET status='cancelled',updated_at_ms=? WHERE task_id=? AND status IN ('pending','approved')").run(Date.now(), id); } this.db.exec("COMMIT"); } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return rows.map((row) => this.taskFromRow(row));
  }

  runningTaskForRoot(rootMessageId: string): QueuedTask | null {
    const row = this.db.prepare("SELECT * FROM task_queue WHERE root_message_id=? AND status='running' ORDER BY created_at_ms DESC LIMIT 1").get(rootMessageId) as Record<string, unknown> | undefined;
    return row ? this.taskFromRow(row) : null;
  }

  taskForTurn(turnId: string): QueuedTask | null {
    const row = this.db.prepare("SELECT * FROM task_queue WHERE turn_id=? ORDER BY updated_at_ms DESC LIMIT 1").get(turnId) as Record<string, unknown> | undefined;
    return row ? this.taskFromRow(row) : null;
  }

  resumeRootTasks(sessionId: string): void {
    this.db.prepare("UPDATE task_queue SET status='pending',updated_at_ms=? WHERE session_id=? AND status='awaiting_root_consent'").run(Date.now(), sessionId);
  }

  recoverCreatingThreadsAsUncertain(): number {
    const result = this.db.prepare("UPDATE task_queue SET status='creation_uncertain',phase='creation_uncertain',terminal_reason='bridge restarted while thread/start result was unresolved',updated_at_ms=? WHERE status='creating_thread' AND session_id IS NULL").run(Date.now());
    return Number(result.changes);
  }

  markRunningTasksInterrupted(): QueuedTask[] {
    const rows = this.db.prepare("SELECT * FROM task_queue WHERE status IN ('running','starting_turn','awaiting_input','awaiting_approval')").all() as Record<string, unknown>[];
    this.db.prepare("UPDATE task_queue SET status='interrupted',terminal_reason='app-server lifecycle ended',updated_at_ms=? WHERE status IN ('running','starting_turn','awaiting_input','awaiting_approval')").run(Date.now());
    return rows.map((row) => this.taskFromRow(row));
  }

  taskStateCounts(): Record<string, number> {
    const rows = this.db.prepare("SELECT status,COUNT(*) AS count FROM task_queue GROUP BY status").all() as Array<{ status: string; count: number }>;
    return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
  }

  cancelTask(id: string): void { this.updateTask(id, "cancelled"); }

  enqueueChoice(requestId: string, sessionId: string, payload: string): void {
    this.db.prepare("INSERT INTO choice_queue(request_id,session_id,payload,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?) ON CONFLICT(request_id) DO UPDATE SET payload=excluded.payload,updated_at_ms=excluded.updated_at_ms")
      .run(requestId, sessionId, payload, Date.now(), Date.now());
  }

  nextChoice(sessionId: string): { requestId: string; payload: string } | null {
    const row = this.db.prepare("SELECT request_id,payload FROM choice_queue WHERE session_id=? ORDER BY created_at_ms LIMIT 1").get(sessionId) as { request_id: string; payload: string } | undefined;
    return row ? { requestId: row.request_id, payload: row.payload } : null;
  }

  listChoices(sessionId: string): Array<{ requestId: string; payload: string }> {
    return (this.db.prepare("SELECT request_id,payload FROM choice_queue WHERE session_id=? ORDER BY created_at_ms").all(sessionId) as Array<{ request_id: string; payload: string }>)
      .map((row) => ({ requestId: row.request_id, payload: row.payload }));
  }

  deleteChoice(requestId: string): void { this.db.prepare("DELETE FROM choice_queue WHERE request_id=?").run(requestId); }

  claimInboundEvent(eventId: string, leaseMs = 5 * 60_000): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const now = Date.now(); const token = randomUUID();
      const row = this.db.prepare("SELECT status,service_epoch,lease_until_ms FROM inbound_events WHERE event_id=?").get(eventId) as { status?: string; service_epoch?: string; lease_until_ms?: number } | undefined;
      if (row && row.status === "completed" || row?.status === "permanent_failed") { this.db.exec("COMMIT"); return false; }
      const reclaim = !row || row.status === "retryable_failed" || row.status === "processing" && (row.service_epoch !== this.serviceEpoch || Number(row.lease_until_ms ?? 0) <= now);
      if (!reclaim) { this.db.exec("COMMIT"); return false; }
      if (row) this.db.prepare("UPDATE inbound_events SET status='processing',error=NULL,claim_token=?,service_epoch=?,lease_until_ms=?,attempt_count=COALESCE(attempt_count,0)+1,updated_at_ms=? WHERE event_id=?").run(token, this.serviceEpoch, now + leaseMs, now, eventId);
      else this.db.prepare("INSERT INTO inbound_events(event_id,status,claim_token,service_epoch,lease_until_ms,attempt_count,created_at_ms,updated_at_ms) VALUES(?,'processing',?,?,?,1,?,?)").run(eventId, token, this.serviceEpoch, now + leaseMs, now, now);
      this.db.exec("COMMIT"); return true;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  inboundClaimToken(eventId: string): string | null {
    const row = this.db.prepare("SELECT claim_token FROM inbound_events WHERE event_id=? AND status=\'processing\' AND service_epoch=?").get(eventId, this.serviceEpoch) as { claim_token?: string } | undefined;
    return row?.claim_token ? String(row.claim_token) : null;
  }

  recoverStaleInboundEvents(now = Date.now()): number {
    const result = this.db.prepare("UPDATE inbound_events SET status='retryable_failed',error='processing lease expired',updated_at_ms=? WHERE status='processing' AND (lease_until_ms IS NULL OR lease_until_ms<=?)").run(now, now);
    return Number(result.changes);
  }

  completeInboundEvent(eventId: string, claimToken?: string | null): void { this.db.prepare("UPDATE inbound_events SET status='completed',claim_token=NULL,lease_until_ms=NULL,updated_at_ms=? WHERE event_id=? AND status='processing' AND service_epoch=? AND (? IS NULL OR claim_token=? )").run(Date.now(), eventId, this.serviceEpoch, claimToken ?? null, claimToken ?? null); }
  failInboundEvent(eventId: string, error: unknown, retryable: boolean, claimToken?: string | null): void {
    this.db.prepare("UPDATE inbound_events SET status=?,error=?,claim_token=NULL,lease_until_ms=NULL,updated_at_ms=? WHERE event_id=? AND status='processing' AND service_epoch=? AND (? IS NULL OR claim_token=? )")
      .run(retryable ? "retryable_failed" : "permanent_failed", error instanceof Error ? error.message : String(error), Date.now(), eventId, this.serviceEpoch, claimToken ?? null, claimToken ?? null);
  }

  /** Keeps a finished turn's output until Feishu has it; an existing record is left as it is. */
  saveTurnOutput(output: Pick<TurnOutput, "turnId" | "sessionId" | "rootMessageId" | "title" | "summary" | "content"> & { needsFile: boolean }): void {
    this.db.prepare(`INSERT INTO turn_outputs(turn_id,session_id,root_message_id,title,summary,content,card_status,file_status,created_at_ms,updated_at_ms)
      VALUES(?,?,?,?,?,?,'pending',?,?,?) ON CONFLICT(turn_id) DO NOTHING`)
      .run(output.turnId, output.sessionId, output.rootMessageId, output.title, output.summary, output.content, output.needsFile ? "pending" : "none", Date.now(), Date.now());
  }

  getTurnOutput(turnId: string): TurnOutput | null {
    const row = this.db.prepare("SELECT * FROM turn_outputs WHERE turn_id=?").get(turnId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return { turnId: String(row.turn_id), sessionId: String(row.session_id), rootMessageId: String(row.root_message_id), title: String(row.title),
      summary: String(row.summary), content: String(row.content), cardStatus: String(row.card_status) as TurnOutput["cardStatus"],
      cardMessageId: row.card_message_id ? String(row.card_message_id) : null, fileStatus: String(row.file_status) as TurnOutput["fileStatus"],
      fileMessageId: row.file_message_id ? String(row.file_message_id) : null, attempts: Number(row.attempts), lastError: row.last_error ? String(row.last_error) : null };
  }

  /** Records one delivery attempt; once card and file are both sent the stored text is dropped. */
  updateTurnOutput(turnId: string, update: { cardStatus: TurnOutput["cardStatus"]; cardMessageId: string | null; fileStatus: TurnOutput["fileStatus"]; fileMessageId: string | null; error: string | null }): void {
    const done = update.cardStatus === "sent" && (update.fileStatus === "sent" || update.fileStatus === "none");
    this.db.prepare(`UPDATE turn_outputs SET card_status=?,card_message_id=COALESCE(?,card_message_id),file_status=?,file_message_id=COALESCE(?,file_message_id),
      attempts=attempts+1,last_error=?,content=CASE WHEN ? THEN '' ELSE content END,updated_at_ms=? WHERE turn_id=?`)
      .run(update.cardStatus, update.cardMessageId, update.fileStatus, update.fileMessageId, update.error, done ? 1 : 0, Date.now(), turnId);
  }

  /** Outputs never tried, for example because the service stopped while sending them. */
  pendingTurnOutputs(): TurnOutput[] {
    return (this.db.prepare("SELECT turn_id FROM turn_outputs WHERE card_status='pending' OR file_status='pending'").all() as Array<{ turn_id: string }>)
      .flatMap((row) => { const output = this.getTurnOutput(row.turn_id); return output ? [output] : []; });
  }

  /** Whether a logged assistant message belongs to a bridge turn whose output has not yet reached Feishu. */
  hasUndeliveredTurnOutput(sessionId: string, contentHash: string): boolean {
    const row = this.db.prepare(`SELECT 1 FROM turn_outputs o WHERE o.session_id=? AND o.card_status<>'sent' AND (
        EXISTS(SELECT 1 FROM turn_items i WHERE i.turn_id=o.turn_id AND i.kind='agentMessage' AND json_extract(i.payload,'$.assistantTextHash')=?)
        OR EXISTS(SELECT 1 FROM app_server_deliveries d WHERE d.turn_id=o.turn_id AND d.role='assistant' AND d.content_hash=?)) LIMIT 1`).get(sessionId, contentHash, contentHash);
    return Boolean(row);
  }

  pruneRetainedData(now = Date.now()): void {
    const day = 24 * 60 * 60 * 1_000;
    this.db.prepare("DELETE FROM turn_outputs WHERE updated_at_ms<?").run(now - 30 * day);
    this.db.prepare("DELETE FROM task_queue WHERE status IN ('completed','failed','cancelled','interrupted','expired') AND updated_at_ms<?").run(now - 30 * day);
    this.db.prepare("DELETE FROM turn_runs WHERE state IN ('completed','failed','interrupted') AND updated_at_ms<?").run(now - 30 * day);
    this.db.prepare("DELETE FROM app_server_deliveries WHERE updated_at_ms<?").run(now - 30 * day);
    this.db.prepare("DELETE FROM turn_items WHERE turn_id NOT IN (SELECT turn_id FROM turn_runs)").run();
    this.db.prepare("DELETE FROM server_requests WHERE status IN ('resolved','declined','expired') AND updated_at_ms<?").run(now - 7 * day);
    this.db.prepare("DELETE FROM task_root_grants WHERE status NOT IN ('pending','approved') AND updated_at_ms<?").run(now - 7 * day);
    this.db.prepare("DELETE FROM inbound_events WHERE status IN ('completed','retryable_failed') AND updated_at_ms<?").run(now - 7 * day);
    this.db.prepare("DELETE FROM inbound_events WHERE status='permanent_failed' AND updated_at_ms<?").run(now - 30 * day);
    this.db.prepare("DELETE FROM failures WHERE resolved=1 AND updated_at < datetime('now','-30 days')").run();
  }

  hasMessage(messageId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM messages WHERE message_id=?").get(messageId));
  }

  getMessage(messageId: string): { sessionId: string; direction: string; feishuMessageId: string | null; sourcePath: string | null; sourceKind: string | null; recallState: string | null } | null {
    const row = this.db.prepare("SELECT session_id,direction,feishu_message_id,source_path,source_kind,recall_state FROM messages WHERE message_id=?").get(messageId) as Record<string, unknown> | undefined;
    return row ? {
      sessionId: String(row.session_id), direction: String(row.direction),
      feishuMessageId: row.feishu_message_id ? String(row.feishu_message_id) : null,
      sourcePath: row.source_path ? String(row.source_path) : null, sourceKind: row.source_kind ? String(row.source_kind) : null,
      recallState: row.recall_state ? String(row.recall_state) : null,
    } : null;
  }

  deleteMessage(messageId: string): void { this.db.prepare("DELETE FROM messages WHERE message_id=?").run(messageId); }

  markMessageRecalled(messageId: string): void {
    this.db.prepare("UPDATE messages SET recalled_at=CURRENT_TIMESTAMP,recall_state='recalled' WHERE message_id=?").run(messageId);
  }

  listActiveSessionIds(): string[] {
    return (this.db.prepare("SELECT key FROM settings WHERE key LIKE 'session.%.active' AND value='1'").all() as Array<{ key: string }>)
      .flatMap(({ key }) => {
        const match = key.match(/^session\.(.+)\.active$/);
        return match?.[1] ? [match[1]] : [];
      });
  }

  saveMessage(messageId: string, sessionId: string, direction: string, feishuMessageId: string | null, source: { path?: string; kind?: string } = {}): void {
    this.db.prepare("INSERT OR IGNORE INTO messages(message_id,session_id,direction,feishu_message_id,source_path,source_kind) VALUES(?,?,?,?,?,?)")
      .run(messageId, sessionId, direction, feishuMessageId, source.path ?? null, source.kind ?? null);
  }

  recordFailure(operation: string, payload: unknown, error: unknown): void {
    const encoded = JSON.stringify(payload);
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    const existing = this.db.prepare("SELECT id,attempts FROM failures WHERE operation=? AND payload=? AND error=? AND resolved=0 ORDER BY id DESC LIMIT 1").get(operation, encoded, message) as { id: number; attempts: number } | undefined;
    if (existing) this.db.prepare("UPDATE failures SET attempts=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(existing.attempts + 1, existing.id);
    else this.db.prepare("INSERT INTO failures(operation,payload,error) VALUES(?,?,?)").run(operation, encoded, message);
  }

  failureCount(): number {
    const row = this.db.prepare("SELECT COUNT(DISTINCT operation || char(0) || payload) AS count FROM failures WHERE resolved=0").get() as { count: number };
    return Number(row.count);
  }

  resolveFailures(): void {
    this.db.prepare("UPDATE failures SET resolved=1,updated_at=CURRENT_TIMESTAMP WHERE resolved=0").run();
  }

  resolveInfrastructureFailures(): void {
    this.db.prepare("UPDATE failures SET resolved=1,updated_at=CURRENT_TIMESTAMP WHERE resolved=0 AND operation NOT IN ('codex_new','codex_resume')").run();
  }

  resolveFailure(operation: string, payload?: unknown): void {
    if (payload === undefined) {
      this.db.prepare("UPDATE failures SET resolved=1,updated_at=CURRENT_TIMESTAMP WHERE operation=? AND resolved=0").run(operation);
      return;
    }
    this.db.prepare("UPDATE failures SET resolved=1,updated_at=CURRENT_TIMESTAMP WHERE operation=? AND payload=? AND resolved=0")
      .run(operation, JSON.stringify(payload));
  }

  private taskFromRow(row: Record<string, unknown>): QueuedTask {
    let imageKeys: string[] = [];
    try { imageKeys = JSON.parse(String(row.image_keys ?? "[]")) as string[]; } catch { /* malformed persisted task is treated as no image */ }
    return {
      id: String(row.id), kind: String(row.kind) as QueuedTask["kind"], sessionId: row.session_id ? String(row.session_id) : null,
      cwd: String(row.cwd), prompt: String(row.prompt), imageKeys, sourceMessageId: String(row.source_message_id),
      chatId: String(row.chat_id), rootMessageId: row.root_message_id ? String(row.root_message_id) : null,
      model: row.model ? String(row.model) : null, reasoningEffort: row.reasoning_effort ? String(row.reasoning_effort) : null,
      status: String(row.status) as QueuedTask["status"], runCardMessageId: row.run_card_message_id ? String(row.run_card_message_id) : null,
      expectedSessionId: row.expected_session_id ? String(row.expected_session_id) : null,
      syncStatus: (row.sync_status === "awaiting" || row.sync_status === "synced") ? row.sync_status : "none",
      lastSyncOffset: typeof row.last_sync_offset === "number" ? row.last_sync_offset : null,
      turnId: row.turn_id ? String(row.turn_id) : null,
      terminalReason: row.terminal_reason ? String(row.terminal_reason) : null,
      rootGrantNonce: row.root_grant_nonce ? String(row.root_grant_nonce) : null,
      phase: row.phase ? String(row.phase) : null, taskFingerprint: row.task_fingerprint ? String(row.task_fingerprint) : null,
      creationAttemptId: row.creation_attempt_id ? String(row.creation_attempt_id) : null, creationStartedAtMs: row.creation_started_at_ms === null || row.creation_started_at_ms === undefined ? null : Number(row.creation_started_at_ms),
      retryCount: Number(row.retry_count ?? 0), nextAttemptAtMs: row.next_attempt_at_ms === null || row.next_attempt_at_ms === undefined ? null : Number(row.next_attempt_at_ms),
      expiresAtMs: row.expires_at_ms === null || row.expires_at_ms === undefined ? null : Number(row.expires_at_ms), actionNonce: row.action_nonce ? String(row.action_nonce) : null,
      unarchiveApproved: Number(row.unarchive_approved ?? 0) === 1,
    };
  }
}
