import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export type CallbackReferences = Map<string, string>;
const referenceKey = 'callback_ref';

export function packCardCallbacks(card: object): { content: string; references: CallbackReferences } {
  const references: CallbackReferences = new Map();
  const content = JSON.stringify(card, function (key, value: unknown) {
    if (key !== 'value' || (this.tag !== 'button' && this.type !== 'callback') || this.url) return value;
    const json = JSON.stringify(value);
    if (!json || Buffer.byteLength(json) <= 256) return value;
    const ref = createHash('sha256').update(json).digest('base64url');
    references.set(ref, json);
    return { [referenceKey]: ref };
  });
  return { content, references };
}

/** References stay scoped to the card carrying them. Keep old values so stale
 * clicks reach the usual interaction revision and expiry checks after a PATCH. */
export class FeishuCallbackValues {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS sdk_card_callback_values (
      message_id TEXT NOT NULL, ref TEXT NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY(message_id, ref)
    )`);
  }

  store(messageId: string, references: CallbackReferences): void {
    if (!references.size) return;
    const insert = this.db.prepare('INSERT OR IGNORE INTO sdk_card_callback_values VALUES (?, ?, ?)');
    for (const [ref, json] of references) insert.run(messageId, ref, json);
  }

  resolve(messageId: string, value: Record<string, unknown>): unknown {
    if (!Object.hasOwn(value, referenceKey)) return value;
    const ref = value[referenceKey];
    if (Object.keys(value).length !== 1 || typeof ref !== 'string' || !/^[\w-]{43}$/.test(ref)) return undefined;
    const row = this.db.prepare('SELECT value FROM sdk_card_callback_values WHERE message_id=? AND ref=?')
      .get(messageId, ref) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : undefined;
  }
}
