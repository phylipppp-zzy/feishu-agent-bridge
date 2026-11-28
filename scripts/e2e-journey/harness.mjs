import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { FeishuSdkPort } from '../../src/unified/feishu-sdk-port.ts';
import { createIntegratedRuntime } from '../../src/unified/runtime.ts';
import { FeishuWire } from './wire.mjs';
import { JourneyProvider } from './provider.mjs';

export const MAIN_CHAT_ID = 'oc_journey_main';
export const OWNER_OPEN_ID = 'ou_journey_owner';
const BOT_OPEN_ID = 'ou_journey_bot';
const destinations = new Set([MAIN_CHAT_ID]);

function prepareWorkspace(dir) {
  const projects = {
    bridge: join(dir, 'workspace', 'feishu-agent-bridge'),
    gui: join(dir, 'papers', 'gui-rl'),
    research: join(dir, 'research'),
  };
  const allowedProjectRoots = [...Object.values(projects),
    join(dir, 'workspace', 'vision-tools'), join(dir, 'papers', 'dataset-audit'),
    join(dir, 'research-archive')];
  for (const project of allowedProjectRoots) mkdirSync(project, { recursive: true });
  const providers = Object.fromEntries(['claude', 'codex', 'agy'].map(name =>
    [name, new JourneyProvider(name, 'journey-host', `${name}-journey`)]));
  const catalogSources = Object.values(providers).map(({ provider, hostId, serviceId }) => {
    const directory = join(dir, 'catalog', provider);
    mkdirSync(directory, { recursive: true });
    return { provider, directory, hostId, serviceId };
  });
  const fixtures = {
    readme: '# Feishu Bridge\n\n统一会话和话题入口。\n',
    report: '# Evaluation\n\n回归通过。\n',
    index: 'export const requireProject = (path: string) => Boolean(path);\n',
    hidden: 'FEISHU_APP_ID=example\n',
  };
  for (const path of ['outputs', 'outputs/logs', 'src']) mkdirSync(join(projects.bridge, path), { recursive: true });
  for (const [relative, bytes] of Object.entries({
    'README.md': fixtures.readme, 'outputs/eval_report.md': fixtures.report,
    'src/index.ts': fixtures.index, '.env.example': fixtures.hidden,
    'outputs/logs/run.txt': 'sample log\n',
  })) writeFileSync(join(projects.bridge, relative), bytes);
  writeFileSync(join(dir, 'workspace', 'outside_secret.txt'), 'synthetic outside project marker\n');

  const config = {
    coreDb: join(dir, 'core.sqlite'), channelDb: join(dir, 'channel.sqlite'),
    artifactStatePath: join(dir, 'artifact-registry.json'),
    ownerOpenId: OWNER_OPEN_ID, allowedDestinations: [...destinations], hostId: 'journey-host',
    claudeServiceId: providers.claude.serviceId, codexServiceId: providers.codex.serviceId,
    claudeStateDir: catalogSources[0].directory, codexEndpoint: 'codex-proxy://default', intervalMs: 100,
    agy: { serviceId: providers.agy.serviceId }, approvalPolicy: { enabled: false }, catalogSources, allowedProjectRoots,
    outputRoots: [join(projects.bridge, 'outputs')],
    taskTopic: { enabled: true },
    pendingHub: { enabled: true, destination: MAIN_CHAT_ID },
    watchHub: { enabled: true, destination: MAIN_CHAT_ID },
    decisionSync: { enabled: true, markdownPath: join(dir, 'decisions.md') },
  };
  return { config, projects, fixtures, providers };
}

export async function createHarness(trace, dir = mkdtempSync(join(tmpdir(), 'feishu-e2e-journey-'))) {
  let sdk, runtime;
  try {
    const { config, projects, fixtures, providers } = prepareWorkspace(dir);
    const sdkDbPath = join(dir, 'sdk.sqlite');
    sdk = new FeishuSdkPort({ appId: 'cli_e2e_app', appSecret: 'sec_e2e' },
      sdkDbPath, destinations, OWNER_OPEN_ID, true, true);
    const wire = new FeishuWire({ chatId: MAIN_CHAT_ID, botId: BOT_OPEN_ID, sdkDbPath });
    trace.wire = wire;
    wire.install(sdk);
    runtime = await createIntegratedRuntime(config, sdk, Object.values(providers));
    // Same trusted ingress adapter as liveRuntimeLifecycle. Manual ticks drive the
    // real background pass, including sdk.drainInbound and RuntimeInteractive.
    await sdk.start((envelope, action) => runtime.handleTrusted(envelope, action),
      envelope => runtime.captureResourceScope(envelope));
    return journeyContext({ dir, sdk, sdkDbPath, runtime, wire, config, projects, fixtures, providers, trace });
  } catch (error) {
    try { await runtime?.close(); } finally {
      sdk?.close();
      rmSync(dir, { recursive: true, force: true });
    }
    throw error;
  }
}

function journeyContext(context) {
  const { runtime, sdk, wire, trace, providers } = context;
  const topics = {};
  let inbound = 0;

  function topic(destination, sessionOverride) {
    const route = sdk.route(destination);
    assert.ok(route, `缺少话题路由 ${destination}`);
    const root = wire.messages.get(route.root_id);
    assert.ok(root, `找不到话题根消息 ${route.root_id}`);
    const binding = runtime.channel.bindingsForRestore().find(item => item.destination === destination);
    const sessionId = sessionOverride ?? binding?.sessionId;
    return { destination, sessionId, ref: sessionId ? runtime.store.getSession(sessionId).native : undefined,
      rootId: root.id, threadId: root.threadId };
  }

  function belongs(message, target) {
    if (!target) return message.rootId === null;
    return message.rootId === target.rootId || message.id === target.rootId;
  }

  async function dispatch(type, event, eventId, details) {
    const started = performance.now();
    let result, error;
    try {
      result = await wire.dispatch(type, event, eventId);
    } catch (failure) {
      error = failure;
      throw failure;
    } finally {
      trace.recordDispatch({ type, eventId, ...details, latencyMs: performance.now() - started,
        ...(error ? { error: error.message } : {}) });
    }
    return { result, latencyMs: performance.now() - started, eventId };
  }

  function userMessage(target, id, messageType, content, mention = false) {
    return {
      sender: { sender_id: { open_id: OWNER_OPEN_ID }, sender_type: 'user' },
      message: {
        message_id: id, chat_id: MAIN_CHAT_ID, chat_type: 'group',
        message_type: messageType, content: JSON.stringify(content),
        ...(target ? { root_id: target.rootId, parent_id: target.rootId, thread_id: target.threadId } : {}),
        ...(mention ? { mentions: [{ key: '@_user_1', id: { open_id: BOT_OPEN_ID }, name: 'bot' }] } : {}),
      },
    };
  }

  async function send(target, text, { mention = false } = {}) {
    const id = `om_user_${++inbound}`;
    const content = { text: mention ? `@_user_1 ${text.replace(/^@bot\s*/, '')}` : text };
    return dispatch('im.message.receive_v1', userMessage(target, id, 'text', content, mention),
      `message-${id}`, { messageId: id, destination: target?.destination ?? MAIN_CHAT_ID, text, mention });
  }

  async function attach(target, { name, type, mediaType, bytes }) {
    const id = `om_user_${++inbound}`;
    const key = `journey_inbound_${inbound}`;
    const content = type === 'image' ? { image_key: key } : { file_key: key, file_name: name, mime_type: mediaType };
    wire.registerResource(id, key, bytes);
    const info = { name, type, mediaType, byteLength: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') };
    const replay = () => dispatch('im.message.receive_v1', userMessage(target, id, type, content),
      `message-${id}`, { messageId: id, destination: target.destination, attachment: info });
    return { ...await replay(), replay };
  }

  async function click(message, labelOrPredicate, form) {
    const button = message?.card.buttons.find(typeof labelOrPredicate === 'function'
      ? labelOrPredicate : candidate => candidate.label === labelOrPredicate);
    assert.ok(button?.value, `找不到回调按钮 ${String(labelOrPredicate)}`);
    const eventId = `callback-${++inbound}`;
    const event = {
      event_id: eventId,
      operator: { open_id: OWNER_OPEN_ID },
      context: { open_message_id: message.id, open_chat_id: message.chatId },
      action: { tag: 'button', value: button.value, ...(form ? { form_value: form } : {}) },
    };
    const details = { messageId: message.id, label: button.label, value: button.value, form };
    const result = await dispatch('card.action.trigger', event, eventId, details);
    trace.recordCallback({ ...details, ...result });
    return result;
  }

  async function tick() {
    await setImmediate();
    await runtime.tick();
    assert.deepEqual(wire.invariantFailures, [], 'Feishu 传输约束失败');
  }

  async function settle() {
    await tick();
    await tick();
  }

  function provider(target) {
    return providers[target.ref.provider];
  }

  function turn(target, turnId) {
    return provider(target).turn(target.ref, turnId);
  }

  async function start(target, prompt) {
    const adapter = provider(target);
    const before = adapter.inputs.length;
    await send(target, prompt);
    await settle();
    const input = adapter.inputs.slice(before).find(value => value.ref.nativeSessionId === target.ref.nativeSessionId);
    assert.ok(input, `输入未派发到原生会话：${prompt}`);
    return turn(target, input.turnId);
  }

  function emitText(target, text, options = {}) {
    const { turnId = turn(target)?.turnId, ...messageOptions } = options;
    assert.ok(turnId, '缺少发送助手文本的轮次');
    return provider(target).message(target.ref, turnId, text, messageOptions);
  }

  async function finish(target, text, { turnId: id, ...options } = {}) {
    const turnId = id ?? turn(target)?.turnId;
    if (text !== undefined) emitText(target, text, { final: true, turnId });
    const completed = provider(target).finish(target.ref, turnId, options);
    await settle();
    return completed;
  }

  function cards(target) {
    return [...wire.messages.values()].filter(message => message.card && belongs(message, target));
  }

  function writes(target) {
    assert.ok(trace.currentStep, '读取出站卡片需要活动步骤');
    return wire.calls.slice(trace.currentStep.callIndex)
      .filter(call => call.response?.code === 0 && call.message?.card && belongs(call.message, target))
      .map(({ message, method }) => ({ ...message, method }));
  }

  async function close() {
    sdk.stopReceiving();
    try { await runtime.close(); } finally {
      sdk.close();
      rmSync(context.dir, { recursive: true, force: true });
    }
  }

  return { ...context, topics, topic, send, attach, click, tick, settle, start, turn, emitText, finish, cards, writes, close };
}
