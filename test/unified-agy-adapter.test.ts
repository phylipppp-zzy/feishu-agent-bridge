import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { AgyAdapter } from '../src/unified/agy-adapter.js';
import { classifyAgyPermission, mergeAgyToolCall } from '../src/unified/agy/adapter-permission.js';
import { AgyCatalog } from '../src/unified/agy-catalog.js';
import { AgyQuotaClient } from '../src/unified/agy-quota.js';
import { AgyAcpTransport } from '../src/unified/agy-transport.js';
import type { DispatchGuard, PlatformObservation, PlatformPort } from '../src/unified/adapter.js';
import {
  payloadDigest,
  type Interaction,
  type Message,
  type NativeSessionRef,
  type Provider,
  type Session,
  type Turn,
} from '../src/unified/contracts.js';
import { FeishuChannel, type ChannelAction, type FeishuPort, type TrustedEnvelope } from '../src/unified/feishu-channel.js';
import type { ChannelCard } from '../src/unified/feishu-cards.js';
import { UnifiedCore } from '../src/unified/service.js';
import { UnifiedStore } from '../src/unified/store.js';
import {
  createIntegratedRuntime,
  createLiveRuntime,
  UnifiedRuntime,
  validateRuntimeConfig,
  type RuntimeConfig,
} from '../src/unified/runtime.js';

interface SummaryRowSeed {
  conversation_id: string;
  title?: string;
  preview?: string;
  step_count?: number;
  status?: string;
  source?: string;
  project_id?: string;
  last_modified_time?: string | null;
  last_user_input_time?: string | null;
  last_user_input_step_index?: number;
  workspace_uris?: string;
  nesting_depth?: number;
  parent_conversation_id?: string;
  agent_name?: string;
  battle_id?: string;
  winning_conversation_id?: string;
  not_fully_idle?: number;
  killed?: number;
  app_data_dir?: string;
  group_id?: string;
}

function createSummariesDb(dbPath: string, rows: SummaryRowSeed[]): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT "",
        preview TEXT NOT NULL DEFAULT "",
        step_count INTEGER NOT NULL DEFAULT 0,
        last_modified_time datetime NOT NULL,
        workspace_uris TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT "",
        source TEXT NOT NULL DEFAULT "",
        project_id TEXT NOT NULL DEFAULT "",
        agent_name TEXT NOT NULL DEFAULT "",
        parent_conversation_id TEXT NOT NULL DEFAULT "",
        nesting_depth INTEGER NOT NULL DEFAULT 0,
        battle_id TEXT NOT NULL DEFAULT "",
        winning_conversation_id TEXT NOT NULL DEFAULT "",
        not_fully_idle numeric NOT NULL DEFAULT false,
        killed numeric NOT NULL DEFAULT false,
        last_user_input_time datetime NOT NULL,
        last_user_input_step_index INTEGER NOT NULL DEFAULT -1,
        app_data_dir TEXT NOT NULL DEFAULT "",
        raw_summary BLOB,
        group_id TEXT NOT NULL DEFAULT ""
      );
    `);
    const insert = db.prepare(`
      INSERT INTO conversation_summaries (
        conversation_id, title, preview, step_count, last_modified_time,
        workspace_uris, status, source, project_id, agent_name,
        parent_conversation_id, nesting_depth, battle_id, winning_conversation_id,
        not_fully_idle, killed, last_user_input_time, last_user_input_step_index,
        app_data_dir, raw_summary, group_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of rows) {
      insert.run(
        r.conversation_id,
        r.title ?? '',
        r.preview ?? '',
        r.step_count ?? 0,
        r.last_modified_time ?? '2026-11-22 10:00:00.000000000+00:00',
        r.workspace_uris ?? '[]',
        r.status ?? 'CASCADE_RUN_STATUS_IDLE',
        r.source ?? 'CORTEX_TRAJECTORY_SOURCE_CLI',
        r.project_id ?? '',
        r.agent_name ?? '',
        r.parent_conversation_id ?? '',
        r.nesting_depth ?? 0,
        r.battle_id ?? '',
        r.winning_conversation_id ?? '',
        r.not_fully_idle ?? 0,
        r.killed ?? 0,
        r.last_user_input_time ?? '0001-01-01 00:00:00+00:00',
        r.last_user_input_step_index ?? -1,
        r.app_data_dir ?? 'antigravity',
        null,
        r.group_id ?? '',
      );
    }
  } finally {
    db.close();
  }
}

function jsonl(...lines: unknown[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

async function writeTranscript(
  brainDir: string,
  convId: string,
  compactSteps: unknown[],
  fullSteps?: unknown[],
): Promise<void> {
  const logsDir = join(brainDir, convId, '.system_generated', 'logs');
  await mkdir(logsDir, { recursive: true });
  await writeFile(join(logsDir, 'transcript.jsonl'), jsonl(...compactSteps), 'utf8');
  if (fullSteps) {
    await writeFile(join(logsDir, 'transcript_full.jsonl'), jsonl(...fullSteps), 'utf8');
  }
}

async function writeFakeAgyBinary(
  binPath: string,
  rpcLogPath: string,
  dropFlagPath: string,
  listedSessions?: Array<{ sessionId: string; cwd: string; title: string }>,
): Promise<void> {
  const script = `#!/usr/bin/env node
import { appendFileSync, createReadStream, existsSync, unlinkSync, writeSync } from 'node:fs';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const rpcLogPath = ${JSON.stringify(rpcLogPath)};
const dropFlagPath = ${JSON.stringify(dropFlagPath)};
const listedSessions = ${JSON.stringify(listedSessions)};
const log = (entry) => appendFileSync(rpcLogPath, JSON.stringify(entry) + '\\n');

if (args.includes('/usage')) {
  writeSync(1, JSON.stringify({
    status: 'SUCCESS',
    command: {
      data: {
        groups: [{
          name: 'Gemini',
          buckets: [{ modelId: 'gemini-4-hydrogen', remainingFraction: 0.88, resetTime: 1893456000 }],
        }],
      },
    },
  }) + '\\n');
  process.exit(0);
}

if (!args.includes('acp')) {
  writeSync(2, 'unexpected command: ' + args.join(' ') + '\\n');
  process.exit(2);
}

let seq = 0;
let srvReqId = 1000;
const pendingServerReplies = new Map();
const activePrompts = new Map();
const allowMatchingExecution = new Map();

const writeMsg = (obj) => {
  writeSync(1, JSON.stringify(obj) + '\\n');
};

const sendServerRequest = (method, params) => {
  const id = 'srv-' + (++srvReqId);
  writeMsg({ jsonrpc: '2.0', id, method, params });
  return new Promise((resolve, reject) => {
    pendingServerReplies.set(id, { resolve, reject });
  });
};

// Read the inherited descriptor directly so the mock works in restricted stdio environments.
const rl = createInterface({ input: createReadStream(undefined, { fd: 0, autoClose: false }), crlfDelay: Infinity });
rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); } catch { return; }

  // Response to server->client request
  if ((msg.id !== undefined && msg.method === undefined) && pendingServerReplies.has(msg.id)) {
    const waiter = pendingServerReplies.get(msg.id);
    pendingServerReplies.delete(msg.id);
    if (msg.error) waiter.reject(msg.error);
    else waiter.resolve(msg.result);
    return;
  }

  const { id, method, params } = msg;
  log({ method, params });

  const reply = (result) => {
    if (id !== undefined) writeMsg({ jsonrpc: '2.0', id, result });
  };

  if (method === 'initialize') {
    reply({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      agentInfo: { name: 'fake-agy', version: '1.5.14-test' },
    });
    return;
  }

  if (method === 'session/list') {
    if (listedSessions === undefined) {
      writeMsg({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
    } else if (params.cursor === 'second') {
      reply({ sessions: listedSessions.slice(1), nextCursor: null });
    } else {
      reply({ sessions: listedSessions.slice(0, 1), nextCursor: 'second' });
    }
    return;
  }

  if (method === 'session/new') {
    const sid = 'agy-live-' + (++seq);
    reply({
      sessionId: sid,
      models: {
        availableModels: [
          { modelId: 'gemini-4-hydrogen-high', name: 'Gemini 4 Hydrogen High' },
          { modelId: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
        ],
      },
      configOptions: [{ id: 'thought_level', category: 'thought_level' }],
    });
    return;
  }

  if (method === 'session/load') {
    reply({
      sessionId: params.sessionId,
      models: {
        availableModels: [
          { modelId: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen' },
          { modelId: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
        ],
      },
      configOptions: [{ id: 'thought_level', category: 'thought_level' }],
    });
    return;
  }

  if (method === 'session/set_model' || method === 'session/set_config_option' || method === 'session/close') {
    reply({});
    return;
  }

  if (method === 'test/release_matching_execution') {
    allowMatchingExecution.get(params.sessionId)?.();
    allowMatchingExecution.delete(params.sessionId);
    reply({});
    return;
  }

  if (method === 'session/cancel') {
    const entry = activePrompts.get(params.sessionId);
    if (entry) {
      entry.cancelled = true;
      activePrompts.delete(params.sessionId);
      entry.finish({ stopReason: 'cancelled' });
    }
    reply({});
    return;
  }

  if (method === 'session/prompt') {
    const sid = params.sessionId;
    const text = Array.isArray(params.prompt)
      ? params.prompt.map((b) => (b && b.type === 'text' ? b.text : '')).join('\\n')
      : '';

    const emitChunk = (chunkText, messageId) => writeMsg({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: sid,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId,
          content: { type: 'text', text: chunkText },
        },
      },
    });
    const emitTool = (toolCallId, status, args = {}) => writeMsg({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: sid,
        update: { sessionUpdate: 'tool_call_update', toolCallId, status, ...args },
      },
    });
    const permissionOptions = [
      { optionId: 'allow_always', kind: 'allow_always', name: 'Always allow' },
      { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
      { optionId: 'reject_once', kind: 'reject_once', name: 'Reject once' },
    ];

    if (text === 'multi-step') {
      emitChunk('Opening', 'step-a');
      emitTool('step-tool', 'completed', { sessionUpdate: 'tool_call', name: 'read_file' });
      emitChunk('After tool', 'step-a');
      emitChunk('Next item', 'step-b');
      emitTool('final-tool', 'completed', { name: 'read_file' });
      reply({ stopReason: 'end_turn', response: 'Post-tool result' });
      return;
    }
    if (text === 'completion-prefix') {
      emitChunk('Partial');
      reply({ stopReason: 'end_turn', response: 'Partial now complete' });
      return;
    }
    if (text === 'completion-suffix') {
      await new Promise(resolve => allowMatchingExecution.set(sid, resolve));
      emitTool('before-stream', 'completed', { name: 'read_file' });
      emitChunk('Later paragraph');
      reply({ stopReason: 'end_turn' });
      return;
    }
    if (text === 'completion-divergent') {
      emitChunk('Live only\\n\\nShared');
      reply({ stopReason: 'end_turn' });
      return;
    }

    if (text.startsWith('tool-progress:')) {
      const terminal = text.split(':')[1];
      const input = { TargetFile: 'outputs/eval_summary.md', Content: 'do not display this content' };
      emitTool('tool-progress', 'pending', { sessionUpdate: 'tool_call', name: 'edit_file', rawInput: input });
      emitTool('tool-progress', 'in_progress');
      emitTool('tool-progress', 'in_progress');
      emitTool('tool-progress', terminal, { rawOutput: 'do not display output' });
      emitTool('tool-progress', 'in_progress');
      reply({ stopReason: 'end_turn' });
      return;
    }

    if (text.includes('flow-allow') || text.includes('flow-deny')) {
      emitChunk('Working...');
      emitTool('tc-perm-1', 'pending', {
        kind: 'execute', rawInput: { CommandLine: 'sudo systemctl restart nginx' },
      });
      const permRes = await sendServerRequest('session/request_permission', {
        sessionId: sid,
        toolCall: {
          toolCallId: 'tc-perm-1', title: 'Run shell check', kind: 'execute',
          rawInput: { CommandLine: 'sudo systemctl restart nginx' },
        },
        options: permissionOptions,
      });
      log({ permissionCase: text, permissionReply: permRes });
      const accepted = permRes?.outcome?.optionId === 'allow_once';
      if (accepted) {
        const release = new Promise(resolve => allowMatchingExecution.set(sid, resolve));
        emitTool('unrelated-tool', 'in_progress');
        emitChunk(' Waiting for execution.');
        await release;
      }
      emitTool('tc-perm-1', 'in_progress');
      emitChunk(accepted ? ' Allowed!' : ' Denied!');
      reply({ stopReason: 'end_turn' });
      return;
    }

    if (text.startsWith('flow-auto')) {
      const toolCallId = 'tc-auto';
      const command = 'git status -sb && rg -n "UnifiedCore" src/unified | head -n 5';
      const rawInput = { CommandLine: command };
      let toolCall = { toolCallId, title: 'Run shell check', kind: 'execute', rawInput };
      let options = permissionOptions;
      if (text === 'flow-auto-incremental') {
        emitTool(toolCallId, 'pending', { ...toolCall, args: rawInput });
        toolCall = { toolCallId };
        options = [{ optionId: 'allow_always', kind: 'allow_always' }, { optionId: 'allow_once' }];
      } else if (text === 'flow-auto-scoped-root') {
        toolCall = { ...toolCall, rawInput: { CommandLine: 'pwd', Cwd: '..' } };
      } else if (text === 'flow-auto-bypass') {
        toolCall = { ...toolCall, rawInput: { ...rawInput, BypassSandbox: true } };
      } else if (text === 'flow-auto-updated') {
        emitTool(toolCallId, 'pending', { kind: 'execute', rawInput: { CommandLine: 'pwd' } });
        toolCall = { ...toolCall, rawInput: { CommandLine: 'pwd', WaitMsBeforeAsync: 500 } };
      } else if (text === 'flow-auto-evicted') {
        emitTool(toolCallId, 'pending', { kind: 'execute', rawInput: { CommandLine: 'pwd', BypassSandbox: true } });
        for (let i = 0; i < 128; i++) emitTool('pending-' + i, 'pending', { rawInput });
        for (const status of ['completed', 'failed', 'cancelled']) {
          emitTool(status, status, { kind: 'execute', content: ['large'.repeat(1024)], rawOutput: rawInput, args: rawInput });
        }
        toolCall = { ...toolCall, rawInput: { CommandLine: 'pwd' } };
      } else if (text === 'flow-auto-deny') {
        toolCall = {
          toolCallId, title: 'Edit project file', kind: 'edit',
          rawInput: { TargetFile: (process.env.HOME || '/tmp') + '/projects/projtool/src/index.ts' },
        };
        options = [{ optionId: 'allow_always', kind: 'allow_always' }, { optionId: 'reject_always', kind: 'reject_always' }];
      }
      const result = await sendServerRequest('session/request_permission', { sessionId: sid, toolCall, options });
      log({ permissionCase: text, permissionReply: result });
      reply({ stopReason: 'end_turn' });
      return;
    }

    if (text.includes('flow-elicit')) {
      const elicitRes = await sendServerRequest('elicitation/create', {
        sessionId: sid,
        toolCallId: 'tc-elicit-1',
        message: 'Confirm release target',
        requestedSchema: {
          type: 'object',
          properties: {
            env: { type: 'string', description: 'Target environment', enum: ['staging', 'prod'] },
            note: { type: 'string', description: 'Deploy note' },
          },
        },
      });
      log({ elicitationReply: elicitRes });
      emitChunk('Elicited:' + JSON.stringify(elicitRes?.content ?? {}));
      reply({ stopReason: 'end_turn' });
      return;
    }

    if (text.includes('flow-drop')) {
      void sendServerRequest('session/request_permission', {
        sessionId: sid,
        toolCall: {
          toolCallId: 'tc-drop-1', title: 'Pending before crash', kind: 'execute',
          rawInput: { CommandLine: 'sudo true' },
        },
        options: permissionOptions,
      }).catch(() => {});
      if (existsSync(dropFlagPath)) {
        try { unlinkSync(dropFlagPath); } catch {}
        setTimeout(() => process.kill(process.pid, 'SIGKILL'), 60);
      }
      return;
    }

    if (text.includes('flow-cancel')) {
      writeMsg({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: sid,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc-cancel-1',
            title: 'Long command',
            status: 'in_progress',
          },
        },
      });
      await new Promise((resolve) => {
        activePrompts.set(sid, { cancelled: false, finish: resolve });
      }).then((res) => reply(res));
      return;
    }

    emitChunk('Echo:' + text);
    reply({ stopReason: 'end_turn' });
  }
});
`;
  await writeFile(binPath, script, 'utf8');
  await chmod(binPath, 0o755);
}

function makeGuard(expectedConnectionGeneration: number | null, current = true): DispatchGuard {
  return {
    expectedControlGeneration: 0,
    expectedConnectionGeneration,
    assertCurrent() {
      if (!current) throw new Error('stale control guard');
    },
  };
}

function createFakeFeishuPort() {
  let seq = 0;
  let topicSeq = 0;
  const routes = new Map<string, { chatId: string; sessionId: string }>();
  const deliveries = new Map<string, string>();
  const sentCards: Array<{ destination: string; card: ChannelCard; deliveryId: string; messageId: string }> = [];
  const updatedCards: Array<{ destination: string; messageId: string; card: ChannelCard; deliveryId: string }> = [];
  const topicCards: Array<{ chatId: string; topicDestination: string; sessionId: string; card: ChannelCard; deliveryId: string }> = [];
  const authorized = new Set<string>(['chat-main']);

  const port: FeishuPort & {
    authorizedDestination: (d: string) => boolean;
    onResourceHealth?: (status: 'healthy' | 'degraded', reason: string | null) => void;
  } = {
    authorizedDestination: (d) => authorized.has(d),
    async createTopic(destination, sessionId, card, deliveryId, guard) {
      await guard?.();
      for (const [k, v] of routes) {
        if (v.chatId === destination && v.sessionId === sessionId) return k;
      }
      const topicDest = `topic-${++topicSeq}`;
      routes.set(topicDest, { chatId: destination, sessionId });
      authorized.add(topicDest);
      deliveries.set(deliveryId, topicDest);
      topicCards.push({ chatId: destination, topicDestination: topicDest, sessionId, card, deliveryId });
      return topicDest;
    },
    async send(destination, card, deliveryId, guard) {
      await guard?.();
      const messageId = `msg-${++seq}`;
      deliveries.set(deliveryId, messageId);
      sentCards.push({ destination, card, deliveryId, messageId });
      return messageId;
    },
    async update(destination, messageId, card, deliveryId, guard) {
      await guard?.();
      deliveries.set(deliveryId, messageId);
      updatedCards.push({ destination, messageId, card, deliveryId });
    },
    async sendFile(_destination, _name, _content, deliveryId, guard) {
      await guard?.();
      deliveries.set(deliveryId, `file-${++seq}`);
    },
    async lookupDelivery(id) {
      return deliveries.has(id) ? 'sent' : 'unknown';
    },
  };

  return { port, sentCards, updatedCards, topicCards, routes };
}

class MemoryMockPort implements PlatformPort {
  readonly provider: Provider;
  private readonly listeners = new Set<(o: PlatformObservation) => void>();
  private readonly sessions = new Map<string, Session>();
  private readonly messages = new Map<string, Message[]>();
  private seq = 0;

  constructor(
    provider: 'claude' | 'codex',
    private readonly hostId: string,
    private readonly serviceId: string,
    private readonly projectRoot: string,
  ) {
    this.provider = provider;
  }

  onObservation(listener: (o: PlatformObservation) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(o: PlatformObservation): void {
    for (const l of this.listeners) l(o);
  }

  seedSession(nativeSessionId: string, title: string, project = this.projectRoot): Session {
    const native: NativeSessionRef = {
      provider: this.provider,
      hostId: this.hostId,
      serviceId: this.serviceId,
      nativeSessionId,
    };
    const now = new Date().toISOString();
    const session: Session = {
      sessionId: nativeSessionId,
      native,
      title,
      project,
      status: 'idle',
      revision: 1,
      createdAt: now,
      updatedAt: now,
      capabilities: {
        view: { status: 'available' },
        send: { status: 'available' },
        queue: { status: 'unsupported', reason: 'mock' },
        steer: { status: this.provider === 'codex' ? 'available' : 'unsupported', reason: 'codex only' },
        answer: { status: 'available' },
        approve: { status: 'available' },
        interrupt: { status: 'available' },
        handoff: { status: 'unsupported', reason: 'mock' },
        files: { status: 'available' },
        config: { status: 'available' },
      },
      control: {
        serviceId: this.serviceId,
        owner: null,
        input: 'available',
        generation: 0,
        operationId: null,
        reason: null,
      },
    };
    this.sessions.set(nativeSessionId, session);
    this.messages.set(nativeSessionId, []);
    return session;
  }

  async list() {
    return { items: [...this.sessions.values()], nextCursor: null };
  }

  async discoverRunning() {
    return { items: [], nextCursor: null };
  }

  async read(ref: NativeSessionRef) {
    const session = this.sessions.get(ref.nativeSessionId);
    if (!session) throw new Error(`missing session ${ref.nativeSessionId}`);
    return {
      session,
      messages: this.messages.get(ref.nativeSessionId) ?? [],
      turns: [],
      interactions: [],
      connectionGeneration: 1,
    };
  }

  async create(cwd: string, _model: string | null) {
    const id = `${this.provider}-created-${++this.seq}`;
    const s = this.seedSession(id, `${this.provider} ${id}`, cwd);
    return { status: 'submitted' as const, nativeReference: id, createdSession: s, connectionGeneration: 1 };
  }

  async resume(ref: NativeSessionRef) {
    return { status: 'submitted' as const, nativeReference: ref.nativeSessionId, connectionGeneration: 1 };
  }

  async input(ref: NativeSessionRef, _mode: 'new' | 'steer', blocks: Array<{ type: 'text'; text: string } | { type: 'artifact' }>) {
    const turnId = `turn-${++this.seq}`;
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '[file]')).join(' ');
    const reply: Message = {
      messageId: `m-${++this.seq}`,
      sessionId: ref.nativeSessionId,
      turnId,
      role: 'assistant',
      blocks: [{ type: 'text', text: `${this.provider} reply: ${text}` }],
      sequence: this.seq,
      revision: 1,
      final: true,
      source: this.provider,
    };
    const arr = this.messages.get(ref.nativeSessionId) ?? [];
    arr.push(reply);
    this.messages.set(ref.nativeSessionId, arr);
    const turn: Turn = {
      turnId,
      sessionId: ref.nativeSessionId,
      status: 'completed',
      inputId: turnId,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      model: null,
      outputIds: [reply.messageId],
    };
    this.emit({ type: 'message', ref, message: reply, connectionGeneration: 1 });
    this.emit({ type: 'turn', ref, turn, connectionGeneration: 1 });
    return { status: 'submitted' as const, nativeReference: turnId, connectionGeneration: 1 };
  }

  async interrupt(_ref: NativeSessionRef, turnId: string) {
    return { status: 'submitted' as const, nativeReference: turnId };
  }
  async respond() {
    return { status: 'submitted' as const, nativeReference: null };
  }
  async control(_ref: NativeSessionRef, _action: 'acquire' | 'release') {
    return { status: 'submitted' as const, nativeReference: null };
  }
  async listArtifacts() {
    return [];
  }
  async readArtifact(): Promise<Uint8Array> {
    throw new Error('no artifacts');
  }
  async listModels() {
    return [{ id: `${this.provider}-default`, label: `${this.provider} default`, reasoningEfforts: ['medium'] }];
  }
  async updateSettings() {
    return { status: 'submitted' as const, nativeReference: null, settingsApplied: true as const };
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000, msg = 'condition timed out'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(predicate(), msg);
}

test('Agy permission requires known tool identities and complete, scoped inputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-approval-'));
  try {
    const project = join(root, 'project');
    const outside = join(root, 'other');
    await Promise.all([mkdir(project), mkdir(outside)]);
    await symlink(outside, join(project, 'linked'));

    const command = { CommandLine: 'pwd' };
    const execute = { kind: 'execute', rawInput: command };
    const read = { name: 'view_file', kind: 'read', rawInput: { TargetFile: 'src/index.ts', StartLine: 1 } };
    const write = { name: 'write_to_file', kind: 'edit', rawInput: { TargetFile: 'notes.md', Content: 'hello' } };
    const edit = {
      name: 'edit_file', kind: 'edit',
      rawInput: { Path: 'src/index.ts', Target: `~/original\n${'source content '.repeat(40)}`, Replacement: 'new source' },
    };
    const validCommand = {
      ...execute, name: 'run_command', rawInput: {
        ...command, Cwd: './', BypassSandbox: false, IsDaemon: false, WaitMsBeforeAsync: 500,
        NotificationTimeoutSeconds: 1, toolSummary: 'Print working directory',
      },
    };
    for (const tool of [validCommand, read, write, edit]) {
      assert.equal((await classifyAgyPermission(tool, project)).kind, 'allow_once', JSON.stringify(tool));
    }

    for (const tool of [
      { rawInput: command },
      { ...execute, name: 'upload_file' },
      { ...execute, toolName: 'read_file' },
      { ...execute, toolName: '' },
      { ...execute, rawInput: { ...command, BypassSandbox: true } },
      { ...execute, rawInput: { ...command, BypassSandbox: 'false' } },
      { ...execute, rawInput: { ...command, Shell: 'custom' } },
      { ...execute, args: { Environment: { PATH: '/tmp/custom' } } },
      { ...execute, _meta: { BypassSandbox: true } },
      { ...execute, args: { commandLine: 'git status' } },
      mergeAgyToolCall({ ...execute, rawInput: { ...command, BypassSandbox: true } },
        { rawInput: { BypassSandbox: false } }),
      mergeAgyToolCall({ ...execute, name: 'unknown' }, { name: 'run_command' }),
      { ...read, rawInput: { ...read.rawInput, FollowSymlinks: true } },
      { ...read, locations: [{ path: join(outside, 'data.txt'), line: 1 }] },
      { ...read, args: { TargetFile: 'linked/data.txt' } },
      { ...write, rawInput: { ...write.rawInput, ArtifactMetadata: { path: join(outside, 'artifact') } } },
      { ...write, rawInput: { ...write.rawInput, Content: { path: join(outside, 'artifact') } } },
      { ...edit, rawInput: { ...edit.rawInput, Target: { path: join(outside, 'artifact') } } },
      { ...edit, rawInput: { ...edit.rawInput, Path: join(outside, 'artifact') } },
    ]) {
      assert.equal((await classifyAgyPermission(tool, project)).kind, 'ask', JSON.stringify(tool));
    }

    const otherDirectory = { ...execute, rawInput: { ...command, Cwd: outside } };
    assert.equal((await classifyAgyPermission(otherDirectory, project)).kind, 'ask');
    assert.equal((await classifyAgyPermission(otherDirectory, project, { allowedRoots: [outside] })).kind, 'allow_once');
    assert.equal((await classifyAgyPermission(execute, project, { allowedRoots: [] })).kind, 'allow_once');
    assert.equal((await classifyAgyPermission(execute, project, { enabled: false })).kind, 'ask');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('AgyAdapter list and read prefer paginated ACP titles and share the title cache', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agy-adapter-titles-'));
  const dbPath = join(root, 'conversation_summaries.db');
  const binPath = join(root, 'fake-agy.mjs');
  const rpcLogPath = join(root, 'rpc-log.jsonl');
  const transport = new AgyAcpTransport({ agyBin: binPath });
  const catalog = new AgyCatalog({ dbPath, brainDir: root, allowedProjectRoots: [root] });
  const adapter = new AgyAdapter(transport, catalog, 'host-1', 'agy-svc');
  const sessionId = 'conv-real-title';
  const placeholderId = 'conv-placeholder';
  const workspaceUris = JSON.stringify([pathToFileURL(root).href]);
  try {
    createSummariesDb(dbPath, [
      { conversation_id: sessionId, preview: 'Raw first prompt', workspace_uris: workspaceUris },
      { conversation_id: placeholderId, preview: 'Local fallback', workspace_uris: workspaceUris },
    ]);
    await writeFakeAgyBinary(binPath, rpcLogPath, join(root, 'drop.flag'), [
      { sessionId: placeholderId, cwd: root, title: ' [USER] ' },
      { sessionId, cwd: root, title: ' \u0000Real Client Title\u0007 ' },
    ]);
    const offline = await adapter.list(null, 20);
    const localSession = offline.items.find(item => item.native.nativeSessionId === sessionId);
    assert.equal(localSession?.title, 'Raw first prompt');
    await transport.connect();

    const [listed, read] = await Promise.all([adapter.list(null, 20), adapter.read(localSession.native)]);
    assert.equal(listed.items.find(item => item.native.nativeSessionId === sessionId)?.title, 'Real Client Title');
    assert.equal(read.session.title, 'Real Client Title');
    assert.equal(listed.items.find(item => item.native.nativeSessionId === placeholderId)?.title, 'Local fallback');
    assert.equal((await adapter.read(localSession.native)).session.title, 'Real Client Title');

    const calls = (await readFile(rpcLogPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(calls.filter(call => call.method === 'session/list').map(call => call.params), [
      {}, { cursor: 'second' },
    ]);

    const afterExpiry = Date.now() + 15_001;
    t.mock.method(Date, 'now', () => afterExpiry);
    const failedRefresh = t.mock.method(transport, 'request', async () => {
      throw new Error('session/list unavailable');
    });
    assert.equal((await adapter.read(localSession.native)).session.title, 'Real Client Title');
    assert.equal(failedRefresh.mock.callCount(), 1);
    assert.equal(transport.health().status, 'healthy');
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('AgyAdapter end-to-end ACP lifecycle, read-only catalog, transcript backfill, permission/elicitation, stale generation, cancel, resume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-adapter-e2e-'));
  try {
    const projectDir = join(root, 'workspace', 'proj-1');
    const outsideDir = join(root, 'outside');
    const brainDir = join(root, 'brain');
    const dbPath = join(root, 'conversation_summaries.db');
    const binPath = join(root, 'fake-agy.mjs');
    const rpcLogPath = join(root, 'rpc-log.jsonl');
    const dropFlagPath = join(root, 'drop-once.flag');

    await mkdir(projectDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    await mkdir(brainDir, { recursive: true });
    await writeFile(rpcLogPath, '', 'utf8');
    await writeFile(dropFlagPath, '1', 'utf8');
    await writeFakeAgyBinary(binPath, rpcLogPath, dropFlagPath);

    const topId = 'conv-top-001';
    createSummariesDb(dbPath, [
      {
        conversation_id: topId,
        title: 'Inspect Agy Repo',
        step_count: 2,
        status: 'CASCADE_RUN_STATUS_IDLE',
        last_modified_time: '2026-11-22T10:05:00Z',
        last_user_input_time: '2026-11-22T10:00:00Z',
        workspace_uris: JSON.stringify([pathToFileURL(projectDir).href]),
        nesting_depth: 0,
        parent_conversation_id: '',
        agent_name: '',
      },
      {
        conversation_id: 'conv-sub-001',
        nesting_depth: 1,
        parent_conversation_id: topId,
        agent_name: 'worker-a',
        status: 'CASCADE_RUN_STATUS_RUNNING',
        workspace_uris: JSON.stringify([pathToFileURL(projectDir).href]),
      },
      {
        conversation_id: 'conv-outside-001',
        title: 'Untrusted outside workspace',
        nesting_depth: 0,
        workspace_uris: JSON.stringify([pathToFileURL(outsideDir).href]),
      },
    ]);

    const fullReply = 'FULL_ASSISTANT_CONTENT_' + 'Z'.repeat(500);
    await writeTranscript(
      brainDir,
      topId,
      [
        {
          step_index: 0,
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          status: 'DONE',
          created_at: '2026-11-22T10:00:01Z',
          content: '<USER_REQUEST>\nSummarize repo architecture\n</USER_REQUEST>',
        },
        {
          step_index: 1,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-11-22T10:00:05Z',
          model: 'gemini-4-hydrogen-xhigh',
          content: 'FULL_ASSISTANT_CONTENT_<truncated>',
          truncated_fields: ['content'],
        },
      ],
      [
        { step_index: 0, content: '<USER_REQUEST>\nSummarize repo architecture\n</USER_REQUEST>' },
        { step_index: 1, content: fullReply },
      ],
    );

    const artifactDir = join(brainDir, topId);
    await writeFile(join(artifactDir, 'report.md'), '# Architecture Report\nAll checks passed.\n', 'utf8');
    await writeFile(join(artifactDir, '.system_generated', 'internal.md'), 'SECRET INTERNAL', 'utf8');

    const transport = new AgyAcpTransport({ agyBin: binPath, connectTimeoutMs: 3000, requestTimeoutMs: 5000 });
    const catalog = new AgyCatalog({ dbPath, brainDir, allowedProjectRoots: [join(root, 'workspace')] });
    const quota = new AgyQuotaClient({ agyBin: binPath });
    const adapter = new AgyAdapter(transport, catalog, 'host-1', 'agy-svc-1', quota, {
      approvalPolicy: { allowedRoots: [join(root, 'workspace')] },
    });
    const store = new UnifiedStore(join(root, 'response-evidence.sqlite'));
    const core = new UnifiedCore(store, [adapter], () => true);
    try {

    const observed: PlatformObservation[] = [];
    adapter.onObservation((obs) => observed.push(obs));

    // 1. Read-only discovery & subagent retention & honest boundary
    const refresh = catalog.refreshAsync();
    assert.equal(catalog.refreshAsync(), refresh);
    await refresh;
    const listed = await adapter.list(null, 20);
    assert.equal(listed.items.length, 1);
    const roSession = listed.items[0]!;
    assert.equal(roSession.native.nativeSessionId, topId);
    assert.match(roSession.title, /1 subagent|1 个子任务|1 子代理|subagent/i);
    assert.equal(roSession.capabilities.view.status, 'available');
    assert.equal(roSession.capabilities.send.status, 'unsupported');
    assert.equal(roSession.capabilities.answer.status, 'unsupported');
    assert.equal(roSession.capabilities.approve.status, 'unsupported');
    assert.equal(roSession.capabilities.handoff.status, 'unsupported');
    assert.equal((adapter as PlatformPort).archive, undefined);

    const newer = await adapter.discoverNewer(Date.parse('2026-11-22T09:00:00Z'), null, 10);
    assert.equal(newer.items.length, 1);
    const existing = await adapter.discoverExisting(null, 10);
    assert.equal(existing.items.length, 1);
    const running = await adapter.discoverRunning(null, 10);
    assert.equal(running.items.length, 1); // has 1 active subagent, not nesting_depth > 0 itself

    // Transcript read + truncated_fields backfill + artifact whitelist
    const snapRo = await adapter.read({
      provider: 'agy',
      hostId: 'host-1',
      serviceId: 'agy-svc-1',
      nativeSessionId: topId,
    });
    assert.equal(snapRo.messages.length, 2);
    assert.equal(snapRo.messages[0]!.role, 'user');
    assert.deepEqual(snapRo.messages[1]!.blocks, [{ type: 'text', text: fullReply }]);

    const artifacts = await adapter.listArtifacts(roSession.native);
    assert.deepEqual(artifacts.map((a) => a.name), ['report.md']);
    const bytes = await adapter.readArtifact(roSession.native, artifacts[0]!.artifactId, artifacts[0]!.contentVersion);
    assert.match(Buffer.from(bytes).toString('utf8'), /Architecture Report/);

    // 2. Connect ACP -> create -> models/updateSettings (effort stripping)
    await transport.connect();
    const gen1 = transport.connectionGeneration;
    assert.ok(gen1 >= 1);

    const createdAck = await adapter.create(projectDir, 'gemini-4-hydrogen-high');
    assert.equal(createdAck.status, 'submitted');
    assert.equal(createdAck.nativeReference, 'agy-live-1');
    const liveRef = createdAck.createdSession!.native;
    const session = createdAck.createdSession!;
    assert.equal(session.capabilities.handoff.status, 'available');
    store.insertSession(session);
    store.setConnectionGeneration(session.sessionId, 0, gen1);
    assert.equal(adapter.hasActiveNativeSession(liveRef), true);
    assert.equal(adapter.hasActiveNativeSession(roSession.native), false);
    assert.equal(adapter.hasActiveNativeSession({ ...liveRef, hostId: 'different-host' }), false);
    const submitDecision = async (interaction: Interaction, operationId: string, decision: 'allow' | 'deny') => {
      await core.resolveInteraction({
        context: {
          operationId, idempotencyKey: operationId, targetId: session.sessionId,
          expectedRevision: interaction.revision, controlGeneration: session.control.generation,
          identity: { source: 'feishu', subject: 'ou_owner' },
        },
        interactionId: interaction.interactionId,
        toolInputDigest: interaction.toolInputDigest,
        expectedConnectionGeneration: interaction.connectionGeneration,
        answer: { kind: 'approval', scope: 'this_request', decision },
      });
      assert.equal((await core.dispatch(operationId)).status, 'accepted');
      assert.equal(store.getOutbox(operationId).state, 'done');
    };

    const models = await adapter.listModels(liveRef);
    assert.ok(models.some((m) => m.id === 'gemini-4-hydrogen' && m.reasoningEfforts?.includes('xhigh')));
    assert.ok(!models.some((m) => /-high$/i.test(m.id)));

    const updAck = await adapter.updateSettings(liveRef, { model: 'gemini-4-hydrogen-xhigh', preferences: {} }, makeGuard(gen1));
    assert.equal(updAck.settingsApplied, true);

    // 3. Reject steer input
    await assert.rejects(
      () => adapter.input(liveRef, 'steer', [{ type: 'text', text: 'noop' }], makeGuard(gen1)),
      (err: unknown) => typeof err === 'object' && err !== null && (err as { code?: string }).code === 'unsupported',
    );

    const earlierParagraph = '    earlier code\n    with preserved indentation';
    const suffixSteps = [
      { step_index: 11, type: 'USER_INPUT', content: '<USER_REQUEST>completion-suffix</USER_REQUEST>' },
      { step_index: 12, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'earlier <truncated 30 bytes>', truncated_fields: ['content'] },
      { step_index: 13, type: 'RUN_COMMAND', status: 'DONE' },
      { step_index: 14, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Later paragraph' },
    ];
    const fullSuffix = [{ step_index: 12, type: 'PLANNER_RESPONSE', content: earlierParagraph }];
    const liveReplies = new Map<string, Message>();
    for (const [prompt, expected] of [
      ['multi-step', 'Opening\n\nAfter tool\n\nNext item\n\nPost-tool result'],
      ['completion-prefix', 'Partial now complete'],
      ['completion-suffix', 'Later paragraph'],
      ['completion-divergent', 'Live only\n\nShared'],
    ] as const) {
      const start = observed.length;
      const ack = await adapter.input(liveRef, 'new', [{ type: 'text', text: prompt }], makeGuard(gen1));
      if (prompt === 'completion-suffix') {
        await writeTranscript(brainDir, liveRef.nativeSessionId, suffixSteps.slice(0, 2), fullSuffix);
        const running = await adapter.read(liveRef);
        assert.equal(running.messages.some(message => message.turnId === 'step-12'), false);
        await transport.request('test/release_matching_execution', { sessionId: liveRef.nativeSessionId });
      }
      await waitFor(() => observed.slice(start).some(o => o.type === 'turn' && o.turn.status === 'completed'));
      const assistant = observed.slice(start).find(o =>
        o.type === 'message' && o.message.role === 'assistant' && o.message.final);
      assert.ok(assistant?.type === 'message');
      assert.equal(assistant.message.turnId, ack.nativeReference);
      assert.deepEqual(assistant.message.blocks, [{ type: 'text', text: expected }]);
      liveReplies.set(prompt, assistant.message);
    }
    const preSuffix = [
      { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>multi-step</USER_REQUEST>' },
      ...['Opening', 'After tool', 'Next item', 'Post-tool result'].map((content, i) =>
        ({ step_index: i + 1, type: 'PLANNER_RESPONSE', status: 'DONE', content })),
      { step_index: 5, type: 'USER_INPUT', content: '<USER_REQUEST>completion-prefix</USER_REQUEST>' },
      { step_index: 6, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Partial now complete on disk' },
      { step_index: 7, type: 'USER_INPUT', content: '<USER_REQUEST>unmatched native prompt</USER_REQUEST>' },
      { step_index: 8, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'unmatched native reply' },
    ];
    const divergentSteps = [
      { step_index: 15, type: 'USER_INPUT', content: 'completion-divergent' },
      { step_index: 16, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Shared' },
      { step_index: 17, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Transcript only' },
    ];
    await writeTranscript(brainDir, liveRef.nativeSessionId, [...preSuffix, ...suffixSteps, ...divergentSteps], fullSuffix);
    const flushed = await adapter.read(liveRef);
    assert.equal(flushed.messages.length, 10);
    assert.deepEqual(flushed.messages.filter(message => message.turnId.startsWith('step-')).map(message => message.turnId),
      ['step-7', 'step-8']);
    const ingested = flushed.messages.find(message => message.messageId === liveReplies.get('completion-prefix')!.messageId);
    assert.equal(ingested?.turnId, liveReplies.get('completion-prefix')!.turnId);
    assert.deepEqual(ingested?.blocks, [{ type: 'text', text: 'Partial now complete on disk' }]);
    const suffixId = liveReplies.get('completion-suffix')!.messageId;
    const fullReplyBlocks = [{ type: 'text', text: `${earlierParagraph}\n\nLater paragraph` }];
    assert.deepEqual(flushed.messages.find(message => message.messageId === suffixId)?.blocks, fullReplyBlocks);
    const divergentId = liveReplies.get('completion-divergent')!.messageId;
    assert.deepEqual(flushed.messages.find(message => message.messageId === divergentId)?.blocks,
      [{ type: 'text', text: 'Live only\n\nShared\n\nTranscript only' }]);

    // Reopen native history with an empty live cache. An external CLI turn used the same prompt.
    await writeTranscript(brainDir, liveRef.nativeSessionId, [...preSuffix,
      { step_index: 9, type: 'USER_INPUT', content: 'completion-suffix' },
      { step_index: 10, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'external CLI answer' },
      ...suffixSteps, ...divergentSteps,
    ], fullSuffix);
    createSummariesDb(dbPath, [{ conversation_id: liveRef.nativeSessionId,
      workspace_uris: JSON.stringify([pathToFileURL(projectDir).href]) }]);
    const restarted = new AgyAdapter(new AgyAcpTransport({ agyBin: binPath }),
      new AgyCatalog({ dbPath, brainDir, allowedProjectRoots: [join(root, 'workspace')] }), 'host-1', 'agy-svc-1', quota);
    try {
      const replay = await restarted.read(liveRef);
      const expected = store.getSession(session.sessionId);
      const before = store.findMessage(session.sessionId, suffixId)!;
      const divergentBefore = store.findMessage(session.sessionId, divergentId)!;
      assert.deepEqual(before.blocks, [{ type: 'text', text: 'Later paragraph' }]);
      assert.equal(store.applyHistoryRefresh(expected, gen1, replay), true);
      const restored = store.snapshot(session.sessionId).value.messages;
      assert.deepEqual(restored.filter(message => message.turnId.startsWith('step-')).map(message => message.turnId),
        ['step-7', 'step-8', 'step-9', 'step-10']);
      assert.deepEqual(store.findMessage(session.sessionId, suffixId),
        { ...before, revision: before.revision + 1, blocks: fullReplyBlocks });
      assert.deepEqual(store.findMessage(session.sessionId, divergentId), divergentBefore);
      const context = { operationId: 'reattach-agy', idempotencyKey: 'reattach-agy', targetId: expected.sessionId,
        expectedRevision: expected.revision, controlGeneration: expected.control.generation,
        identity: { source: 'feishu', subject: 'ou_owner' } };
      store.attachSession(context, expected, { mode: 'read_only' }, null, replay);
      assert.equal(store.applyHistoryRefresh(expected, gen1, replay), true);
      assert.deepEqual(store.snapshot(session.sessionId).value.messages, restored);
    } finally {
      await restarted.close();
    }

    for (const flow of ['flow-auto', 'flow-auto-incremental', 'flow-auto-scoped-root', 'flow-auto-deny']) {
      const start = observed.length;
      await adapter.input(liveRef, 'new', [{ type: 'text', text: flow }], makeGuard(gen1));
      await waitFor(() => observed.slice(start).some(o => o.type === 'turn' && o.turn.status === 'completed'));
      assert.equal(observed.slice(start).filter(o => o.type === 'interaction').length, 0, flow);
    }

    for (const [native, phase] of [['completed', 'succeeded'], ['failed', 'failed'], ['cancelled', 'cancelled']]) {
      const start = observed.length;
      const operation = await adapter.input(liveRef, 'new', [{ type: 'text', text: `tool-progress:${native}` }], makeGuard(gen1));
      await waitFor(() => observed.slice(start).some(o => o.type === 'turn' && o.turn.status === 'completed'));
      const updates = observed.slice(start).flatMap(o => o.type === 'event' && o.event.type === 'tool.updated' ? [o] : []);
      assert.deepEqual(updates.map(o => o.event.data), ['pending', 'running', phase].map(phase => ({
        turnId: operation.nativeReference, callId: 'tool-progress', phase, tool: 'edit_file', summary: 'edit_file · outputs/eval_summary.md',
      })));
      assert.ok(updates.every(o => o.connectionGeneration === gen1));
      assert.equal(observed.slice(start).some(o => o.type === 'message' && o.message.role === 'assistant'), false);
    }

    const bypassStart = observed.length;
    await adapter.input(liveRef, 'new', [{ type: 'text', text: 'flow-auto-bypass' }], makeGuard(gen1));
    const isBypassApproval = (o: PlatformObservation): o is Extract<PlatformObservation, { type: 'interaction' }> =>
      o.type === 'interaction' && o.interaction.kind === 'approval' && o.interaction.status === 'awaiting_answer';
    await waitFor(() => observed.slice(bypassStart).some(isBypassApproval));
    await submitDecision(observed.slice(bypassStart).find(isBypassApproval)!.interaction, 'deny-bypass', 'deny');
    await waitFor(() => observed.slice(bypassStart).some(o => o.type === 'turn' && o.turn.status === 'completed'));

    const updatedStart = observed.length;
    const onServerRequest = transport.onServerRequest;
    transport.onServerRequest = request => {
      onServerRequest(request);
      // The handler has started classifying and cannot resume before this update is processed.
      transport.onNotification({
        generation: gen1, method: 'session/update', params: {
          sessionId: liveRef.nativeSessionId,
          update: {
            sessionUpdate: 'tool_call_update', toolCallId: 'tc-auto', status: 'cancelled',
            rawInput: { CommandLine: 'pwd -P' },
          },
        },
      });
    };
    try {
      await adapter.input(liveRef, 'new', [{ type: 'text', text: 'flow-auto-updated' }], makeGuard(gen1));
      await waitFor(() => observed.slice(updatedStart).some(isBypassApproval));
      const updatedApproval = observed.slice(updatedStart).find(isBypassApproval)!.interaction;
      assert.equal(updatedApproval.kind, 'approval');
      assert.match(updatedApproval.action, /工具调用参数在审批检查期间发生变化/);
      const latestCall = JSON.parse(updatedApproval.action.split('\n')[1]!);
      assert.deepEqual(latestCall.rawInput, { CommandLine: 'pwd -P', WaitMsBeforeAsync: 500 });
      assert.equal(latestCall.status, 'cancelled');
      assert.equal(adapter['activeTurns'].get(liveRef.nativeSessionId)!.toolCalls.get('tc-auto')?.rawInput, undefined);
      await submitDecision(updatedApproval, 'deny-updated', 'deny');
      await waitFor(() => observed.slice(updatedStart).some(o => o.type === 'turn' && o.turn.status === 'completed'));
    } finally {
      transport.onServerRequest = onServerRequest;
    }

    const evictedStart = observed.length;
    await adapter.input(liveRef, 'new', [{ type: 'text', text: 'flow-auto-evicted' }], makeGuard(gen1));
    await waitFor(() => observed.slice(evictedStart).some(isBypassApproval));
    const cachedTurn = adapter['activeTurns'].get(liveRef.nativeSessionId)!;
    assert.equal(cachedTurn.fullToolCalls.size, 128);
    assert.deepEqual(cachedTurn.toolCalls.get('tc-auto'), { toolCallId: 'tc-auto', status: 'pending', kind: 'execute' });
    for (const status of ['completed', 'failed', 'cancelled']) {
      assert.deepEqual(cachedTurn.toolCalls.get(status), { toolCallId: status, status, kind: 'execute' });
    }
    const evictedApproval = observed.slice(evictedStart).find(isBypassApproval)!.interaction;
    assert.ok(evictedApproval.kind === 'approval' && evictedApproval.action.includes('缺少工具调用的完整参数记录'));
    await submitDecision(evictedApproval, 'deny-evicted', 'deny');
    await waitFor(() => observed.slice(evictedStart).some(o => o.type === 'turn' && o.turn.status === 'completed'));

    // 4. Streaming input + permission allow
    const turn1Idx = observed.length;
    await adapter.input(liveRef, 'new', [{ type: 'text', text: 'flow-allow' }], makeGuard(gen1));
    await waitFor(
      () =>
        observed.slice(turn1Idx).some(
          (o) => o.type === 'interaction' && o.interaction.kind === 'approval' && o.interaction.status === 'awaiting_answer',
        ),
      3000,
      'expected approval interaction',
    );
    const permAllowInt = observed
      .slice(turn1Idx)
      .find((o): o is Extract<PlatformObservation, { type: 'interaction' }> =>
        o.type === 'interaction' && o.interaction.kind === 'approval' && o.interaction.status === 'awaiting_answer',
      )!.interaction;

    const allowTurn = adapter['activeTurns'].get(liveRef.nativeSessionId)!;
    assert.ok(allowTurn.toolCalls.get('tc-perm-1')?.rawInput);
    await submitDecision(permAllowInt, 'allow-approval', 'allow');
    await waitFor(() => observed.slice(turn1Idx).some(o =>
      o.type === 'message' && !o.message.final &&
      o.message.blocks.some(block => block.type === 'text' && block.text.includes('Waiting for execution')),
    ));
    assert.equal(store.getOperation('allow-approval').status, 'accepted');
    assert.equal(store.getInteraction(permAllowInt.interactionId).status, 'answer_pending_delivery');
    assert.deepEqual(allowTurn.toolCalls.get('tc-perm-1'), { toolCallId: 'tc-perm-1', status: 'pending', kind: 'execute' });
    await transport.request('test/release_matching_execution', { sessionId: liveRef.nativeSessionId });
    await waitFor(
      () => observed.slice(turn1Idx).some((o) => o.type === 'turn' && o.turn.status === 'completed'),
      3000,
      'expected completed turn after allow',
    );
    const partials = observed.slice(turn1Idx).filter((o): o is Extract<PlatformObservation, { type: 'message' }> => o.type === 'message' && !o.message.final);
    const finals = observed.slice(turn1Idx).filter((o): o is Extract<PlatformObservation, { type: 'message' }> => o.type === 'message' && o.message.final && o.message.role === 'assistant');
    assert.ok(partials.length >= 1, 'expected partial streaming message');
    assert.equal(finals.length, 1);
    assert.match((finals[0]!.message.blocks[0] as { text: string }).text, /^Working\.\.\.\n\n Waiting for execution\.\n\n Allowed!$/);
    assert.equal(store.getOperation('allow-approval').status, 'completed');
    assert.equal(store.getInteraction(permAllowInt.interactionId).status, 'resolved');
    assert.equal(store.getOutbox('allow-approval').state, 'done');

    // 5. Permission deny
    const turnDenyIdx = observed.length;
    await adapter.input(liveRef, 'new', [{ type: 'text', text: 'flow-deny' }], makeGuard(gen1));
    await waitFor(
      () => observed.slice(turnDenyIdx).some((o) => o.type === 'interaction' && o.interaction.kind === 'approval'),
      3000,
    );
    const permDenyInt = observed
      .slice(turnDenyIdx)
      .find((o): o is Extract<PlatformObservation, { type: 'interaction' }> => o.type === 'interaction' && o.interaction.kind === 'approval')!.interaction;
    const denyTurn = adapter['activeTurns'].get(liveRef.nativeSessionId)!;
    transport.onNotification({
      generation: gen1, method: 'session/update', params: {
        sessionId: liveRef.nativeSessionId,
        update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc-perm-1', status: 'cancelled', rawOutput: 'large'.repeat(1024) },
      },
    });
    assert.ok(denyTurn.toolCalls.get('tc-perm-1')?.rawOutput, 'keep terminal payload while the permission request is unanswered');
    await submitDecision(permDenyInt, 'deny-approval', 'deny');
    assert.equal(denyTurn.toolCalls.get('tc-perm-1')?.rawOutput, undefined);
    await waitFor(
      () => observed.slice(turnDenyIdx).some((o) => o.type === 'turn' && o.turn.status === 'completed'),
      3000,
    );
    assert.equal(store.getOperation('deny-approval').status, 'accepted');
    assert.equal(store.getInteraction(permDenyInt.interactionId).nativeResult?.status, 'unknown');
    assert.equal(store.getOutbox('deny-approval').state, 'done');

    // 6. Elicitation Q&A
    const turnElicitIdx = observed.length;
    await adapter.input(liveRef, 'new', [{ type: 'text', text: 'flow-elicit' }], makeGuard(gen1));
    await waitFor(
      () => observed.slice(turnElicitIdx).some((o) => o.type === 'interaction' && o.interaction.kind === 'question_group'),
      3000,
      'expected elicitation question_group',
    );
    const elicitInt = observed
      .slice(turnElicitIdx)
      .find((o): o is Extract<PlatformObservation, { type: 'interaction' }> => o.type === 'interaction' && o.interaction.kind === 'question_group')!.interaction;
    await adapter.respond(
      liveRef,
      elicitInt,
      { kind: 'question_group', answers: { env: ['prod'], note: ['ship it'] } },
      makeGuard(gen1),
    );
    await waitFor(
      () => observed.slice(turnElicitIdx).some((o) => o.type === 'turn' && o.turn.status === 'completed'),
      3000,
    );

    // 7. Interrupt + honest TurnResidual
    const turnCancelIdx = observed.length;
    const cancelAck = await adapter.input(liveRef, 'new', [{ type: 'text', text: 'flow-cancel' }], makeGuard(gen1));
    const cancelTurnId = cancelAck.nativeReference!;
    await assert.rejects(adapter.control(liveRef, 'release', makeGuard(gen1)), { code: 'busy' });
    await waitFor(
      () => observed.slice(turnCancelIdx).some((o) => o.type === 'turn' && o.turn.status === 'running'),
      2000,
    );
    // Allow tool_call notification to arrive before inspecting residual
    await new Promise((r) => setTimeout(r, 80));
    const residualRunning = await adapter.inspectTurnResidual(liveRef, cancelTurnId);
    assert.equal(residualRunning.complete, false);
    assert.ok(residualRunning.status === 'running' || residualRunning.status === 'unknown');

    await adapter.interrupt(liveRef, cancelTurnId, makeGuard(gen1));
    await waitFor(
      () => observed.slice(turnCancelIdx).some((o) => o.type === 'turn' && o.turn.status === 'interrupted'),
      3000,
    );

    // 8. Drop connection -> stale generation respond rejected -> reconnect -> resume original ID (no fork)
    const turnDropIdx = observed.length;
    await adapter.input(liveRef, 'new', [{ type: 'text', text: 'flow-drop' }], makeGuard(gen1));
    await waitFor(
      () => observed.slice(turnDropIdx).some((o) => o.type === 'interaction' && o.interaction.kind === 'approval'),
      3000,
    );
    const staleInteraction: Interaction = observed
      .slice(turnDropIdx)
      .find((o): o is Extract<PlatformObservation, { type: 'interaction' }> => o.type === 'interaction' && o.interaction.kind === 'approval')!.interaction;

    await assert.rejects(adapter.control(liveRef, 'release', makeGuard(gen1)), { code: 'busy' });

    // Wait for child process unexpected crash & reconnect
    await waitFor(() => !transport.connected, 3000, 'expected transport disconnect after crash');
    assert.equal(adapter.hasActiveNativeSession(liveRef), false);
    await transport.connect();
    const gen2 = transport.connectionGeneration;
    assert.ok(gen2 > gen1, 'reconnect must increment connectionGeneration');

    await assert.rejects(
      () => adapter.respond(liveRef, staleInteraction, { kind: 'approval', scope: 'this_request', decision: 'allow' }, makeGuard(gen1)),
      (err: unknown) => typeof err === 'object' && err !== null && (err as { code?: string }).code === 'interaction_expired',
    );

    const resumedAck = await adapter.resume(liveRef);
    assert.equal(resumedAck.nativeReference, 'agy-live-1', 'resume must load original ID without forking');
    assert.equal(resumedAck.connectionGeneration, gen2);

    // 9. Release an idle session and recover the same native ID through core control.
    const beforeRelease = (await adapter.read(liveRef)).session;
    await assert.rejects(adapter.control(liveRef, 'release', makeGuard(gen1)), { code: 'control_conflict' });
    await assert.rejects(adapter.control(liveRef, 'release', makeGuard(gen2, false)), /stale control guard/);
    assert.equal(adapter.hasActiveNativeSession(liveRef), true);
    const releasing = adapter.control(liveRef, 'release', makeGuard(gen2));
    await assert.rejects(adapter.input(liveRef, 'new', [{ type: 'text', text: 'blocked' }], makeGuard(gen2)), { code: 'control_conflict' });
    await assert.rejects(adapter.resume(liveRef), { code: 'busy' });
    assert.equal((await releasing).nativeReference, 'unsubscribed');
    assert.equal(adapter.hasActiveNativeSession(liveRef), false);
    await assert.rejects(adapter.control(liveRef, 'release', makeGuard(gen2)), { code: 'control_conflict' });
    await waitFor(() => store.getSession(session.sessionId).control.generation === beforeRelease.control.generation + 1, 3000);
    const released = store.getSession(session.sessionId);
    assert.equal(released.status, 'read_only');
    assert.equal(released.control.input, 'unavailable');
    assert.equal(released.control.owner, null);
    assert.equal(released.control.generation, beforeRelease.control.generation + 1);
    assert.equal(released.capabilities.send.status, 'unsupported');
    assert.equal(released.capabilities.handoff.status, 'available');

    const controlContext = (operationId: string, current: Session) => ({
      operationId, idempotencyKey: operationId, targetId: session.sessionId,
      expectedRevision: current.revision, controlGeneration: current.control.generation,
      identity: { source: 'feishu', subject: 'ou_owner' },
    });
    await core.requestControl({
      context: controlContext('reacquire', released),
      payload: { owner: 'agy-svc-1', strategy: 'wait' },
    });
    assert.equal((await core.dispatch('reacquire')).status, 'completed');
    assert.equal(adapter.hasActiveNativeSession(liveRef), true);
    const reacquired = store.getSession(session.sessionId);
    assert.equal(reacquired.control.input, 'available');
    assert.equal(reacquired.control.generation, released.control.generation + 1);

    await core.releaseControl({
      context: controlContext('release', reacquired),
      payload: { owner: 'agy-svc-1' },
    });
    assert.equal((await core.dispatch('release')).status, 'completed');
    assert.equal(store.getSession(session.sessionId).control.input, 'unavailable');

    // Verify RPC log stripped effort suffix and sent expected payloads
    const rpcEntries = (await readFile(rpcLogPath, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.deepEqual(rpcEntries.filter(e => e.method === 'session/close'), [
      { method: 'session/close', params: { sessionId: liveRef.nativeSessionId } },
      { method: 'session/close', params: { sessionId: liveRef.nativeSessionId } },
    ]);
    assert.deepEqual(rpcEntries.filter(e => e.method === 'session/load').map(e => e.params), [
      { sessionId: liveRef.nativeSessionId, cwd: projectDir, mcpServers: [] },
      { sessionId: liveRef.nativeSessionId, cwd: projectDir, mcpServers: [] },
    ]);
    const setModelCalls = rpcEntries.filter((e) => e.method === 'session/set_model');
    assert.ok(setModelCalls.length >= 2);
    for (const call of setModelCalls) {
      assert.equal((call.params as { modelId: string }).modelId, 'gemini-4-hydrogen');
    }
    const setCfgCalls = rpcEntries.filter((e) => e.method === 'session/set_config_option');
    assert.ok(setCfgCalls.some((c) => (c.params as { value: string }).value === 'xhigh'));
    for (const [flow, optionId] of [
      ['flow-auto', 'allow_once'], ['flow-auto-incremental', 'allow_once'], ['flow-auto-scoped-root', 'allow_once'],
      ['flow-auto-deny', null], ['flow-auto-bypass', 'reject_once'], ['flow-auto-evicted', 'reject_once'],
      ['flow-auto-updated', 'reject_once'],
      ['flow-allow', 'allow_once'], ['flow-deny', 'reject_once'],
    ]) {
      const replies = rpcEntries.filter(e => e.permissionCase === flow).map(e => e.permissionReply);
      assert.deepEqual(replies, [{ outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } }], flow!);
    }
    assert.ok(
      rpcEntries.some(
        (e) =>
          (e.elicitationReply as { action?: string; content?: { env?: string; note?: string } })?.action === 'accept' &&
          (e.elicitationReply as { content?: { env?: string } })?.content?.env === 'prod',
      ),
    );

    } finally {
      core.close();
      await adapter.close();
      store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('AgyAdapter rejects malformed inactive history even when it contains a valid message', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-inactive-history-'));
  try {
    const brainDir = join(root, 'brain');
    const dbPath = join(root, 'summaries.sqlite');
    const ref = { provider: 'agy' as const, hostId: 'host-1', serviceId: 'agy-svc', nativeSessionId: 'agy-inactive' };
    createSummariesDb(dbPath, [{
      conversation_id: ref.nativeSessionId,
      workspace_uris: JSON.stringify([pathToFileURL(root).href]),
    }]);
    const steps = [
      { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Valid history' },
    ];
    const logsDir = join(brainDir, ref.nativeSessionId, '.system_generated', 'logs');
    await mkdir(logsDir, { recursive: true });
    const transcriptPath = join(logsDir, 'transcript.jsonl');
    await writeFile(transcriptPath, jsonl(...steps) + 'invalid-json\n');

    const catalog = new AgyCatalog({ dbPath, brainDir, allowedProjectRoots: [root] });
    const transport = new AgyAcpTransport({ agyBin: join(root, 'unused-agy') });
    const adapter = new AgyAdapter(transport, catalog, ref.hostId, ref.serviceId);
    try {
      await assert.rejects(adapter.read(ref), { code: 'temporarily_unavailable', message: /malformed JSONL/ });

      await writeFile(transcriptPath, jsonl(...steps) + '{"step_index":');
      const snapshot = await adapter.read(ref);
      assert.equal(snapshot.session.status, 'read_only');
      assert.deepEqual(snapshot.messages.map(message => message.blocks), [
        [{ type: 'text', text: 'Valid history' }],
      ]);
    } finally {
      await adapter.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('failed AGY transcript read leaves a read-only binding baseline pending for an interactive session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-history-baseline-'));
  try {
    const brainDir = join(root, 'brain');
    const dbPath = join(root, 'summaries.sqlite');
    const binPath = join(root, 'fake-agy.mjs');
    const nativeSessionId = 'agy-baseline';
    const owner = { source: 'feishu', subject: 'ou_owner' };
    const native = { provider: 'agy' as const, hostId: 'host-1', serviceId: 'agy-svc', nativeSessionId };
    await writeFakeAgyBinary(binPath, join(root, 'rpc.jsonl'), join(root, 'drop.flag'));
    await mkdir(brainDir);
    createSummariesDb(dbPath, [{
      conversation_id: nativeSessionId,
      title: 'Agy baseline',
      workspace_uris: JSON.stringify([pathToFileURL(root).href]),
    }]);

    const catalog = new AgyCatalog({ dbPath, brainDir, allowedProjectRoots: [root] });
    const transport = new AgyAcpTransport({ agyBin: binPath });
    const adapter = new AgyAdapter(transport, catalog, native.hostId, native.serviceId, undefined, {
      externalHolderDetector: () => null,
    });
    const { port } = createFakeFeishuPort();
    const runtime = new UnifiedRuntime({
      coreDb: join(root, 'core.sqlite'), channelDb: join(root, 'channel.sqlite'),
      ownerOpenId: owner.subject, allowedDestinations: ['chat-main'], hostId: native.hostId,
      claudeServiceId: 'claude-svc', codexServiceId: 'codex-svc', claudeStateDir: root,
      codexEndpoint: 'codex-proxy://default', intervalMs: 60_000,
    }, port, [adapter], { requireReadonlyHydration: true });
    try {
      await transport.connect();
      const readonly = await adapter.read(native);
      assert.equal(readonly.session.status, 'read_only');
      assert.equal(readonly.connectionGeneration, transport.connectionGeneration);
      const attached = await runtime.core.attachSession({
        context: { operationId: 'attach-agy', idempotencyKey: 'attach-agy', targetId: nativeSessionId,
          expectedRevision: 0, controlGeneration: 0, identity: owner },
        payload: { ...native, mode: 'interactive' },
      });
      assert.equal(attached.result?.kind, 'session');
      const sessionId = attached.result.sessionId;
      assert.equal(runtime.store.getSession(sessionId).control.input, 'available');
      runtime.channel.importMigrationBinding('agy-history', {
        destination: 'chat-main', sessionId, bindingId: 'agy-readonly', owner,
      });

      const transcriptPath = join(brainDir, nativeSessionId, '.system_generated', 'logs', 'transcript.jsonl');
      await mkdir(transcriptPath, { recursive: true });
      const history = (eventId: string) => runtime.channel.handle(
        { eventId, destination: 'chat-main', identity: owner }, { action: 'history' },
      );
      await assert.rejects(history('history-failed'), { code: 'temporarily_unavailable' });
      assert.equal(runtime.channel.readonlyHydrated('chat-main', sessionId), false);
      assert.deepEqual(runtime.store.snapshot(sessionId).value.messages, []);

      await rm(transcriptPath, { recursive: true });
      await writeFile(transcriptPath, 'invalid-json\n');
      await assert.rejects(history('history-corrupt'), { code: 'temporarily_unavailable' });
      assert.equal(runtime.channel.readonlyHydrated('chat-main', sessionId), false);
      await writeFile(transcriptPath, '{"step_index":');
      await assert.rejects(history('history-partial'), { code: 'temporarily_unavailable' });
      assert.equal(runtime.channel.readonlyHydrated('chat-main', sessionId), false);

      await writeTranscript(brainDir, nativeSessionId, [
        { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Recovered history' },
      ]);
      await history('history-retry');
      assert.equal(runtime.channel.readonlyHydrated('chat-main', sessionId), true);
      assert.deepEqual(runtime.store.snapshot(sessionId).value.messages.map(message => message.blocks), [
        [{ type: 'text', text: 'Recovered history' }],
      ]);
    } finally {
      await runtime.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('AGY close failure keeps recovery quarantined and fences live history snapshots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-quarantine-'));
  try {
    const brainDir = join(root, 'brain');
    const dbPath = join(root, 'summaries.sqlite');
    const binPath = join(root, 'fake-agy.mjs');
    const native = { provider: 'agy' as const, hostId: 'host-1', serviceId: 'agy-svc', nativeSessionId: 'agy-quarantine' };
    const identity = { source: 'feishu', subject: 'ou_owner' };
    await writeFakeAgyBinary(binPath, join(root, 'rpc.jsonl'), join(root, 'drop.flag'));
    await mkdir(brainDir);
    createSummariesDb(dbPath, [{
      conversation_id: native.nativeSessionId,
      title: 'Agy quarantine',
      workspace_uris: JSON.stringify([pathToFileURL(root).href]),
    }]);
    const catalog = new AgyCatalog({ dbPath, brainDir, allowedProjectRoots: [root] });
    const transport = new AgyAcpTransport({ agyBin: binPath });
    const adapter = new AgyAdapter(transport, catalog, native.hostId, native.serviceId, undefined, {
      externalHolderDetector: () => null,
    });
    const store = new UnifiedStore(join(root, 'core.sqlite'));
    const core = new UnifiedCore(store, [adapter], () => true);
    try {
      await transport.connect();
      const attached = await core.attachSession({
        context: { operationId: 'attach-agy', idempotencyKey: 'attach-agy', targetId: 'new',
          expectedRevision: 0, controlGeneration: 0, identity },
        payload: { ...native, mode: 'interactive' },
      });
      assert.equal(attached.result?.kind, 'session');
      const sessionId = attached.result.sessionId;
      await adapter.control(native, 'release', makeGuard(transport.connectionGeneration));
      await waitFor(() => store.getSession(sessionId).status === 'read_only', 3000);

      const request = transport.request.bind(transport);
      let closeAttempts = 0;
      transport.request = async (method, params, timeout) => {
        if (method === 'session/close') {
          closeAttempts++;
          throw new Error('ACP transport lost session/close acknowledgement');
        }
        return request(method, params, timeout);
      };
      const read = adapter.read.bind(adapter);
      let reads = 0;
      let authorized = true;
      adapter.read = async ref => {
        const snapshot = await read(ref);
        if (++reads === 4) authorized = false;
        return snapshot;
      };
      await assert.rejects(core.restoreInteractiveWithOutcome(sessionId, identity, async () => authorized), /restore metadata changed/);
      assert.equal(closeAttempts, 1);
      assert.deepEqual(store.getRecoveryQuarantine(sessionId), { generation: transport.connectionGeneration, releaseConfirmed: false });
      assert.equal(adapter.hasActiveNativeSession(native), true);

      await adapter.input(native, 'new', [{ type: 'text', text: 'unverified live message' }], makeGuard(transport.connectionGeneration));
      const snapshot = await read(native);
      assert.ok(snapshot.messages.some(message => message.blocks.some(block => block.type === 'text' && block.text.includes('unverified live message'))));
      assert.equal(await core.refreshReadOnlySession(sessionId), false);
      assert.equal(await core.refreshReadOnlySession(sessionId, snapshot), false);
      assert.equal(store.applyHistoryRefresh(store.getSession(sessionId), transport.connectionGeneration, snapshot), false);
      assert.deepEqual(store.snapshot(sessionId).value.messages, []);
    } finally {
      core.close();
      await adapter.close();
      store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('UnifiedRuntime + FeishuChannel auto-mirrors top-level agy session, blocks subagents, enforces brain artifact allowlist', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-runtime-auto-'));
  try {
    const projectDir = join(root, 'projects', 'app');
    const claudeDir = join(root, 'claude-state');
    const codexDir = join(root, 'codex-state');
    const brainDir = join(root, 'brain');
    const dbPath = join(root, 'conversation_summaries.db');
    const binPath = join(root, 'fake-agy.mjs');
    const rpcLogPath = join(root, 'rpc-log.jsonl');
    const dropFlagPath = join(root, 'drop.flag');

    await mkdir(projectDir, { recursive: true });
    await mkdir(claudeDir, { recursive: true });
    await mkdir(codexDir, { recursive: true });
    await mkdir(brainDir, { recursive: true });
    await writeFakeAgyBinary(binPath, rpcLogPath, dropFlagPath);

    // Start runtime cleanly with empty DB first to initialize watermarks
    createSummariesDb(dbPath, []);

    const cfg: RuntimeConfig = {
      coreDb: join(root, 'core.sqlite'),
      channelDb: join(root, 'channel.sqlite'),
      ownerOpenId: 'ou_owner',
      allowedDestinations: ['chat-main'],
      hostId: 'host-1',
      claudeServiceId: 'claude-svc',
      codexServiceId: 'codex-svc',
      claudeStateDir: claudeDir,
      codexEndpoint: 'codex-proxy://default',
      intervalMs: 60_000,
      allowedProjectRoots: [projectDir],
      outputRoots: [projectDir],
      artifactStatePath: join(root, 'artifacts.json'),
      catalogSources: [
        { provider: 'claude', hostId: 'host-1', serviceId: 'claude-svc', directory: claudeDir },
        { provider: 'codex', hostId: 'host-1', serviceId: 'codex-svc', directory: codexDir },
      ],
      autoMirror: { enabled: true, destination: 'chat-main' },
      agy: {
        enabled: true,
        serviceId: 'agy-svc',
        summariesDbPath: dbPath,
        brainDir,
        binPath,
      },
    };
    validateRuntimeConfig(cfg);

    const { port, topicCards } = createFakeFeishuPort();
    const claudeMock = new MemoryMockPort('claude', 'host-1', 'claude-svc', projectDir);
    const codexMock = new MemoryMockPort('codex', 'host-1', 'codex-svc', projectDir);
    const agyCatalog = new AgyCatalog({ dbPath, brainDir, allowedProjectRoots: [projectDir] });
    const agyTransport = new AgyAcpTransport({ agyBin: binPath });
    const agyAdapter = new AgyAdapter(agyTransport, agyCatalog, 'host-1', 'agy-svc');

    const runtime = await createIntegratedRuntime(cfg, port, [claudeMock, codexMock, agyAdapter]);
    try {
      // Seed 1 top-level post-watermark agy session + 1 nesting_depth>0 worker subagent
      const futureMs = Date.now() + 20;
      await new Promise((r) => setTimeout(r, 30));
      const createdAtIso = new Date(futureMs).toISOString();
      const modifiedIso = new Date(futureMs + 5).toISOString();

      const topId = 'agy-auto-top-1';
      const subId = 'agy-auto-sub-1';
      createSummariesDb(dbPath, [
        {
          conversation_id: topId,
          title: 'Auto Mirrored Agy Session',
          step_count: 2,
          status: 'CASCADE_RUN_STATUS_IDLE',
          last_modified_time: modifiedIso,
          last_user_input_time: createdAtIso,
          workspace_uris: JSON.stringify([pathToFileURL(projectDir).href]),
          nesting_depth: 0,
          parent_conversation_id: '',
          agent_name: '',
        },
        {
          conversation_id: subId,
          title: 'Worker Subagent Must Never Mirror',
          step_count: 1,
          status: 'CASCADE_RUN_STATUS_RUNNING',
          last_modified_time: modifiedIso,
          last_user_input_time: createdAtIso,
          workspace_uris: JSON.stringify([pathToFileURL(projectDir).href]),
          nesting_depth: 1,
          parent_conversation_id: topId,
          agent_name: 'worker',
        },
      ]);

      await writeTranscript(brainDir, topId, [
        { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: createdAtIso, content: 'Auto hello' },
        { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: modifiedIso, content: 'Auto world' },
      ]);
      await writeTranscript(brainDir, subId, [
        { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: createdAtIso, content: 'Sub hello' },
        { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: modifiedIso, content: 'Sub world' },
      ]);

      const outsideFile = join(root, 'outside-secret.md');
      await writeFile(outsideFile, 'TOP SECRET OUTSIDE', 'utf8');
      await writeFile(join(brainDir, topId, 'report.md'), '# Top Report\nVerified.\n', 'utf8');
      await writeFile(join(brainDir, topId, '.system_generated', 'internal.md'), 'DO NOT READ', 'utf8');
      await symlink(outsideFile, join(brainDir, topId, 'escape.md'));

      // Tick twice so discovery, binding, and baseline readonly hydration complete
      await runtime.tick();
      await runtime.tick();

      assert.equal(topicCards.length, 1, 'must mirror strictly 1 topic for top-level agy session and 0 for subagent');
      const mirroredSessionId = topicCards[0]!.sessionId;
      const storedSessions = runtime.store.listSessions();
      assert.equal(storedSessions.length, 1);
      assert.equal(storedSessions[0]!.native.nativeSessionId, topId);
      assert.ok(!storedSessions.some((s) => s.native.nativeSessionId === subId));

      // Verify independent agy watermark table exists & legacy tables are untouched
      const chanDb = new DatabaseSync(cfg.channelDb);
      try {
        const agyMarks = chanDb.prepare('SELECT root, watermark FROM channel_auto_agy_scope_watermarks').all() as Array<{ root: string; watermark: number }>;
        const codexMarks = chanDb.prepare('SELECT root, watermark FROM channel_auto_scope_watermarks').all() as Array<{ root: string; watermark: number }>;
        const claudeMarks = chanDb.prepare('SELECT root, watermark FROM channel_auto_claude_scope_watermarks').all() as Array<{ root: string; watermark: number }>;
        assert.equal(agyMarks.length, 1);
        assert.equal(codexMarks.length, 1);
        assert.equal(claudeMarks.length, 1);
      } finally {
        chanDb.close();
      }

      // Verify artifact allowlist & exclusion via UnifiedCore
      const listRes = await runtime.core.listArtifacts(mirroredSessionId, { limit: 20 });
      assert.deepEqual(listRes.items.map((a) => a.name), ['report.md']);
      const reportBytes = await runtime.core.readArtifact(mirroredSessionId, listRes.items[0]!.artifactId, listRes.items[0]!.contentVersion);
      assert.match(Buffer.from(reportBytes).toString('utf8'), /Top Report/);

      // Excluded .system_generated or bogus artifact IDs must fail
      const blockedId = payloadDigest([topId, join(brainDir, topId, '.system_generated', 'internal.md')]);
      await assert.rejects(() => runtime.core.readArtifact(mirroredSessionId, blockedId, 'v1'));
    } finally {
      await runtime.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Three-backend coexistence (/sessions, /new, /create, /health) & createLiveRuntime integration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-three-backend-'));
  try {
    const projectDir = join(root, 'proj');
    const claudeDir = join(root, 'claude');
    const codexDir = join(root, 'codex');
    const brainDir = join(root, 'brain');
    const dbPath = join(root, 'conversation_summaries.db');
    const binPath = join(root, 'fake-agy.mjs');
    const rpcLogPath = join(root, 'rpc.jsonl');
    const dropFlagPath = join(root, 'drop.flag');

    await mkdir(projectDir, { recursive: true });
    await mkdir(claudeDir, { recursive: true });
    await mkdir(codexDir, { recursive: true });
    await mkdir(brainDir, { recursive: true });
    await writeFakeAgyBinary(binPath, rpcLogPath, dropFlagPath);
    createSummariesDb(dbPath, [
      {
        conversation_id: 'agy-ro-coexist-1',
        title: 'Agy Existing Work',
        step_count: 1,
        last_modified_time: '2026-11-22T11:00:00Z',
        workspace_uris: JSON.stringify([pathToFileURL(projectDir).href]),
        nesting_depth: 0,
      },
    ]);

    const { port, sentCards, topicCards } = createFakeFeishuPort();
    const store = new UnifiedStore(join(root, 'core.sqlite'));
    const claude = new MemoryMockPort('claude', 'host-1', 'claude-svc', projectDir);
    const codex = new MemoryMockPort('codex', 'host-1', 'codex-svc', projectDir);
    claude.seedSession('claude-1', 'Claude Task');
    codex.seedSession('codex-1', 'Codex Task');

    const agyTransport = new AgyAcpTransport({ agyBin: binPath });
    const agyCatalog = new AgyCatalog({ dbPath, brainDir, allowedProjectRoots: [projectDir] });
    const agyQuota = new AgyQuotaClient({ agyBin: binPath });
    const agy = new AgyAdapter(agyTransport, agyCatalog, 'host-1', 'agy-svc', agyQuota);
    let core: UnifiedCore | undefined;
    let channel: FeishuChannel | undefined;

    try {
      await agyTransport.connect();
      core = new UnifiedCore(store, [claude, codex, agy], () => true, () => true, () => false, () => true);
      channel = new FeishuChannel(core, port, async () => true, join(root, 'channel.sqlite'), undefined, false, { defaultCreateProject: projectDir });
      const ownerId = { source: 'feishu', subject: 'ou_owner' };
      const sendCmd = async (eventId: string, destination: string, action: ChannelAction) => {
        await channel!.handle({ eventId, destination, identity: ownerId }, action);
      };

      // 1. /new starts a project picker with the three registered backends.
      await sendCmd('ev-new', 'chat-main', { action: 'new_help' });
      const newCard = sentCards.at(-1)!.card;
      assert.match(newCard.text, /当前后端：Antigravity/);
      const token = newCard.actions[0]!.value.t;
      assert.match(String(token), /^[A-Za-z0-9_-]{22}$/);
      assert.deepEqual(newCard.actions.map((a) => a.value), [
        { action: 'new_provider', t: token, r: 0, p: 'agy' },
        { action: 'new_provider', t: token, r: 0, p: 'codex' },
        { action: 'new_provider', t: token, r: 0, p: 'claude' },
        { action: 'new_pick', t: token, r: 0, i: 0 },
      ]);
      assert.equal(newCard.actions[3]!.label, 'proj');

      // 2. /sessions lists all 3 backends cleanly, and filtering by agy/antigravity isolates agy sessions
      await sendCmd('ev-list-all', 'chat-main', { action: 'list' });
      const listAllCard = sentCards.at(-1)!.card;
      assert.match(listAllCard.text, /Claude Task/);
      assert.match(listAllCard.text, /Codex Task/);
      assert.match(listAllCard.text, /Agy Existing Work/);
      assert.match(listAllCard.text, /Antigravity · proj/);
      assert.ok(listAllCard.actions.some((a) => a.label === 'Antigravity'));

      await sendCmd('ev-list-agy', 'chat-main', { action: 'list', search: 'antigravity' });
      const listAgyCard = sentCards.at(-1)!.card;
      assert.match(listAgyCard.text, /Agy Existing Work/);
      assert.doesNotMatch(listAgyCard.text, /Claude Task/);
      assert.doesNotMatch(listAgyCard.text, /Codex Task/);

      const codexFilter = listAllCard.actions.find(a => a.label === 'Codex')!.value;
      assert.deepEqual(codexFilter,{ action: 'list', provider: 'codex' });
      await sendCmd('ev-list-codex-filter', 'chat-main', codexFilter as ChannelAction);
      const listCodexCard = sentCards.at(-1)!.card;
      assert.match(listCodexCard.text, /Codex Task/);
      assert.doesNotMatch(listCodexCard.text, /Agy Existing Work/);
      assert.ok(listCodexCard.actions.some((a) => a.label === '全部'));
      assert.ok(listCodexCard.actions.some((a) => a.label === 'Antigravity'));

      // 3. /create agy <project> spawns real interactive agy topic & runs turn
      await sendCmd('ev-create-agy', 'chat-main', { action: 'create', provider: 'agy', project: projectDir, model: 'gemini-4-hydrogen' });
      await core.dispatchPending();
      await channel.advanceCompleted();
      assert.ok(topicCards.some((t) => /Antigravity/.test(t.card.text)), 'created agy session topic card must display Antigravity');
      await channel.sync(topicCards.at(-1)!.topicDestination);

      // 4. /health Feishu card Chinese rendering via fake FeishuPort on integrated three-backend runtime
      await agyTransport.close();
      const healthCfg: RuntimeConfig = {
        coreDb: join(root, 'health-core.sqlite'),
        channelDb: join(root, 'health-channel.sqlite'),
        ownerOpenId: 'ou_owner',
        allowedDestinations: ['chat-main'],
        hostId: 'host-1',
        claudeServiceId: 'claude-svc',
        codexServiceId: 'codex-svc',
        claudeStateDir: claudeDir,
        codexEndpoint: 'codex-proxy://default',
        intervalMs: 60_000,
        allowedProjectRoots: [projectDir],
        outputRoots: [projectDir],
        artifactStatePath: join(root, 'health-artifacts.json'),
        catalogSources: [
          { provider: 'claude', hostId: 'host-1', serviceId: 'claude-svc', directory: claudeDir },
          { provider: 'codex', hostId: 'host-1', serviceId: 'codex-svc', directory: codexDir },
        ],
        agy: {
          enabled: true,
          serviceId: 'agy-svc',
          summariesDbPath: dbPath,
          brainDir,
          binPath,
          quotaCachePath: join(root, 'health-agy-quota.json'),
        },
      };
      const { port: healthPort, sentCards: healthCards } = createFakeFeishuPort();
      const healthClaude = new MemoryMockPort('claude', 'host-1', 'claude-svc', projectDir);
      const healthCodex = new MemoryMockPort('codex', 'host-1', 'codex-svc', projectDir);
      const healthAgyCatalog = new AgyCatalog({ dbPath, brainDir, allowedProjectRoots: [projectDir] });
      const healthAgyTransport = new AgyAcpTransport({ agyBin: binPath });
      const healthAgyQuota = new AgyQuotaClient({ agyBin: binPath });
      const healthAgy = new AgyAdapter(healthAgyTransport, healthAgyCatalog, 'host-1', 'agy-svc', healthAgyQuota);
      const healthRuntime = await createIntegratedRuntime(healthCfg, healthPort, [healthClaude, healthCodex, healthAgy]);
      try {
        await healthRuntime.handleTrusted(
          { eventId: 'ev-health-card', destination: 'chat-main', identity: ownerId },
          { action: 'health' },
        );
        await healthRuntime.tick();
        const healthCard = healthCards.at(-1)?.card;
        assert.ok(healthCard, 'fake FeishuPort must capture rendered /health card');
        assert.equal(healthCard.title, '健康状态');
        assert.match(healthCard.text, /Antigravity连接/);
        assert.match(healthCard.text, /Antigravity运行/);
        assert.match(healthCard.text, /Antigravity额度/);
        assert.match(healthCard.text, /Codex连接/);
        assert.match(healthCard.text, /Claude SDK事件流/);
      } finally {
        await healthRuntime.close();
      }

      // 5. createLiveRuntime constructs, exposes agy health layers with isolated Codex down, and closes cleanly (no network calls)
      const liveCfg: RuntimeConfig = {
        coreDb: join(root, 'live-core.sqlite'),
        channelDb: join(root, 'live-channel.sqlite'),
        ownerOpenId: 'ou_owner',
        allowedDestinations: ['chat-main'],
        hostId: 'host-1',
        claudeServiceId: 'claude-svc',
        codexServiceId: 'codex-svc',
        claudeStateDir: claudeDir,
        codexEndpoint: 'ws://127.0.0.1:1', // unreachable port tests provider startup isolation
        intervalMs: 60_000,
        allowedProjectRoots: [projectDir],
        outputRoots: [projectDir],
        artifactStatePath: join(root, 'live-artifacts.json'),
        catalogSources: [
          { provider: 'claude', hostId: 'host-1', serviceId: 'claude-svc', directory: claudeDir },
          { provider: 'codex', hostId: 'host-1', serviceId: 'codex-svc', directory: codexDir },
        ],
        agy: {
          enabled: true,
          serviceId: 'agy-svc',
          summariesDbPath: dbPath,
          brainDir,
          binPath,
          quotaCachePath: join(root, 'agy-quota.json'),
        },
      };

      const live = await createLiveRuntime(
        liveCfg,
        { appId: 'cli_test', appSecret: 'secret_test' },
        join(root, 'live-sdk.sqlite'),
      );
      try {
        const rows = await live.runtime.core.health();
        assert.ok(rows.some((r) => r.component === 'agy_connection'));
        assert.ok(rows.some((r) => r.component === 'agy_run'));
        assert.ok(rows.some((r) => r.component === 'agy_quota'));
      } finally {
        await live.close();
      }
    } finally {
      channel?.close();
      await agy.close();
      core?.close();
      store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Backward compatibility: legacy RuntimeConfig without agy or with agy.enabled=false validates and omits agy health rows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-compat-'));
  try {
    const projectDir = join(root, 'proj');
    const claudeDir = join(root, 'claude');
    const codexDir = join(root, 'codex');
    await mkdir(projectDir, { recursive: true });
    await mkdir(claudeDir, { recursive: true });
    await mkdir(codexDir, { recursive: true });

    const baseCfg: RuntimeConfig = {
      coreDb: join(root, 'core.sqlite'),
      channelDb: join(root, 'channel.sqlite'),
      ownerOpenId: 'ou_owner',
      allowedDestinations: ['chat-main'],
      hostId: 'host-1',
      claudeServiceId: 'claude-svc',
      codexServiceId: 'codex-svc',
      claudeStateDir: claudeDir,
      codexEndpoint: 'codex-proxy://default',
      intervalMs: 60_000,
      allowedProjectRoots: [projectDir],
      outputRoots: [projectDir],
      artifactStatePath: join(root, 'artifacts.json'),
      catalogSources: [
        { provider: 'claude', hostId: 'host-1', serviceId: 'claude-svc', directory: claudeDir },
        { provider: 'codex', hostId: 'host-1', serviceId: 'codex-svc', directory: codexDir },
      ],
    };

    // Omitted config.agy
    validateRuntimeConfig(baseCfg);
    const { port } = createFakeFeishuPort();
    const claude = new MemoryMockPort('claude', 'host-1', 'claude-svc', projectDir);
    const codex = new MemoryMockPort('codex', 'host-1', 'codex-svc', projectDir);
    const runtime1 = await createIntegratedRuntime(baseCfg, port, [claude, codex]);
    try {
      await runtime1.tick();
      const healthRows = await runtime1.core.health();
      assert.equal(healthRows.some((r) => r.component.startsWith('agy_')), false);
      assert.equal(healthRows.find((r) => r.component === 'core')?.status, 'healthy');
    } finally {
      await runtime1.close();
    }

    // Explicit enabled: false in config.agy
    const disabledCfg: RuntimeConfig = {
      ...baseCfg,
      coreDb: join(root, 'core2.sqlite'),
      channelDb: join(root, 'channel2.sqlite'),
      artifactStatePath: join(root, 'artifacts2.json'),
      agy: { enabled: false, serviceId: 'agy-disabled', binPath: '/nonexistent/agy' },
    };
    validateRuntimeConfig(disabledCfg);
    const liveDisabled = await createLiveRuntime(
      disabledCfg,
      { appId: 'cli_test', appSecret: 'secret_test' },
      join(root, 'sdk2.sqlite'),
    );
    try {
      const disabledRows = await liveDisabled.runtime.core.health();
      assert.equal(disabledRows.some((r) => r.component.startsWith('agy_')), false);
      assert.notEqual(disabledRows.find((r) => r.component === 'runtime')?.status, 'degraded');
    } finally {
      await liveDisabled.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
