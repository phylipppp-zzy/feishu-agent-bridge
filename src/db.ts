import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FileCursor, QueuedTask, SessionMetadata } from "./types.js";

export class BridgeDatabase {
  readonly db: DatabaseSync;

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
    this.ensureColumn("sessions", "chat_id", "TEXT");
    this.ensureColumn("sessions", "thread_id", "TEXT");
    this.ensureColumn("sessions", "session_card_message_id", "TEXT");
    this.ensureColumn("sessions", "session_card_version", "INTEGER NOT NULL DEFAULT 1");
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
    this.migrateTaskQueueStatusConstraint();
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private migrateTaskQueueStatusConstraint(): void {
    const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='task_queue'").get() as { sql?: string } | undefined;
    if (row?.sql?.includes("'awaiting_sync'")) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`ALTER TABLE task_queue RENAME TO task_queue_legacy;
        CREATE TABLE task_queue (
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
        INSERT INTO task_queue(id,kind,session_id,cwd,prompt,image_keys,source_message_id,chat_id,root_message_id,model,reasoning_effort,status,run_card_message_id,expected_session_id,sync_status,last_sync_offset,error,created_at_ms,updated_at_ms)
        SELECT id,kind,session_id,cwd,prompt,image_keys,source_message_id,chat_id,root_message_id,model,reasoning_effort,status,run_card_message_id,expected_session_id,COALESCE(sync_status,'none'),last_sync_offset,error,created_at_ms,updated_at_ms FROM task_queue_legacy;
        DROP TABLE task_queue_legacy;
        CREATE INDEX IF NOT EXISTS task_queue_session_status ON task_queue(session_id,status,created_at_ms);`);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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
    this.db.prepare(`INSERT INTO sessions(session_id,path,cwd,started_at,source,first_user_text,model,reasoning_effort)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET path=excluded.path,cwd=excluded.cwd,
      started_at=excluded.started_at,source=excluded.source,
      first_user_text=CASE WHEN sessions.first_user_text='' THEN excluded.first_user_text ELSE sessions.first_user_text END,
      model=COALESCE(excluded.model,sessions.model),reasoning_effort=COALESCE(excluded.reasoning_effort,sessions.reasoning_effort),
      updated_at=CURRENT_TIMESTAMP`).run(
      session.sessionId, session.path, session.cwd, session.startedAt, session.source, session.firstUserText,
      session.model ?? null, session.reasoningEffort ?? null,
    );
  }

  getSession(sessionId: string): (SessionMetadata & { rootMessageId: string | null; rootAppLink: string | null; chatId: string | null; threadId: string | null; sessionCardMessageId: string | null }) | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE session_id=?").get(sessionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      sessionId: String(row.session_id), path: String(row.path), cwd: String(row.cwd),
      startedAt: String(row.started_at), source: String(row.source), firstUserText: String(row.first_user_text),
      rootMessageId: row.root_message_id ? String(row.root_message_id) : null,
      rootAppLink: row.root_app_link ? String(row.root_app_link) : null,
      chatId: row.chat_id ? String(row.chat_id) : null,
      threadId: row.thread_id ? String(row.thread_id) : null,
      sessionCardMessageId: row.session_card_message_id ? String(row.session_card_message_id) : null,
      model: row.model ? String(row.model) : null,
      reasoningEffort: row.reasoning_effort ? String(row.reasoning_effort) : null,
    };
  }

  getSessionByRoot(rootId: string): (SessionMetadata & { rootMessageId: string; rootAppLink: string | null; chatId: string | null; threadId: string | null; sessionCardMessageId: string | null }) | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE root_message_id=?").get(rootId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      sessionId: String(row.session_id), path: String(row.path), cwd: String(row.cwd),
      startedAt: String(row.started_at), source: String(row.source), firstUserText: String(row.first_user_text),
      rootMessageId: String(row.root_message_id),
      rootAppLink: row.root_app_link ? String(row.root_app_link) : null,
      chatId: row.chat_id ? String(row.chat_id) : null,
      threadId: row.thread_id ? String(row.thread_id) : null,
      sessionCardMessageId: row.session_card_message_id ? String(row.session_card_message_id) : null,
      model: row.model ? String(row.model) : null,
      reasoningEffort: row.reasoning_effort ? String(row.reasoning_effort) : null,
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

  setSessionPath(sessionId: string, path: string): void {
    this.db.prepare("UPDATE sessions SET path=?,updated_at=CURRENT_TIMESTAMP WHERE session_id=?").run(path, sessionId);
  }

  listSessions(): Array<SessionMetadata & { rootMessageId: string | null; rootAppLink: string | null; chatId: string | null; threadId: string | null; sessionCardMessageId: string | null }> {
    return (this.db.prepare("SELECT session_id FROM sessions ORDER BY started_at").all() as Array<{ session_id: string }>)
      .map((row) => this.getSession(row.session_id)!).filter(Boolean);
  }

  listRecentSessions(limit = 10, search = "", offset = 0): Array<SessionMetadata & { rootMessageId: string | null; rootAppLink: string | null; chatId: string | null; threadId: string | null; sessionCardMessageId: string | null }> {
    const terms = [...search.trim()].slice(0, 120).join("").split(/\s+/).filter(Boolean).slice(0, 8);
    const clauses = terms.map(() => "(cwd LIKE ? ESCAPE '\\' OR first_user_text LIKE ? ESCAPE '\\' OR substr(session_id,1,8) LIKE ? ESCAPE '\\')");
    const params = terms.flatMap((term) => {
      const pattern = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
      return [pattern, pattern, pattern];
    });
    return (this.db.prepare(`SELECT session_id FROM sessions WHERE ${clauses.length ? clauses.join(" AND ") : "1=1"} ORDER BY started_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as Array<{ session_id: string }>)
      .map((row) => this.getSession(row.session_id)!).filter(Boolean);
  }

  hasMoreRecentSessions(search: string, offset: number, shown: number): boolean {
    const terms = [...search.trim()].slice(0, 120).join("").split(/\s+/).filter(Boolean).slice(0, 8);
    const clauses = terms.map(() => "(cwd LIKE ? ESCAPE '\\' OR first_user_text LIKE ? ESCAPE '\\' OR substr(session_id,1,8) LIKE ? ESCAPE '\\')");
    const params = terms.flatMap((term) => {
      const pattern = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
      return [pattern, pattern, pattern];
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

  getRunStatus(sessionId: string): { messageId: string | null; state: string; detail: string; updatedAtMs: number } | null {
    const row = this.db.prepare("SELECT message_id,state,detail,updated_at_ms FROM run_status WHERE session_id=?").get(sessionId) as Record<string, unknown> | undefined;
    return row ? { messageId: row.message_id ? String(row.message_id) : null, state: String(row.state), detail: String(row.detail), updatedAtMs: Number(row.updated_at_ms) } : null;
  }

  enqueueTask(task: QueuedTask): boolean {
    const result = this.db.prepare(`INSERT OR IGNORE INTO task_queue(
      id,kind,session_id,cwd,prompt,image_keys,source_message_id,chat_id,root_message_id,model,reasoning_effort,status,run_card_message_id,expected_session_id,sync_status,last_sync_offset,created_at_ms,updated_at_ms
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      task.id, task.kind, task.sessionId, task.cwd, task.prompt, JSON.stringify(task.imageKeys), task.sourceMessageId,
      task.chatId, task.rootMessageId, task.model, task.reasoningEffort, task.status, task.runCardMessageId,
      task.expectedSessionId, task.syncStatus, task.lastSyncOffset, Date.now(), Date.now(),
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
        ? "SELECT * FROM task_queue WHERE session_id IS NULL AND status='pending' ORDER BY created_at_ms LIMIT 1"
        : "SELECT * FROM task_queue WHERE session_id=? AND status='pending' ORDER BY created_at_ms LIMIT 1";
      const row = (sessionId === null ? this.db.prepare(query).get() : this.db.prepare(query).get(sessionId)) as Record<string, unknown> | undefined;
      if (!row) { this.db.exec("COMMIT"); return null; }
      this.db.prepare("UPDATE task_queue SET status='running',updated_at_ms=? WHERE id=? AND status='pending'").run(Date.now(), String(row.id));
      this.db.exec("COMMIT");
      return this.getTask(String(row.id));
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  updateTask(id: string, status: QueuedTask["status"], details: {
    error?: string | null; runCardMessageId?: string | null; expectedSessionId?: string | null;
    syncStatus?: QueuedTask["syncStatus"]; lastSyncOffset?: number | null;
  } = {}): void {
    this.db.prepare(`UPDATE task_queue SET status=?,error=COALESCE(?,error),run_card_message_id=COALESCE(?,run_card_message_id),
      expected_session_id=COALESCE(?,expected_session_id),sync_status=COALESCE(?,sync_status),last_sync_offset=COALESCE(?,last_sync_offset),updated_at_ms=? WHERE id=?`)
      .run(status, details.error ?? null, details.runCardMessageId ?? null, details.expectedSessionId ?? null,
        details.syncStatus ?? null, details.lastSyncOffset ?? null, Date.now(), id);
  }

  pendingTaskSessionIds(): Array<string | null> {
    return (this.db.prepare("SELECT DISTINCT session_id FROM task_queue WHERE status='pending'").all() as Array<{ session_id: string | null }>)
      .map((row) => row.session_id);
  }

  awaitingSyncTasks(): QueuedTask[] {
    return (this.db.prepare("SELECT * FROM task_queue WHERE status='awaiting_sync' ORDER BY created_at_ms").all() as Record<string, unknown>[])
      .map((row) => this.taskFromRow(row));
  }

  cancelPendingTasks(rootMessageId: string | null, sessionId: string | null): number {
    const result = sessionId
      ? this.db.prepare("UPDATE task_queue SET status='cancelled',updated_at_ms=? WHERE session_id=? AND status='pending'").run(Date.now(), sessionId)
      : this.db.prepare("UPDATE task_queue SET status='cancelled',updated_at_ms=? WHERE root_message_id=? AND status='pending'").run(Date.now(), rootMessageId);
    return Number(result.changes);
  }

  runningTaskForRoot(rootMessageId: string): QueuedTask | null {
    const row = this.db.prepare("SELECT * FROM task_queue WHERE root_message_id=? AND status='running' ORDER BY created_at_ms DESC LIMIT 1").get(rootMessageId) as Record<string, unknown> | undefined;
    return row ? this.taskFromRow(row) : null;
  }

  markRunningTasksInterrupted(): QueuedTask[] {
    const rows = this.db.prepare("SELECT * FROM task_queue WHERE status='running'").all() as Record<string, unknown>[];
    this.db.prepare("UPDATE task_queue SET status='interrupted',updated_at_ms=? WHERE status='running'").run(Date.now());
    return rows.map((row) => this.taskFromRow(row));
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

  deleteChoice(requestId: string): void { this.db.prepare("DELETE FROM choice_queue WHERE request_id=?").run(requestId); }

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
    };
  }
}
