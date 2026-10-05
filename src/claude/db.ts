import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TurnView } from "./conversation.js";
import type { TranscriptMeta } from "./transcript.js";

export type PresenceState = "idle" | "running" | "waiting" | "closed";
export type TurnRenderState = "pending" | "hidden";

/** Turns whose stored JSON is at least this long may need a Markdown attachment for their text. */
const ATTACHMENT_HINT_CHARS = 18_000;

export interface ClaudeSession {
  sessionId: string;
  path: string;
  cwd: string | null;
  customTitle: string | null;
  aiTitle: string | null;
  firstPrompt: string | null;
  entrypoint: string | null;
  model: string | null;
  /** Reasoning effort of the latest reply, as Claude Code recorded it. */
  effort: string | null;
  permissionMode: string | null;
  gitBranch: string | null;
  startedAtMs: number;
  lastActivityMs: number;
  rootMessageId: string | null;
  rootAppLink: string | null;
  chatId: string | null;
  currentTurnId: string | null;
  presenceState: PresenceState | null;
  presenceAtMs: number;
  presencePid: number | null;
  presencePidStart: string | null;
  presenceMessage: string | null;
  waitingNotifiedAtMs: number;
  rootDirty: boolean;
  /** The root card currently says the session is outside SYNC_DIRS. */
  rootOutOfScope: boolean;
  /** Permission mode, model and effort chosen in Feishu for the turns it runs; null means the default. */
  prefMode: string | null;
  prefModel: string | null;
  prefEffort: string | null;
  /** The session this one was forked from in Feishu. */
  forkedFrom: string | null;
  readonlyNoticeAtMs: number;
}

export interface StoredTurn {
  turnId: string;
  sessionId: string;
  seq: number;
  view: TurnView;
  renderState: TurnRenderState;
  promptMessageId: string | null;
  cardMessageId: string | null;
  renderedHash: string | null;
  renderedAtMs: number;
  attachmentMessageId: string | null;
}

export interface TranscriptCursor {
  path: string;
  sessionId: string | null;
  inode: string;
  offset: number;
  size: number;
  mtimeMs: number;
}

export interface SessionUpdate {
  sessionId: string;
  path: string;
  meta: TranscriptMeta;
  firstPrompt: string | null;
  startedAtMs: number | null;
  lastActivityMs: number | null;
}

export interface PresenceUpdate {
  sessionId: string;
  path: string | null;
  cwd: string | null;
  state: PresenceState;
  atMs: number;
  pid: number | null;
  pidStart: string | null;
  message: string | null;
}

const TURNS_COLUMNS = `turn_id TEXT NOT NULL, session_id TEXT NOT NULL, seq INTEGER NOT NULL, view_json TEXT NOT NULL,
  render_state TEXT NOT NULL CHECK(render_state IN ('pending','hidden')),
  prompt_message_id TEXT, card_message_id TEXT, rendered_hash TEXT, rendered_at_ms INTEGER NOT NULL DEFAULT 0,
  attachment_message_id TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, PRIMARY KEY(session_id, turn_id)`;

/** SQL condition limiting sessions to those whose cwd is one of `dirs` or below them; empty means all. */
function scopeCondition(dirs: readonly string[]): { sql: string; params: string[] } {
  if (!dirs.length) return { sql: "", params: [] };
  return {
    sql: ` AND (${dirs.map(() => "(cwd=? OR instr(cwd,?)=1)").join(" OR ")})`,
    params: dirs.flatMap((dir) => [dir, dir.endsWith("/") ? dir : `${dir}/`]),
  };
}

/** Durable state of the Claude bridge: session index, cursors, rendered turns and Feishu event claims. */
export class ClaudeBridgeDatabase {
  readonly db: DatabaseSync;
  readonly serviceEpoch = randomUUID();

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(stateDir, "bridge.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, cwd TEXT, custom_title TEXT, ai_title TEXT, first_prompt TEXT,
        entrypoint TEXT, model TEXT, permission_mode TEXT, git_branch TEXT,
        started_at_ms INTEGER NOT NULL DEFAULT 0, last_activity_ms INTEGER NOT NULL DEFAULT 0,
        root_message_id TEXT UNIQUE, root_app_link TEXT, chat_id TEXT, current_turn_id TEXT,
        presence_state TEXT, presence_at_ms INTEGER NOT NULL DEFAULT 0, presence_pid INTEGER, presence_pid_start TEXT, presence_message TEXT,
        waiting_notified_at_ms INTEGER NOT NULL DEFAULT 0, root_dirty INTEGER NOT NULL DEFAULT 0, readonly_notice_at_ms INTEGER NOT NULL DEFAULT 0,
        created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_activity ON sessions(last_activity_ms);
      CREATE TABLE IF NOT EXISTS cursors (
        path TEXT PRIMARY KEY, session_id TEXT, inode TEXT NOT NULL DEFAULT '', offset INTEGER NOT NULL DEFAULT 0,
        size INTEGER NOT NULL DEFAULT 0, mtime_ms REAL NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS turns (${TURNS_COLUMNS});
      CREATE INDEX IF NOT EXISTS turns_session_seq ON turns(session_id, seq);
      CREATE TABLE IF NOT EXISTS feishu_prompts (
        session_id TEXT NOT NULL, uuid TEXT NOT NULL, message_id TEXT, created_at_ms INTEGER NOT NULL, PRIMARY KEY(session_id, uuid)
      );
      CREATE TABLE IF NOT EXISTS inbound_events (
        event_id TEXT PRIMARY KEY, status TEXT NOT NULL, claim_token TEXT, service_epoch TEXT, lease_until_ms INTEGER,
        attempt_count INTEGER NOT NULL DEFAULT 0, error TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS failures (
        key TEXT PRIMARY KEY, operation TEXT NOT NULL, detail TEXT NOT NULL, error TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1,
        resolved INTEGER NOT NULL DEFAULT 0, first_at_ms INTEGER NOT NULL, last_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sent_messages (
        message_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, created_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sent_messages_session ON sent_messages(session_id, created_at_ms);`);
    this.ensureColumn("sessions", "root_out_of_scope", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("sessions", "pref_mode", "TEXT");
    this.ensureColumn("sessions", "pref_model", "TEXT");
    this.ensureColumn("sessions", "pref_effort", "TEXT");
    this.ensureColumn("sessions", "forked_from", "TEXT");
    this.ensureColumn("sessions", "effort", "TEXT");
    this.migrateTurnKey();
  }

  /**
   * Turn ids are prompt uuids, and a forked session repeats the uuids of the history it copied,
   * so turns are keyed per session. Databases from before this change are converted once.
   */
  private migrateTurnKey(): void {
    const columns = this.db.prepare("PRAGMA table_info(turns)").all() as Array<{ name: string; pk: number }>;
    if (columns.find((column) => column.name === "session_id")?.pk) return;
    this.transaction(() => {
      this.db.exec(`CREATE TABLE turns_keyed (${TURNS_COLUMNS});
        INSERT INTO turns_keyed(turn_id,session_id,seq,view_json,render_state,prompt_message_id,card_message_id,rendered_hash,rendered_at_ms,attachment_message_id,created_at_ms,updated_at_ms)
          SELECT turn_id,session_id,seq,view_json,render_state,prompt_message_id,card_message_id,rendered_hash,rendered_at_ms,attachment_message_id,created_at_ms,updated_at_ms FROM turns;
        DROP TABLE turns;
        ALTER TABLE turns_keyed RENAME TO turns;
        CREATE INDEX IF NOT EXISTS turns_session_seq ON turns(session_id, seq);`);
    });
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  close(): void { this.db.close(); }

  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  getSetting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key=?").get(key) as { value?: string } | undefined;
    return row?.value ?? null;
  }
  setSetting(key: string, value: string): void {
    this.db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }
  deleteSetting(key: string): void { this.db.prepare("DELETE FROM settings WHERE key=?").run(key); }

  getCursor(path: string): TranscriptCursor | null {
    const row = this.db.prepare("SELECT * FROM cursors WHERE path=?").get(path) as Record<string, unknown> | undefined;
    return row ? { path: String(row.path), sessionId: row.session_id ? String(row.session_id) : null, inode: String(row.inode),
      offset: Number(row.offset), size: Number(row.size), mtimeMs: Number(row.mtime_ms) } : null;
  }
  saveCursor(cursor: TranscriptCursor): void {
    this.db.prepare(`INSERT INTO cursors(path,session_id,inode,offset,size,mtime_ms) VALUES(?,?,?,?,?,?)
      ON CONFLICT(path) DO UPDATE SET session_id=excluded.session_id,inode=excluded.inode,offset=excluded.offset,size=excluded.size,mtime_ms=excluded.mtime_ms`)
      .run(cursor.path, cursor.sessionId, cursor.inode, cursor.offset, cursor.size, cursor.mtimeMs);
  }

  private sessionFromRow(row: Record<string, unknown>): ClaudeSession {
    const text = (value: unknown) => typeof value === "string" && value ? value : null;
    const state = text(row.presence_state);
    return {
      sessionId: String(row.session_id), path: String(row.path), cwd: text(row.cwd), customTitle: text(row.custom_title), aiTitle: text(row.ai_title),
      firstPrompt: text(row.first_prompt), entrypoint: text(row.entrypoint), model: text(row.model), effort: text(row.effort), permissionMode: text(row.permission_mode),
      gitBranch: text(row.git_branch), startedAtMs: Number(row.started_at_ms), lastActivityMs: Number(row.last_activity_ms),
      rootMessageId: text(row.root_message_id), rootAppLink: text(row.root_app_link), chatId: text(row.chat_id), currentTurnId: text(row.current_turn_id),
      presenceState: state === "idle" || state === "running" || state === "waiting" || state === "closed" ? state : null,
      presenceAtMs: Number(row.presence_at_ms), presencePid: row.presence_pid === null || row.presence_pid === undefined ? null : Number(row.presence_pid),
      presencePidStart: text(row.presence_pid_start), presenceMessage: text(row.presence_message), waitingNotifiedAtMs: Number(row.waiting_notified_at_ms),
      rootDirty: Number(row.root_dirty) === 1, rootOutOfScope: Number(row.root_out_of_scope) === 1, readonlyNoticeAtMs: Number(row.readonly_notice_at_ms),
      prefMode: text(row.pref_mode), prefModel: text(row.pref_model), prefEffort: text(row.pref_effort), forkedFrom: text(row.forked_from),
    };
  }

  getSession(sessionId: string): ClaudeSession | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE session_id=?").get(sessionId) as Record<string, unknown> | undefined;
    return row ? this.sessionFromRow(row) : null;
  }
  getSessionByRoot(rootMessageId: string): ClaudeSession | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE root_message_id=?").get(rootMessageId) as Record<string, unknown> | undefined;
    return row ? this.sessionFromRow(row) : null;
  }

  /**
   * Records what a transcript says about its session; later values win, missing values keep the
   * stored ones. Turns the bridge runs are recorded with an SDK entrypoint, which does not replace
   * where the session is known to come from.
   */
  updateSession(update: SessionUpdate): boolean {
    const before = this.getSession(update.sessionId);
    const now = Date.now();
    this.db.prepare(`INSERT INTO sessions(session_id,path,cwd,custom_title,ai_title,first_prompt,entrypoint,model,effort,permission_mode,git_branch,started_at_ms,last_activity_ms,created_at_ms,updated_at_ms)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET path=excluded.path,
      cwd=COALESCE(excluded.cwd,sessions.cwd), custom_title=COALESCE(excluded.custom_title,sessions.custom_title), ai_title=COALESCE(excluded.ai_title,sessions.ai_title),
      first_prompt=COALESCE(sessions.first_prompt,excluded.first_prompt), entrypoint=CASE WHEN excluded.entrypoint LIKE 'sdk%' AND sessions.entrypoint IS NOT NULL THEN sessions.entrypoint ELSE COALESCE(excluded.entrypoint,sessions.entrypoint) END, model=COALESCE(excluded.model,sessions.model), effort=COALESCE(excluded.effort,sessions.effort),
      permission_mode=COALESCE(excluded.permission_mode,sessions.permission_mode), git_branch=COALESCE(excluded.git_branch,sessions.git_branch),
      started_at_ms=CASE WHEN sessions.started_at_ms=0 THEN excluded.started_at_ms ELSE sessions.started_at_ms END,
      last_activity_ms=MAX(sessions.last_activity_ms,excluded.last_activity_ms), updated_at_ms=excluded.updated_at_ms`).run(
      update.sessionId, update.path, update.meta.cwd ?? null, update.meta.customTitle ?? null, update.meta.aiTitle ?? null, update.firstPrompt,
      update.meta.entrypoint ?? null, update.meta.model ?? null, update.meta.effort ?? null, update.meta.permissionMode ?? null, update.meta.gitBranch ?? null,
      update.startedAtMs ?? 0, update.lastActivityMs ?? 0, now, now);
    const after = this.getSession(update.sessionId)!;
    const changed = !before || before.customTitle !== after.customTitle || before.aiTitle !== after.aiTitle || before.model !== after.model || before.effort !== after.effort
      || before.permissionMode !== after.permissionMode || before.cwd !== after.cwd || before.entrypoint !== after.entrypoint;
    if (changed && after.rootMessageId) this.markRootDirty(update.sessionId);
    return changed;
  }

  setSessionRoot(sessionId: string, rootMessageId: string, appLink: string | null, chatId: string): void {
    this.db.prepare("UPDATE sessions SET root_message_id=?,root_app_link=?,chat_id=?,root_dirty=0,updated_at_ms=? WHERE session_id=?")
      .run(rootMessageId, appLink, chatId, Date.now(), sessionId);
  }
  setCurrentTurn(sessionId: string, turnId: string | null): void {
    this.db.prepare("UPDATE sessions SET current_turn_id=? WHERE session_id=?").run(turnId, sessionId);
  }
  markRootDirty(sessionId: string): void { this.db.prepare("UPDATE sessions SET root_dirty=1 WHERE session_id=?").run(sessionId); }
  clearRootDirty(sessionId: string): void { this.db.prepare("UPDATE sessions SET root_dirty=0 WHERE session_id=?").run(sessionId); }
  setRootOutOfScope(sessionId: string, outOfScope: boolean): void {
    this.db.prepare("UPDATE sessions SET root_out_of_scope=?,root_dirty=0 WHERE session_id=?").run(outOfScope ? 1 : 0, sessionId);
  }
  /** Sessions that have a Feishu topic, most recently active first. */
  topicSessions(): ClaudeSession[] {
    return (this.db.prepare("SELECT * FROM sessions WHERE root_message_id IS NOT NULL ORDER BY last_activity_ms DESC").all() as Record<string, unknown>[])
      .map((row) => this.sessionFromRow(row));
  }

  recordSentMessage(sessionId: string, messageId: string): void {
    this.db.prepare("INSERT OR IGNORE INTO sent_messages(message_id,session_id,created_at_ms) VALUES(?,?,?)").run(messageId, sessionId, Date.now());
  }
  /**
   * Every message the bridge posted in a session's topic, newest first and the root last, so
   * that withdrawing them in this order removes replies before the topic itself. Turns and the
   * root are included for messages sent before the bridge kept this record.
   */
  topicMessages(sessionId: string): string[] {
    const session = this.getSession(sessionId);
    const ids = new Set((this.db.prepare("SELECT message_id FROM sent_messages WHERE session_id=? ORDER BY created_at_ms DESC").all(sessionId) as Array<{ message_id: string }>)
      .map((row) => row.message_id));
    for (const row of this.db.prepare("SELECT prompt_message_id,card_message_id,attachment_message_id FROM turns WHERE session_id=? ORDER BY seq DESC").all(sessionId) as Array<Record<string, string | null>>) {
      // "feishu:" marks a prompt the person typed in Feishu; it is theirs, not the bridge's.
      for (const id of [row.attachment_message_id, row.card_message_id, row.prompt_message_id]) if (id && !id.startsWith("feishu:")) ids.add(id);
    }
    if (session?.rootMessageId) { ids.delete(session.rootMessageId); ids.add(session.rootMessageId); }
    return [...ids];
  }
  /**
   * Forgets a session's topic after its messages were withdrawn: the session stays indexed with
   * its latest turn hidden, so new activity in scope opens a fresh topic.
   */
  detachTopic(sessionId: string): void {
    this.transaction(() => {
      const session = this.getSession(sessionId);
      this.db.prepare("DELETE FROM turns WHERE session_id=? AND turn_id IS NOT ?").run(sessionId, session?.currentTurnId ?? null);
      this.db.prepare(`UPDATE turns SET render_state='hidden',prompt_message_id=NULL,card_message_id=NULL,rendered_hash=NULL,rendered_at_ms=0,attachment_message_id=NULL
        WHERE session_id=?`).run(sessionId);
      this.db.prepare("DELETE FROM sent_messages WHERE session_id=?").run(sessionId);
      this.db.prepare(`UPDATE sessions SET root_message_id=NULL,root_app_link=NULL,chat_id=NULL,root_dirty=0,root_out_of_scope=0,waiting_notified_at_ms=0,
        readonly_notice_at_ms=0,updated_at_ms=? WHERE session_id=?`).run(Date.now(), sessionId);
    });
  }
  /** Changes only the given preferences; an empty string resets one to the default. */
  setSessionPrefs(sessionId: string, prefs: { mode?: string; model?: string; effort?: string }): void {
    for (const [column, value] of [["pref_mode", prefs.mode], ["pref_model", prefs.model], ["pref_effort", prefs.effort]] as const) {
      if (value !== undefined) this.db.prepare(`UPDATE sessions SET ${column}=?,root_dirty=CASE WHEN root_message_id IS NULL THEN root_dirty ELSE 1 END WHERE session_id=?`).run(value || null, sessionId);
    }
  }
  /** Working directories of recent sessions, most recent first, for picking where a new session starts. */
  recentDirectories(limit: number, syncDirs: readonly string[] = []): string[] {
    const scope = scopeCondition(syncDirs);
    return (this.db.prepare(`SELECT cwd, MAX(last_activity_ms) AS latest FROM sessions WHERE cwd IS NOT NULL AND last_activity_ms>0${scope.sql}
      GROUP BY cwd ORDER BY latest DESC LIMIT ?`).all(...scope.params, limit) as Array<{ cwd: string }>).map((row) => row.cwd);
  }
  /** Every session's transcript path and recorded working directory. */
  sessionDirectories(): Array<{ sessionId: string; path: string; cwd: string }> {
    return (this.db.prepare("SELECT session_id, path, cwd FROM sessions WHERE cwd IS NOT NULL").all() as Array<{ session_id: string; path: string; cwd: string }>)
      .map((row) => ({ sessionId: row.session_id, path: row.path, cwd: row.cwd }));
  }
  setSessionCwd(sessionId: string, cwd: string): void {
    this.db.prepare("UPDATE sessions SET cwd=?,root_dirty=CASE WHEN root_message_id IS NULL THEN root_dirty ELSE 1 END WHERE session_id=?").run(cwd, sessionId);
  }
  setForkedFrom(sessionId: string, source: string): void {
    this.db.prepare("UPDATE sessions SET forked_from=? WHERE session_id=?").run(source, sessionId);
  }

  /** Stores the latest hook-reported state; older reports never overwrite newer ones. */
  updatePresence(update: PresenceUpdate): ClaudeSession | null {
    const now = Date.now();
    if (update.path) {
      this.db.prepare(`INSERT INTO sessions(session_id,path,cwd,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?) ON CONFLICT(session_id) DO NOTHING`)
        .run(update.sessionId, update.path, update.cwd, now, now);
    }
    this.db.prepare(`UPDATE sessions SET presence_state=?,presence_at_ms=?,presence_pid=?,presence_pid_start=?,presence_message=?,
      root_dirty=CASE WHEN root_message_id IS NULL THEN root_dirty ELSE 1 END WHERE session_id=? AND presence_at_ms<=?`)
      .run(update.state, update.atMs, update.pid, update.pidStart, update.message, update.sessionId, update.atMs);
    return this.getSession(update.sessionId);
  }
  setWaitingNotified(sessionId: string, atMs: number): void {
    this.db.prepare("UPDATE sessions SET waiting_notified_at_ms=? WHERE session_id=?").run(atMs, sessionId);
  }
  /** Sessions a hook reported as open whose Claude Code process should be checked for liveness. */
  livePresenceSessions(): ClaudeSession[] {
    return (this.db.prepare("SELECT * FROM sessions WHERE presence_state IN ('idle','running','waiting')").all() as Record<string, unknown>[])
      .map((row) => this.sessionFromRow(row));
  }

  listRecentSessions(limit: number, offset = 0, search = "", syncDirs: readonly string[] = []): ClaudeSession[] {
    const words = search.split(/\s+/).map((word) => word.trim()).filter(Boolean).slice(0, 6);
    const where = words.map(() => "(LOWER(COALESCE(custom_title,'')||' '||COALESCE(ai_title,'')||' '||COALESCE(first_prompt,'')||' '||COALESCE(cwd,'')||' '||session_id) LIKE ?)");
    const scope = scopeCondition(syncDirs);
    const sql = `SELECT * FROM sessions WHERE last_activity_ms>0${scope.sql}${where.length ? ` AND ${where.join(" AND ")}` : ""} ORDER BY last_activity_ms DESC LIMIT ? OFFSET ?`;
    const params = [...scope.params, ...words.map((word) => `%${word.toLowerCase().replace(/[%_]/g, "")}%`), limit, offset];
    return (this.db.prepare(sql).all(...params) as Record<string, unknown>[]).map((row) => this.sessionFromRow(row));
  }
  sessionCounts(syncDirs: readonly string[] = []): { indexed: number; topics: number; open: number } {
    const scope = scopeCondition(syncDirs);
    const row = this.db.prepare(`SELECT COUNT(*) AS indexed, COUNT(root_message_id) AS topics,
      SUM(CASE WHEN presence_state IN ('idle','running','waiting') THEN 1 ELSE 0 END) AS open FROM sessions WHERE last_activity_ms>0${scope.sql}`)
      .get(...scope.params) as Record<string, unknown>;
    return { indexed: Number(row.indexed ?? 0), topics: Number(row.topics ?? 0), open: Number(row.open ?? 0) };
  }

  private turnFromRow(row: Record<string, unknown>): StoredTurn {
    return {
      turnId: String(row.turn_id), sessionId: String(row.session_id), seq: Number(row.seq), view: JSON.parse(String(row.view_json)) as TurnView,
      renderState: row.render_state === "hidden" ? "hidden" : "pending", promptMessageId: row.prompt_message_id ? String(row.prompt_message_id) : null,
      cardMessageId: row.card_message_id ? String(row.card_message_id) : null, renderedHash: row.rendered_hash ? String(row.rendered_hash) : null,
      renderedAtMs: Number(row.rendered_at_ms), attachmentMessageId: row.attachment_message_id ? String(row.attachment_message_id) : null,
    };
  }
  getTurn(sessionId: string, turnId: string): StoredTurn | null {
    const row = this.db.prepare("SELECT * FROM turns WHERE session_id=? AND turn_id=?").get(sessionId, turnId) as Record<string, unknown> | undefined;
    return row ? this.turnFromRow(row) : null;
  }
  /**
   * Saves a turn's content. A hidden turn (history imported without posting) can
   * become visible, but a visible turn never becomes hidden again. `promptMessageId`
   * marks a prompt that is already in the topic, so no prompt line is posted for it.
   */
  saveTurn(sessionId: string, view: TurnView, renderState: TurnRenderState, promptMessageId: string | null = null): void {
    const now = Date.now();
    const seq = Number((this.db.prepare("SELECT COALESCE(MAX(seq),0)+1 AS next FROM turns WHERE session_id=?").get(sessionId) as { next: number }).next);
    this.db.prepare(`INSERT INTO turns(turn_id,session_id,seq,view_json,render_state,prompt_message_id,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(session_id,turn_id) DO UPDATE SET view_json=excluded.view_json,updated_at_ms=excluded.updated_at_ms,
      render_state=CASE WHEN turns.render_state='pending' THEN 'pending' ELSE excluded.render_state END,
      prompt_message_id=COALESCE(turns.prompt_message_id,excluded.prompt_message_id)`)
      .run(view.turnId, sessionId, seq, JSON.stringify(view), renderState, promptMessageId, now, now);
  }
  /** A prompt sent from Feishu; `messageId` is the person's message in the topic, null when the bridge posts the prompt itself. */
  recordFeishuPrompt(sessionId: string, uuid: string, messageId: string | null): void {
    this.db.prepare("INSERT OR IGNORE INTO feishu_prompts(session_id,uuid,message_id,created_at_ms) VALUES(?,?,?,?)").run(sessionId, uuid, messageId, Date.now());
  }
  feishuPrompt(sessionId: string, uuid: string): { messageId: string | null } | null {
    const row = this.db.prepare("SELECT message_id FROM feishu_prompts WHERE session_id=? AND uuid=?").get(sessionId, uuid) as { message_id: string | null } | undefined;
    return row ? { messageId: row.message_id ?? null } : null;
  }
  /**
   * Visible turns that may need work: no card yet, changed since the last render, or long
   * enough to need a Markdown attachment that has not been sent. Oldest first.
   */
  turnsToRender(sessionId: string): StoredTurn[] {
    return (this.db.prepare(`SELECT * FROM turns WHERE session_id=? AND render_state='pending'
      AND (card_message_id IS NULL OR updated_at_ms>=rendered_at_ms OR json_extract(view_json,'$.status')='running'
        OR (attachment_message_id IS NULL AND length(view_json)>?)) ORDER BY seq`)
      .all(sessionId, ATTACHMENT_HINT_CHARS) as Record<string, unknown>[]).map((row) => this.turnFromRow(row));
  }
  /**
   * Sessions with a pending card or root card update (retries after Feishu failures), and
   * sessions whose running turn has been quiet since `quietBeforeMs` and may now be unfinished.
   */
  sessionsNeedingRender(quietBeforeMs: number): string[] {
    return (this.db.prepare(`SELECT DISTINCT session_id FROM turns WHERE render_state='pending' AND (card_message_id IS NULL OR updated_at_ms>rendered_at_ms
        OR (json_extract(view_json,'$.status')='running' AND updated_at_ms<?))
      UNION SELECT session_id FROM sessions WHERE root_dirty=1 AND root_message_id IS NOT NULL`).all(quietBeforeMs) as Array<{ session_id: string }>).map((row) => row.session_id);
  }
  setTurnPromptMessage(sessionId: string, turnId: string, messageId: string): void {
    this.db.prepare("UPDATE turns SET prompt_message_id=? WHERE session_id=? AND turn_id=?").run(messageId, sessionId, turnId);
  }
  setTurnCard(sessionId: string, turnId: string, messageId: string, hash: string): void {
    this.db.prepare("UPDATE turns SET card_message_id=?,rendered_hash=?,rendered_at_ms=? WHERE session_id=? AND turn_id=?").run(messageId, hash, Date.now(), sessionId, turnId);
  }
  setTurnAttachment(sessionId: string, turnId: string, messageId: string): void {
    this.db.prepare("UPDATE turns SET attachment_message_id=? WHERE session_id=? AND turn_id=?").run(messageId, sessionId, turnId);
  }

  claimInboundEvent(eventId: string, leaseMs = 5 * 60_000): boolean {
    return this.transaction(() => {
      const now = Date.now();
      const row = this.db.prepare("SELECT status,service_epoch,lease_until_ms FROM inbound_events WHERE event_id=?").get(eventId) as { status?: string; service_epoch?: string; lease_until_ms?: number } | undefined;
      if (row?.status === "completed" || row?.status === "permanent_failed") return false;
      const reclaim = !row || row.status === "retryable_failed" || (row.status === "processing" && (row.service_epoch !== this.serviceEpoch || Number(row.lease_until_ms ?? 0) <= now));
      if (!reclaim) return false;
      const token = randomUUID();
      if (row) this.db.prepare("UPDATE inbound_events SET status='processing',error=NULL,claim_token=?,service_epoch=?,lease_until_ms=?,attempt_count=attempt_count+1,updated_at_ms=? WHERE event_id=?").run(token, this.serviceEpoch, now + leaseMs, now, eventId);
      else this.db.prepare("INSERT INTO inbound_events(event_id,status,claim_token,service_epoch,lease_until_ms,attempt_count,created_at_ms,updated_at_ms) VALUES(?,'processing',?,?,?,1,?,?)").run(eventId, token, this.serviceEpoch, now + leaseMs, now, now);
      return true;
    });
  }
  completeInboundEvent(eventId: string): void {
    this.db.prepare("UPDATE inbound_events SET status='completed',claim_token=NULL,lease_until_ms=NULL,updated_at_ms=? WHERE event_id=? AND status='processing' AND service_epoch=?").run(Date.now(), eventId, this.serviceEpoch);
  }
  failInboundEvent(eventId: string, error: unknown, retryable: boolean): void {
    this.db.prepare("UPDATE inbound_events SET status=?,error=?,claim_token=NULL,lease_until_ms=NULL,updated_at_ms=? WHERE event_id=? AND status='processing' AND service_epoch=?")
      .run(retryable ? "retryable_failed" : "permanent_failed", error instanceof Error ? error.message : String(error), Date.now(), eventId, this.serviceEpoch);
  }

  recordFailure(operation: string, detail: Record<string, unknown>, error: unknown): void {
    const now = Date.now();
    const key = `${operation}:${JSON.stringify(detail)}`.slice(0, 500);
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
    this.db.prepare(`INSERT INTO failures(key,operation,detail,error,count,resolved,first_at_ms,last_at_ms) VALUES(?,?,?,?,1,0,?,?)
      ON CONFLICT(key) DO UPDATE SET error=excluded.error,count=failures.count+1,resolved=0,last_at_ms=excluded.last_at_ms`)
      .run(key, operation, JSON.stringify(detail), message, now, now);
  }
  resolveFailure(operation: string, detail: Record<string, unknown>): void {
    this.db.prepare("UPDATE failures SET resolved=1 WHERE key=?").run(`${operation}:${JSON.stringify(detail)}`.slice(0, 500));
  }
  failureCount(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS count FROM failures WHERE resolved=0").get() as { count: number }).count);
  }

  pruneRetainedData(now = Date.now()): void {
    const day = 24 * 60 * 60 * 1_000;
    this.db.prepare("DELETE FROM inbound_events WHERE status IN ('completed','retryable_failed') AND updated_at_ms<?").run(now - 7 * day);
    this.db.prepare("DELETE FROM inbound_events WHERE status='permanent_failed' AND updated_at_ms<?").run(now - 30 * day);
    this.db.prepare("DELETE FROM failures WHERE resolved=1 AND last_at_ms<?").run(now - 30 * day);
    this.db.prepare("DELETE FROM feishu_prompts WHERE created_at_ms<?").run(now - 30 * day);
  }
}
