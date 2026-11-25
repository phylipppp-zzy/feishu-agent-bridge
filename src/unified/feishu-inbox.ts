import type { DatabaseSync } from 'node:sqlite';
import type { Operation } from './contracts.js';
import { operationFromReceipt } from './feishu-operation-notices.js';

const inboxTables = ['channel_inbox','channel_candidate_inbox_v1','channel_steer_inbox_v1'] as const;

/** The partition order matches the original channel recovery scan and works for old rows. */
export class FeishuInbox {
  constructor(private readonly db: DatabaseSync) {
    for (const table of inboxTables) {
      this.db.exec(`CREATE INDEX IF NOT EXISTS ${table}_destination ON ${table}(state,json_extract(envelope,'$.destination'))`);
    }
  }

  pending(destination?: string): string[] {
    return inboxTables.flatMap(table => {
      const filtered = destination === undefined ? '' : " AND json_extract(envelope,'$.destination')=?";
      const query = this.db.prepare(`SELECT event_id FROM ${table} WHERE state='received'${filtered} ORDER BY rowid`);
      const rows = (destination === undefined ? query.all() : query.all(destination)) as Array<{event_id:string}>;
      return rows.map(row=>row.event_id);
    });
  }
  destinations(): string[] {
    const query = inboxTables.map(table => `SELECT json_extract(envelope,'$.destination') AS destination FROM ${table} WHERE state='received'`).join(' UNION ');
    return (this.db.prepare(query).all() as Array<{destination:string}>).map(row=>row.destination);
  }
  operationForEvent(eventId: string): Operation | null {
    const row = this.db.prepare(`
      SELECT result FROM channel_receipts WHERE event_id=? AND state='completed'
      UNION ALL SELECT result FROM channel_steer_inbox_v1 WHERE event_id=? AND state='completed'
    `).get(eventId,eventId) as {result:string|null} | undefined;
    return row?.result ? operationFromReceipt(JSON.parse(row.result)) : null;
  }
}
