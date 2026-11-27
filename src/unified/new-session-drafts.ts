import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Identity, Provider, WriteContext } from './contracts.js';
import type { TrustedEnvelope } from './feishu-channel.js';

const draftLifetimeMs = 30 * 60 * 1000;

type DraftRow = {
  token: string; event_id: string; owner: string; destination: string; scope: string;
  card_message_id: string | null; provider: Provider; projects: string[]; initial_prompt: string | null;
  revision: number; expires_at: number; state: 'open' | 'creating' | 'completed' | 'rejected';
  create_operation_id: string | null; chosen_index: number | null; create_context: WriteContext | null;
};
type DraftSqlRow = Omit<DraftRow, 'projects' | 'create_context'> & { projects: string; create_context: string | null };
export type NewSessionDraft = DraftRow & { explicit_project?: string };
export type FirstPrompt = {
  create_operation_id: string; child_operation_id: string; destination: string;
  session_id: string; final_scope: string; identity: string; prompt_text: string;
  state: 'pending' | 'registered';
};

export class NewSessionDrafts {
  private readonly explicitProjects = new Map<string, string>();

  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS channel_new_session_drafts (
        token TEXT PRIMARY KEY, event_id TEXT NOT NULL, owner TEXT NOT NULL, destination TEXT NOT NULL, scope TEXT NOT NULL,
        card_message_id TEXT, provider TEXT NOT NULL, projects TEXT NOT NULL, initial_prompt TEXT,
        revision INTEGER NOT NULL, expires_at INTEGER NOT NULL, state TEXT NOT NULL,
        create_operation_id TEXT UNIQUE, chosen_index INTEGER, create_context TEXT
      );
      CREATE INDEX IF NOT EXISTS channel_new_session_drafts_expiry ON channel_new_session_drafts(state, expires_at);
      CREATE TABLE IF NOT EXISTS channel_new_session_first_prompts (
        create_operation_id TEXT PRIMARY KEY, child_operation_id TEXT NOT NULL UNIQUE, destination TEXT NOT NULL,
        session_id TEXT NOT NULL, final_scope TEXT NOT NULL, identity TEXT NOT NULL, prompt_text TEXT NOT NULL, state TEXT NOT NULL
      );
    `);
  }

  private decode(row: DraftSqlRow | undefined): NewSessionDraft | undefined {
    return row && {
      ...row,
      projects: JSON.parse(row.projects),
      create_context: row.create_context && JSON.parse(row.create_context),
      ...(this.explicitProjects.has(row.token) ? { explicit_project: this.explicitProjects.get(row.token)! } : {}),
    };
  }

  get(token: string): NewSessionDraft | undefined {
    return this.decode(this.db.prepare('SELECT * FROM channel_new_session_drafts WHERE token=?').get(token) as DraftSqlRow | undefined);
  }

  forOperation(operationId: string): NewSessionDraft | undefined {
    return this.decode(this.db.prepare('SELECT * FROM channel_new_session_drafts WHERE create_operation_id=?')
      .get(operationId) as DraftSqlRow | undefined);
  }

  open(
    e: TrustedEnvelope,
    scope: string,
    provider: Provider,
    projects: string[],
    initialPrompt?: string,
    explicitProject?: string,
  ): NewSessionDraft {
    const token = randomBytes(16).toString('base64url');
    const now = Date.now();
    const expired = this.db.prepare("SELECT token FROM channel_new_session_drafts WHERE state='open' AND expires_at<=?").all(now) as Array<{ token: string }>;
    for (const item of expired) this.explicitProjects.delete(item.token);
    this.db.prepare("DELETE FROM channel_new_session_drafts WHERE state='open' AND expires_at<=?").run(now);
    if (explicitProject) {
      if (this.explicitProjects.size >= 512) {
        const oldest = this.explicitProjects.keys().next().value;
        if (oldest !== undefined) this.explicitProjects.delete(oldest);
      }
      this.explicitProjects.set(token, explicitProject);
    }
    this.db.prepare(`
      INSERT INTO channel_new_session_drafts
        (token,event_id,owner,destination,scope,provider,projects,initial_prompt,revision,expires_at,state)
      VALUES (?,?,?,?,?,?,?,?,0,?,'open')
    `).run(token, e.eventId, this.owner(e), e.destination, scope, provider, JSON.stringify(projects), initialPrompt || null, now + draftLifetimeMs);
    return this.get(token)!;
  }

  setCardMessage(token: string, messageId: string): void {
    this.db.prepare('UPDATE channel_new_session_drafts SET card_message_id=? WHERE token=? AND card_message_id IS NULL')
      .run(messageId, token);
  }

  private owner(e: TrustedEnvelope): string {
    return JSON.stringify([e.identity.source, e.identity.subject]);
  }

  matches(row: NewSessionDraft, e: TrustedEnvelope, scope: string): boolean {
    return row.owner === this.owner(e) && row.destination === e.destination && row.scope === scope && row.expires_at > Date.now();
  }

  private matchCard(token: string, e: TrustedEnvelope, scope: string): NewSessionDraft | undefined {
    const row = this.get(token);
    return row && this.matches(row, e, scope) && e.cardMessageId && row.card_message_id === e.cardMessageId ? row : undefined;
  }

  selectProvider(token: string, revision: number, provider: Provider, e: TrustedEnvelope, scope: string): NewSessionDraft | undefined {
    const row = this.matchCard(token, e, scope);
    if (!row || row.state !== 'open') return;
    if (row.revision === revision + 1 && row.provider === provider) return row;
    if (row.revision !== revision) return;
    const result = this.db.prepare(`
      UPDATE channel_new_session_drafts SET provider=?,revision=revision+1
      WHERE token=? AND revision=? AND state='open'
    `).run(provider, token, revision);
    if (result.changes) return this.get(token);
  }

  claim(
    token: string, revision: number, index: number, e: TrustedEnvelope, scope: string, context: WriteContext,
    validate: (provider: Provider, project: string) => boolean, recordPending: () => void,
  ): NewSessionDraft | undefined {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.matchCard(token, e, scope);
      let result: NewSessionDraft | undefined;
      const project = row?.projects[index];
      if (row && row.revision === revision && Number.isSafeInteger(index) && index >= 0 && project) {
        if (row.state !== 'open') {
          if (row.chosen_index === index) result = row;
        } else if (validate(row.provider, project)) {
          this.db.prepare(`
            UPDATE channel_new_session_drafts SET state='creating',create_operation_id=?,chosen_index=?,create_context=?
            WHERE token=? AND state='open'
          `).run(context.operationId, index, JSON.stringify(context), token);
          recordPending();
          result = this.get(token);
        }
      }
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  settle(operationId: string, state: 'completed' | 'rejected'): void {
    this.db.prepare("UPDATE channel_new_session_drafts SET state=? WHERE create_operation_id=? AND state='creating'").run(state, operationId);
  }

  enqueueFirstPrompt(draft: NewSessionDraft, sessionId: string, destination: string, scope: string, identity: Identity): void {
    if (!draft.initial_prompt || !draft.create_operation_id) return;
    this.db.prepare(`
      INSERT OR IGNORE INTO channel_new_session_first_prompts
        (create_operation_id,child_operation_id,destination,session_id,final_scope,identity,prompt_text,state)
      VALUES (?,?,?,?,?,?,?,'pending')
    `).run(draft.create_operation_id, `new-session-first:${draft.token}`, destination, sessionId, scope, JSON.stringify(identity), draft.initial_prompt);
  }

  firstPrompt(operationId: string): FirstPrompt | undefined {
    return this.db.prepare("SELECT * FROM channel_new_session_first_prompts WHERE create_operation_id=? AND state IN ('pending','registered')")
      .get(operationId) as FirstPrompt | undefined;
  }

  firstPromptOperations(): string[] {
    return (this.db.prepare("SELECT create_operation_id FROM channel_new_session_first_prompts WHERE state IN ('pending','registered') ORDER BY rowid")
      .all() as Array<{create_operation_id:string}>).map(row => row.create_operation_id);
  }

  finishFirstPrompt(operationId: string, state: 'registered' | 'settled' | 'expired'): void {
    this.db.prepare("UPDATE channel_new_session_first_prompts SET state=? WHERE create_operation_id=? AND state IN ('pending','registered')")
      .run(state, operationId);
  }
}
