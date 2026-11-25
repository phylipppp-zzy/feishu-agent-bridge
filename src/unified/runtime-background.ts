import { existsSync } from 'node:fs';
import type { Session } from './contracts.js';
import type { UnifiedRuntime } from './runtime.js';
import type { RuntimeInteractive } from './runtime-interactive.js';

export async function runBackgroundWork(
  runtime: UnifiedRuntime,
  interactive: RuntimeInteractive,
  drainResources: () => Promise<void> | undefined,
  refresh: () => Promise<void> | undefined,
  requireReadonlyHydration: boolean,
  settleIntake: boolean,
): Promise<void> {
  let failed = false;
  const isolate = async (run: () => Promise<void> | undefined) => {
    try {
      await run();
    } catch {
      failed = true;
    }
  };
  interactive.recoverInbox();
  await drainResources();
  if (settleIntake) await isolate(() => interactive.flushInteractive());
  const activeOperation = (id: string) => interactive.hasOperation(id);
  await runtime.core.dispatchPending(activeOperation);
  await isolate(() => runtime.channel.advanceCompleted(op => interactive.notifyOperation(op.operationId), activeOperation));
  await isolate(refresh);
  const bindings = new Map(runtime.channel.bindingsForRestore().map(binding => [binding.destination, binding]));
  for (const destination of runtime.channel.boundDestinations()) {
    const binding = bindings.get(destination);
    let session: Session | undefined;
    if (binding) {
      try { session = runtime.store.getSession(binding.sessionId); } catch {}
    }
    if (session && session.status === 'read_only' && session.control.input !== 'available' && !existsSync(session.project)) continue;
    if (requireReadonlyHydration && binding?.accessMode === 'read_only' && !runtime.channel.readonlyHydrated(destination, binding.sessionId)) continue;
    await isolate(() => interactive.syncChannel(destination));
  }
  for (const binding of runtime.taskChannel?.listActiveBindings() ?? []) {
    await isolate(() => interactive.syncTask(binding.taskId));
  }
  const unknownDeliveries = runtime.channel.pendingDeliveries().length;
  const unknownInbox = runtime.channel.unknownInbox().length;
  if (unknownDeliveries > 0 || unknownInbox > 0) {
    runtime.emitWatchEvent({
      source: 'watch',
      objectId: 'runtime:unknown-deliveries',
      state: 'alert',
      severity: 'low',
      title: '存在未确认投递或入站记录',
      summary: `当前存在 ${unknownDeliveries} 条未确认投递、${unknownInbox} 条未知入站记录，请核对。`,
    });
  }
  if (runtime.watchHub?.listOutbox().some(row => row.state === 'pending')) {
    await isolate(async () => { await runtime.watchHub?.flush(); });
  }
  await isolate(() => syncPendingHub(runtime));
  if (runtime.decisionSync?.listDocOutbox().some(row => row.state === 'pending_sync')) {
    await isolate(async () => { runtime.decisionSync?.retryPendingSyncs(); });
  }
  if (failed) throw new Error('isolated work failed');
}

async function syncPendingHub(runtime: UnifiedRuntime): Promise<void> {
  const hub = runtime.pendingHub;
  if (!hub) return;
  const bindSource = (sessionId: string, destination: string) => {
    if (hub.getSourceDestination(sessionId) !== destination) hub.bindSourceSession(sessionId, destination);
  };
  for (const binding of runtime.channel.bindingsForRestore()) bindSource(binding.sessionId, binding.destination);
  const taskChannel = runtime.taskChannel;
  if (taskChannel) {
    for (const binding of taskChannel.listActiveBindings()) {
      for (const target of taskChannel.listTargets(binding.taskId)) {
        if (target.accessMode === 'interactive') bindSource(target.sessionId, binding.destination);
      }
    }
  }
  const trackedCards = [...runtime.channel.listInteractionCards(), ...(taskChannel?.listInteractionCards() ?? [])];
  for (const card of trackedCards) {
    try {
      const interaction = await runtime.core.getInteraction(card.interactionId);
      const session = await runtime.core.getSession(card.sessionId);
      if (interaction.status !== 'awaiting_answer' || session.status === 'read_only' || session.control.input !== 'available') continue;
      const existing = hub.getRef(`interaction:${interaction.interactionId}`);
      if (!existing || (existing.card_active === 1 && (existing.source_card_message_id !== card.messageId || existing.revision < interaction.revision))) {
        await hub.trackSourceCard({
          interactionId: interaction.interactionId, category: interaction.kind === 'approval' ? 'approval' : 'question',
          provider: session.native.provider, sourceSessionId: card.sessionId, sourceDestination: card.destination,
          messageId: card.messageId, revision: interaction.revision, connectionGeneration: interaction.connectionGeneration,
        });
      }
    } catch {}
  }
  await hub.sync();
}
