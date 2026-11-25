import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { UnifiedService } from './adapter.js';
import { payloadDigest } from './contracts.js';
import { interactionCard, interactionStatusText, type ChannelCard } from './feishu-cards.js';
import { questionForm } from './feishu-question-forms.js';
import type { FeishuPort } from './feishu-channel.js';

export async function isResolvedApproval(service: UnifiedService, sessionId: string, interactionId: string): Promise<boolean> {
  const interaction = await service.getInteraction(interactionId).catch(() => null);
  return interaction?.kind === 'approval' && interaction.sessionId === sessionId && interaction.status === 'resolved';
}

type Guard = () => Promise<void>;
type ChannelAccess = {
  checkBinding(destination: string, sessionId: string, scope: string): Promise<void>;
  accessMode(destination: string): 'read_only' | 'interactive';
  stamp(destination: string, card: ChannelCard): ChannelCard;
  deliver(destination: string, card: ChannelCard, id: string, guard: Guard): Promise<string | void>;
};

export class FeishuInteractionCards {
  private readonly interactionLocks = new Map<string, Promise<void>>();
  constructor(
    private readonly db: DatabaseSync,
    private readonly service: UnifiedService,
    private readonly port: FeishuPort,
    private readonly channel: ChannelAccess,
  ) {}

  owns(destination: string, sessionId: string, interactionId: string, messageId: string, scope: string): boolean {
    return !!this.db.prepare(`
      SELECT 1 FROM channel_interaction_cards WHERE destination=? AND session_id=? AND interaction_id=?
        AND message_id=? AND binding_scope=?
    `).get(destination,sessionId,interactionId,messageId,scope);
  }

  async render(destination: string, sessionId: string, interactionId: string, scope: string, allowCreate=true): Promise<void> {
    const key = JSON.stringify([destination,sessionId,interactionId]);
    const previous = this.interactionLocks.get(key) ?? Promise.resolve();
    const rendering = previous.catch(()=>{}).then(() => this.renderCurrentInteraction(destination,sessionId,interactionId,scope,allowCreate));
    this.interactionLocks.set(key,rendering);
    try { await rendering; }
    finally { if (this.interactionLocks.get(key) === rendering) this.interactionLocks.delete(key); }
  }

  private async renderCurrentInteraction(destination: string, sessionId: string, interactionId: string, scope: string, allowCreate: boolean): Promise<void> {
    const guard = () => this.channel.checkBinding(destination,sessionId,scope);
    const row = this.db.prepare('SELECT revision,message_id,binding_scope FROM channel_interaction_cards WHERE destination=? AND session_id=? AND interaction_id=?').get(destination,sessionId,interactionId) as {revision:number;message_id:string;binding_scope:string} | undefined;
    if (!row && !allowCreate) return;
    await guard();
    const interaction = await this.service.getInteraction(interactionId);
    if (interaction.sessionId !== sessionId) throw new Error('interaction target mismatch');
    const op = interaction.status === 'awaiting_answer' ? undefined : await this.service.getResponseOperation?.(interactionId);
    await guard();
    if (!row && interaction.status !== 'awaiting_answer' && interaction.status !== 'answer_pending_delivery') return;
    const readOnly = this.channel.accessMode(destination) === 'read_only';
    const view = interactionCard(interaction,readOnly,op);
    if (interaction.kind !== 'approval') {
      view.schema = '2.0';
      view.actions = [];
      if (interaction.status !== 'resolved' && op?.status !== 'completed') {
        const binding = this.db.prepare('SELECT binding_id FROM channel_bindings WHERE destination=?').get(destination) as {binding_id:string};
        const statusText = interactionStatusText(interaction,op);
        view.text = readOnly ? '请回原会话答复。' : '';
        view.form = questionForm(interaction,binding.binding_id,readOnly || !!statusText);
        if (statusText) view.form.statusText = statusText;
      }
    }
    const signature=createHash('sha256').update(JSON.stringify(view)).digest('hex');
    const prior=this.db.prepare('SELECT signature FROM channel_interaction_view WHERE destination=? AND session_id=? AND interaction_id=?').get(destination,sessionId,interaction.interactionId) as {signature:string}|undefined;
    if (row && row.revision > interaction.revision) return;
    if (row && row.binding_scope===scope && row.revision === interaction.revision && prior?.signature === signature) return;
    const remember=()=>this.db.prepare('INSERT OR REPLACE INTO channel_interaction_view VALUES (?,?,?,?)').run(destination,sessionId,interaction.interactionId,signature);
    const id = `interaction:${payloadDigest([scope,destination,sessionId,interaction.interactionId,interaction.revision,signature])}`;
    if (row) {
      if (!this.db.prepare("INSERT OR IGNORE INTO channel_deliveries VALUES (?, 'unknown')").run(id).changes) { if (await this.port.lookupDelivery?.(id) === 'sent') { await guard(); this.db.prepare("UPDATE channel_deliveries SET state='sent' WHERE delivery_id=?").run(id); this.db.prepare('UPDATE channel_interaction_cards SET revision=?,binding_scope=? WHERE destination=? AND session_id=? AND interaction_id=?').run(interaction.revision,scope,destination,sessionId,interaction.interactionId); remember(); } return; }
      await guard();
      await this.port.update(destination,row.message_id,this.channel.stamp(destination,view),id,guard); await guard();
      this.db.prepare("UPDATE channel_deliveries SET state='sent' WHERE delivery_id=?").run(id);
      this.db.prepare('UPDATE channel_interaction_cards SET revision=?,binding_scope=? WHERE destination=? AND session_id=? AND interaction_id=?').run(interaction.revision,scope,destination,sessionId,interaction.interactionId); remember();
    } else {
      let messageId = await this.channel.deliver(destination,view,id,guard); await guard();
      if (!messageId) messageId = await this.port.lookupMessageId?.(id) ?? undefined; await guard();
      if (messageId) { this.db.prepare('INSERT OR REPLACE INTO channel_interaction_cards(destination,session_id,interaction_id,revision,message_id,binding_scope) VALUES (?,?,?,?,?,?)').run(destination,sessionId,interaction.interactionId,interaction.revision,messageId,scope); remember(); }
    }
  }
}
