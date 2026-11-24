import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';

const MAX_CARD_BYTES = 30_000;
const MAX_CALLBACK_BYTES = 256;
const MESSAGE_WRITES = ['create', 'reply', 'patch'];

function children(node) {
  return [...(node.elements ?? []), ...(node.columns ?? []), ...(node.actions ?? [])];
}

function visibleText(node) {
  if (['markdown', 'plain_text', 'lark_md'].includes(node.tag)) return node.content;
  if (node.tag === 'div') return node.text?.content;
  return undefined;
}

function decodeButton(node) {
  const callback = node.behaviors?.find(behavior => behavior.type === 'callback');
  const link = node.behaviors?.find(behavior => behavior.type === 'open_url');
  const url = node.url ?? link?.default_url;
  const value = node.value ?? callback?.value;
  return {
    label: node.text?.content,
    type: node.type,
    value,
    url,
    formAction: node.form_action_type,
  };
}

function decodeForm(node) {
  return {
    name: node.name,
    widgets: node.elements.filter(element =>
      ['select_static', 'multi_select_static', 'input'].includes(element.tag)),
    raw: node,
  };
}

export function decodeCard(content) {
  assert.equal(typeof content, 'string', '卡片 content 必须是序列化 JSON');
  const wireBytes = Buffer.byteLength(content);
  const raw = JSON.parse(content);
  assert.ok(raw && typeof raw === 'object' && !Array.isArray(raw), '卡片必须是 JSON 对象');
  // Feishu's legacy schema has an implicit version and top-level elements.
  const schema = raw.schema ?? '1.0';
  assert.ok(['1.0', '2.0'].includes(schema), `不支持的卡片版本 ${schema}`);
  const elements = schema === '2.0' ? raw.body?.elements : raw.elements;
  assert.ok(Array.isArray(elements), `Schema ${schema} 卡片缺少元素数组`);
  assert.equal(typeof raw.header?.title?.content, 'string', '缺少卡片标题');

  const body = [];
  const markdown = [];
  const buttons = [];
  const buttonLookup = new Map();
  const forms = [];
  const collapsiblePanels = [];
  function visit(node, targetText) {
    const content = visibleText(node);
    if (content !== undefined) targetText.push(content);
    if (node.tag === 'markdown' || node.text?.tag === 'lark_md') markdown.push(content);
    if (node.tag === 'button') {
      const button = decodeButton(node);
      buttons.push(button);
      buttonLookup.set(node, button);
    }
    if (node.tag === 'form') forms.push(decodeForm(node));
    if (node.tag === 'collapsible_panel') {
      const lines = [];
      for (const child of children(node)) visit(child, lines);
      collapsiblePanels.push({
        title: node.header?.title?.content,
        expanded: node.expanded,
        bodyText: lines.join('\n'),
        raw: node,
      });
      return;
    }
    for (const child of children(node)) visit(child, targetText);
  }
  for (const element of elements) visit(element, body);
  function buttonRowsFrom(node) {
    if (node.tag === 'button') return [[buttonLookup.get(node)]];
    const rows = children(node).flatMap(buttonRowsFrom);
    if (node.tag === 'action' || (node.tag === 'column_set' && node.flex_mode === 'flow')) {
      return rows.length ? [rows.flat()] : [];
    }
    return rows;
  }
  return {
    schema,
    title: raw.header.title.content,
    template: raw.header.template ?? null,
    header: raw.header,
    wireBytes,
    bodyText: body.join('\n'),
    markdown,
    buttons,
    buttonRows: elements.flatMap(buttonRowsFrom),
    forms,
    collapsiblePanels,
    raw,
  };
}

function validateCard(card) {
  assert.ok(card.wireBytes <= MAX_CARD_BYTES,
    `卡片 ${card.wireBytes} 字节，超过 ${MAX_CARD_BYTES} 字节`);
  for (const { label, value, url } of card.buttons) {
    if (url) continue;
    assert.ok(value && typeof value === 'object' && !Array.isArray(value), `按钮 ${label} 缺少回调对象`);
    const bytes = Buffer.byteLength(JSON.stringify(value));
    assert.ok(bytes <= MAX_CALLBACK_BYTES,
      `按钮 ${label} 的回调数据为 ${bytes} 字节，上限 ${MAX_CALLBACK_BYTES} 字节`);
  }
}

function fileSnapshot(content) {
  const bytes = Buffer.from(content);
  return {
    byteLength: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    base64: bytes.toString('base64'),
  };
}

/** Capture production SDK calls without opening an HTTP or WS connection. */
export class FeishuWire {
  calls = [];
  messages = new Map();
  uploads = new Map();
  invariantFailures = [];
  resources = new Map();
  faults = [];
  schemaUpgrades = new Set();
  messageNumber = 0;
  uploadNumber = 0;

  constructor({ chatId, botId, sdkDbPath, appId = 'cli_e2e_app' }) {
    Object.assign(this, { chatId, botId, sdkDbPath, appId });
  }

  install(sdk) {
    for (const method of MESSAGE_WRITES) {
      sdk.client.im.message[method] = request =>
        this.record(`im.message.${method}`, request, call => this.writeMessage(method, request, call));
    }
    sdk.client.im.message.get = request =>
      this.record('im.message.get', request, () => this.getMessage(request.path.message_id));
    sdk.client.im.file.create = request =>
      this.record('im.file.create', { data: { ...request.data, file: fileSnapshot(request.data.file) } },
        call => this.uploadFile(request, call));
    sdk.client.im.messageResource.get = request =>
      this.record('im.messageResource.get', request, call => this.getResource(request, call));
    sdk.client.request = request => this.record('client.request', request, () => {
      assert.equal(request.url, '/open-apis/bot/v3/info');
      assert.equal(request.method, 'GET');
      return { bot: { open_id: this.botId } };
    });
    sdk.ws.start = async ({ eventDispatcher }) => {
      assert.ok(!this.dispatcher, '本地 WebSocket 已启动');
      this.dispatcher = eventDispatcher;
    };
    sdk.ws.close = () => { this.dispatcher = undefined; };
  }

  async dispatch(type, event, eventId) {
    assert.ok(this.dispatcher, '生产 SDK 事件分发器尚未启动');
    const result = await this.dispatcher.invoke({
      schema: '2.0',
      header: { event_type: type, event_id: eventId, app_id: this.appId },
      event,
    }, { needCheck: false });
    assert.ok(!(typeof result === 'string' && result.startsWith('no ')),
      `生产 SDK 未注册 ${type}`);
    return result;
  }

  registerResource(messageId, key, bytes) {
    this.resources.set(JSON.stringify([messageId, key]), Buffer.from(bytes));
  }

  fault(method, code) {
    assert.ok(MESSAGE_WRITES.some(write => method === `im.message.${write}`), '故障必须注入消息写入接口');
    this.faults.push({ method, code });
  }

  takeFault(method) {
    const index = this.faults.findIndex(fault => fault.method === method);
    if (index === -1) return undefined;
    return this.faults.splice(index, 1)[0].code;
  }

  async record(method, request, run) {
    const start = performance.now();
    const call = { method, at: new Date().toISOString(), request };
    this.calls.push(call);
    try {
      const response = run(call);
      call.response = typeof response?.getReadableStream === 'function' ? { streamed: true } : response;
      return response;
    } catch (error) {
      call.error = error.message;
      this.invariantFailures.push({ method, error: error.message });
      throw error;
    } finally {
      call.latencyMs = performance.now() - start;
    }
  }

  recordedSchema(id) {
    const db = new DatabaseSync(this.sdkDbPath, { readOnly: true });
    try {
      return db.prepare('SELECT schema_version FROM sdk_card_schemas WHERE message_id=?').get(id)?.schema_version;
    } finally {
      db.close();
    }
  }

  assertLedger() {
    const db = new DatabaseSync(this.sdkDbPath, { readOnly: true });
    try {
      const rows = db.prepare('SELECT message_id, schema_version FROM sdk_card_schemas').all();
      const expected = new Map(rows.map(({ message_id, schema_version }) => [message_id, schema_version]));
      for (const message of this.messages.values()) {
        assert.equal(message.card?.schema, expected.get(message.id), `SDK 台账中的 ${message.id} 与模拟消息不一致`);
        expected.delete(message.id);
      }
      assert.equal(expected.size, 0, 'SDK 台账引用了不存在的卡片');
    } finally {
      db.close();
    }
  }

  writeMessage(method, { path, data }, call) {
    const previous = path ? this.messages.get(path.message_id) : undefined;
    if (path) assert.ok(previous, `找不到 ${method} 目标消息 ${path.message_id}`);
    if (method === 'reply') assert.equal(data.reply_in_thread, true, '会话回复必须在线程内');
    const patch = method === 'patch';
    const id = patch ? previous.id : `om_journey_${++this.messageNumber}`;
    const type = patch ? previous.type : data.msg_type;
    assert.ok(['interactive', 'text', 'file'].includes(type), `未知消息类型 ${type}`);
    if (patch) assert.equal(type, 'interactive', 'PATCH 仅允许更新卡片');
    const card = type === 'interactive' ? decodeCard(data.content) : undefined;
    const payload = type === 'interactive' ? card.raw : JSON.parse(data.content);
    if (type === 'text') assert.equal(typeof payload.text, 'string');
    if (type === 'file') assert.ok(this.uploads.has(payload.file_key), '文件消息引用了未上传的 file_key');
    const chatId = previous?.chatId ?? data.receive_id;
    assert.equal(chatId, this.chatId, '出站消息发往未知群');
    const rootId = patch ? previous.rootId : previous?.rootId ?? previous?.id ?? null;
    const threadId = previous?.threadId ?? `omt_journey_${this.messageNumber}`;
    const at = call.at;
    const message = {
      id, chatId, rootId, threadId, type, card, content: data.content, payload,
      patchCount: patch ? previous.patchCount + 1 : 0,
      createdAt: patch ? previous.createdAt : at,
      updatedAt: at,
    };
    call.message = message;
    if (card) validateCard(card);
    let recorded;
    if (patch) {
      recorded = this.recordedSchema(id);
      assert.ok(!recorded || recorded === previous.card.schema, `SDK 台账与消息 ${id} 的版本不一致`);
      if (card.schema !== previous.card.schema) {
        assert.ok(!recorded && previous.card.schema === '1.0' && card.schema === '2.0' &&
          this.schemaUpgrades.has(id), `消息 ${id} 未经 200830 升级流程更改 Schema`);
      }
    }
    const code = this.takeFault(call.method);
    if (code) {
      if (patch && code === 200830 && !recorded && card.schema === '1.0') this.schemaUpgrades.add(id);
      return { code, msg: `本地模拟 Feishu 错误 ${code}` };
    }
    if (patch && card.schema === '2.0') this.schemaUpgrades.delete(id);
    const patchHistory = patch ? [...previous.patchHistory, message] : [];
    this.messages.set(id, { ...message, patchHistory });
    return { code: 0, data: { message_id: id, chat_id: chatId, root_id: rootId, thread_id: threadId } };
  }

  getMessage(id) {
    const message = this.messages.get(id);
    if (!message) return { code: 230001, msg: 'message not found' };
    const query = new URLSearchParams({
      open_chat_id: message.chatId,
      open_thread_id: message.threadId,
      open_message_id: id,
    });
    const link = `https://applink.feishu.cn/client/thread/open?${query}`;
    return {
      code: 0,
      data: { items: [{
        message_id: id, open_message_id: id, chat_id: message.chatId,
        root_id: message.rootId, thread_id: message.threadId,
        msg_type: message.type, body: { content: message.content },
        message_app_link: link, app_link: link,
        sender: { id_type: 'app_id', sender_type: 'app', id: this.appId },
      }] },
    };
  }

  uploadFile({ data }, call) {
    assert.ok(data.file_name, '上传文件缺少文件名');
    const content = Buffer.from(data.file);
    const key = `file_journey_${++this.uploadNumber}`;
    const info = { key, name: data.file_name, ...fileSnapshot(content) };
    this.uploads.set(key, { ...info, content });
    call.upload = info;
    return { file_key: key };
  }

  getResource({ path, params }, call) {
    const content = this.resources.get(JSON.stringify([path.message_id, path.file_key]));
    assert.ok(content, `缺少 ${params.type} 测试资源 ${path.file_key}`);
    call.resource = fileSnapshot(content);
    return { getReadableStream: () => Readable.from([content]) };
  }
}
