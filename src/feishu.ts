import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import * as Lark from "@larksuiteoapi/node-sdk";
import type { CardActionOutcome, CardDefinition, FeishuMessageMetadata, FeishuPort, IncomingBotMenuAction, IncomingCardAction, IncomingFeishuMessage, SentRootMessage } from "./types.js";
import { isRetryableTransportError } from "./inbound-events.js";

const MESSAGE_BYTES = 18_000;

function diagnosticId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function diagnosticAction(value: string): string {
  return /^[a-z_]{1,64}$/i.test(value) ? value : "invalid";
}

export function messageAppLink(chatId: string, messageId: string): string {
  const query = new URLSearchParams({ openChatId: chatId, openMessageId: messageId });
  return `https://applink.feishu.cn/client/chat/open?${query.toString()}`;
}

export function utf8Chunks(text: string, maxBytes = MESSAGE_BYTES): string[] {
  const result: string[] = [];
  let current = "";
  let bytes = 0;
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes && bytes + charBytes > maxBytes) {
      result.push(current);
      current = "";
      bytes = 0;
    }
    current += char;
    bytes += charBytes;
  }
  if (current || !result.length) result.push(current);
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Picks one language version of a post body: single-language bodies (top-level title/content) as-is, otherwise zh_cn, en_us, then the first with a content array. */
function postLocale(body: Record<string, unknown>): Record<string, unknown> | null {
  if ("title" in body || "content" in body) return body;
  const candidates = [body.zh_cn, body.en_us, ...Object.values(body)].filter(isRecord);
  return candidates.find((value) => Array.isArray(value.content))
    ?? candidates.find((value) => typeof value.title === "string") ?? null;
}

/** Renders one post element as plain text; at mentions, emotions, images, media, hr and unknown tags yield "". */
function postElementText(element: Record<string, unknown>): string {
  const text = typeof element.text === "string" ? element.text : "";
  switch (element.tag) {
    case "text": case "md": case "code_block": return text;
    case "a": {
      const href = typeof element.href === "string" ? element.href.trim() : "";
      if (!href) return text;
      return !text.trim() || text.trim() === href ? href : `${text} (${href})`;
    }
    default: return "";
  }
}

function postContent(body: Record<string, unknown>): { text: string; imageKeys: string[] } {
  const imageKeys: string[] = [];
  const locale = postLocale(body);
  if (!locale) return { text: "", imageKeys };
  const lines: string[] = [];
  if (typeof locale.title === "string" && locale.title.trim()) lines.push(locale.title.trim());
  for (const paragraph of Array.isArray(locale.content) ? locale.content : []) {
    if (!Array.isArray(paragraph)) continue;
    let line = "";
    for (const element of paragraph) {
      if (!isRecord(element)) continue;
      if (element.tag === "img" && typeof element.image_key === "string") imageKeys.push(element.image_key);
      line += postElementText(element);
    }
    if (line.trim()) lines.push(line);
  }
  return { text: lines.join("\n"), imageKeys };
}

async function streamToBuffer(stream: Readable, maxBytes = Number.MAX_SAFE_INTEGER): Promise<Buffer> {
  const pieces: Buffer[] = []; let total = 0;
  try {
    for await (const piece of stream) {
      const chunk = Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
      total += chunk.length;
      if (total > maxBytes) { stream.destroy(new Error(`download exceeds ${maxBytes} bytes`)); throw new Error(`download exceeds ${maxBytes} bytes`); }
      pieces.push(chunk);
    }
    return Buffer.concat(pieces);
  } finally { if (!stream.destroyed) stream.destroy(); }
}

export function parseIncoming(
  data: Parameters<NonNullable<Lark.EventHandles["im.message.receive_v1"]>>[0],
  botOpenId: string,
): IncomingFeishuMessage | null {
  if (data.sender.sender_type === "app" || data.sender.sender_type === "bot") return null;
  const openId = data.sender.sender_id?.open_id;
  if (!openId) return null;
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(data.message.content) as Record<string, unknown>; } catch { /* retain empty body */ }
  const post = data.message.message_type === "post" ? postContent(body) : { text: "", imageKeys: [] };
  let text = typeof body.text === "string" ? body.text : post.text;
  const mentionedBot = data.message.chat_type === "p2p" || (data.message.mentions ?? [])
    .some((mention) => mention.id.open_id === botOpenId);
  for (const mention of data.message.mentions ?? []) text = text.replaceAll(mention.key, "");
  const imageKey = data.message.message_type === "image" && typeof body.image_key === "string" ? body.image_key : null;
  return {
    messageId: data.message.message_id,
    chatId: data.message.chat_id,
    chatType: data.message.chat_type === "p2p" ? "p2p" : "group",
    ...(data.message.root_id ? { rootId: data.message.root_id } : {}),
    ...(data.message.parent_id ? { parentId: data.message.parent_id } : {}),
    senderOpenId: openId,
    mentionedBot,
    text: text.trim(),
    imageKeys: imageKey ? [imageKey] : post.imageKeys,
  };
}

export function parseCardAction(data: Lark.RawCardActionEvent): IncomingCardAction | null {
  const raw = data as unknown as Record<string, unknown>;
  const source = raw.event && typeof raw.event === "object" ? raw.event as Lark.RawCardActionEvent : data;
  const event = Lark.normalizeCardAction(source);
  if (!event || !event.operator.openId || !event.messageId || !event.chatId) return null;
  const value = event.action.value && typeof event.action.value === "object"
    ? event.action.value as Record<string, unknown> : {};
  // The SDK normalizer currently omits form fields.  Preserve all documented
  // callback spellings so cards remain forward compatible with Card 2.0.
  const rawAction = (source as unknown as { action?: Record<string, unknown> }).action ?? {};
  const rawForm = rawAction.form_value ?? rawAction.formValue;
  const formValues = rawForm && typeof rawForm === "object" ? rawForm as Record<string, unknown> : {};
  const rawEventId = typeof raw.event_id === "string" ? raw.event_id : typeof raw.uuid === "string" ? raw.uuid : "";
  const eventId = rawEventId || `card:${diagnosticId(JSON.stringify({ messageId: event.messageId, chatId: event.chatId, operator: event.operator.openId, action: value.action, value, formValues }))}`;
  const parsed = {
    openId: event.operator.openId,
    chatId: event.chatId,
    openMessageId: event.messageId,
    action: typeof value.action === "string" ? value.action : "unknown",
    value,
    formValues,
    ...(event.action.option ? { option: event.action.option } : {}),
  };
  Object.defineProperty(parsed, "eventId", { value: eventId, enumerable: false });
  return parsed;
}

export class FeishuClient implements FeishuPort {
  private readonly client: Lark.Client;
  private readonly ws: Lark.WSClient;
  private sendQueue: Promise<unknown> = Promise.resolve();
  private lastSendAt = 0;
  private botOpenId: string | null = null;

  constructor(appId: string, appSecret: string) {
    const base = { appId, appSecret, appType: Lark.AppType.SelfBuild, domain: Lark.Domain.Feishu };
    this.client = new Lark.Client(base);
    this.ws = new Lark.WSClient({ ...base, loggerLevel: Lark.LoggerLevel.info });
  }

  async start(
    onMessage: (message: IncomingFeishuMessage) => Promise<void>,
    onCardAction: (action: IncomingCardAction) => Promise<CardActionOutcome>,
    onBotMenuAction: (action: IncomingBotMenuAction) => Promise<void>,
  ): Promise<void> {
    this.botOpenId = await this.resolveBotOpenId();
    type WebSocketHandles = Partial<Lark.EventHandles> & {
      "card.action.trigger": (data: Lark.RawCardActionEvent) => Promise<CardDefinition | undefined>;
    };
    const handles: WebSocketHandles = {
      "im.message.receive_v1": async (data) => {
        const message = parseIncoming(data, this.botOpenId!);
        if (message) await onMessage(message);
      },
      "card.action.trigger": async (data) => {
        const action = parseCardAction(data);
        if (!action) {
          console.warn("Feishu card callback received but could not be normalized");
          return undefined;
        }
        const fields = Object.entries(action.formValues).map(([key, value]) =>
          `${diagnosticAction(key)}:${typeof value === "string" ? [...value].length : Array.isArray(value) ? value.length : 1}`).join(",");
        const metadata = `action=${diagnosticAction(action.action)} message=${diagnosticId(action.openMessageId)} operator=${diagnosticId(action.openId)} form=${fields || "none"}`;
          console.info(`Feishu card callback received: ${metadata}`);
        try {
          const outcome = await onCardAction(action);
          // A replace callback must be acknowledged with the Card 2.0 raw-card
          // envelope. Updating the same message asynchronously as well causes
          // duplicate races and can exceed Feishu's three-second callback SLA.
          if (outcome.delivery !== "replace" && outcome.delivery !== "toast") {
            void this.deliverCardActionOutcome(action, outcome).catch((error) =>
              console.error(`Feishu card outcome delivery failed: ${metadata}; error=${error instanceof Error ? error.message : String(error)}`));
          }
          console.info(`Feishu card callback completed: ${metadata}`);
          if (outcome.delivery === "toast") return { toast: { type: outcome.level ?? "error", content: outcome.text } } as unknown as CardDefinition;
          if (outcome.delivery !== "replace") return undefined;
          return { card: { type: "raw", data: outcome.card }, ...(outcome.toast ? { toast: { type: "info", content: outcome.toast } } : {}) } as unknown as CardDefinition;
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          console.error(`Feishu card callback failed: ${metadata}; error=${detail}`);
          throw error;
        }
      },
      "application.bot.menu_v6": async (data) => {
        const openId = data.operator?.operator_id?.open_id;
        if (!openId || !data.event_key) return;
        await onBotMenuAction({ eventId: data.event_id ?? data.uuid ?? `${data.timestamp ?? Date.now()}:${data.event_key}:${openId}`,
          openId, eventKey: data.event_key });
      },
    };
    const dispatcher = new Lark.EventDispatcher({}).register(handles);
    await this.ws.start({ eventDispatcher: dispatcher });
  }

  close(): void { this.ws.close(); }

  private async resolveBotOpenId(): Promise<string> {
    const response = await this.client.request<{ bot?: { open_id?: string } }>({
      url: "/open-apis/bot/v3/info", method: "GET",
    });
    const openId = response.bot?.open_id;
    if (!openId) throw new Error("Feishu bot identity lookup returned no open_id");
    return openId;
  }

  private async limited<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.sendQueue.then(async () => {
      const wait = Math.max(0, 220 - (Date.now() - this.lastSendAt));
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      let lastError: unknown;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          const value = await operation();
          this.lastSendAt = Date.now();
          return value;
        } catch (error) {
          lastError = error;
          if (!isRetryableTransportError(error) || attempt === 3) throw error;
          await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** attempt)));
        }
      }
      throw lastError;
    });
    this.sendQueue = result.catch(() => undefined);
    return result;
  }

  private ensureResponse(response: {
    code?: number | undefined;
    msg?: string | undefined;
    data?: { message_id?: string | undefined } | undefined;
  }): string {
    if (response.code && response.code !== 0) throw new Error(`Feishu API ${response.code}: ${response.msg ?? "unknown error"}`);
    const id = response.data?.message_id;
    if (!id) throw new Error("Feishu API returned no message_id");
    return id;
  }

  private async replaceCardAfterAction(action: IncomingCardAction, card: CardDefinition): Promise<void> {
    const metadata = `action=${diagnosticAction(action.action)} message=${diagnosticId(action.openMessageId)}`;
    try {
      await this.updateCard(action.openMessageId, card);
      console.info(`Feishu card explicitly updated: ${metadata}`);
    } catch (updateError) {
      const updateDetail = updateError instanceof Error ? updateError.message : String(updateError);
      console.warn(`Feishu card update failed; sending replacement card: ${metadata}; error=${updateDetail}`);
      try {
        const replacementId = await this.sendCard(action.chatId, card);
        console.info(`Feishu replacement card sent: ${metadata} replacement=${diagnosticId(replacementId)}`);
      } catch (replacementError) {
        const replacementDetail = replacementError instanceof Error ? replacementError.message : String(replacementError);
        console.error(`Feishu replacement card failed: ${metadata}; error=${replacementDetail}`);
      }
    }
  }

  private async deliverCardActionOutcome(action: IncomingCardAction, outcome: CardActionOutcome): Promise<void> {
    switch (outcome.delivery) {
      case "none": case "toast": return;
      case "replace": return this.replaceCardAfterAction(action, outcome.card);
      case "reply": await this.replyCard(outcome.rootMessageId, outcome.card); return;
      case "send": await this.sendCard(action.chatId, outcome.card); return;
    }
  }

  async createSessionRoot(chatId: string, title: string, detail: string, card?: CardDefinition): Promise<SentRootMessage> {
    const response = await this.limited(() => this.client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: card ? { receive_id: chatId, msg_type: "interactive", content: JSON.stringify(card) }
        : { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text: `${title}\n${detail}` }) },
    }));
    const messageId = this.ensureResponse(response);
    return { messageId, appLink: response.data?.message_app_link ?? messageAppLink(chatId, messageId), chatId, threadId: response.data?.thread_id ?? null };
  }

  async sendText(chatId: string, text: string): Promise<string> {
    let lastId = "";
    for (const part of utf8Chunks(text)) {
      lastId = await this.limited(async () => this.ensureResponse(await this.client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text: part }) },
      })));
    }
    return lastId;
  }

  async sendCard(chatId: string, card: CardDefinition): Promise<string> {
    return this.limited(async () => this.ensureResponse(await this.client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: chatId, msg_type: "interactive", content: JSON.stringify(card) },
    })));
  }

  async replyCard(rootMessageId: string, card: CardDefinition, options: { uuid?: string } = {}): Promise<string> {
    return this.limited(async () => this.ensureResponse(await this.client.im.message.reply({
      path: { message_id: rootMessageId },
      data: { msg_type: "interactive", content: JSON.stringify(card), reply_in_thread: true, ...(options.uuid ? { uuid: options.uuid } : {}) },
    })));
  }

  async updateCard(messageId: string, card: CardDefinition): Promise<void> {
    await this.limited(async () => {
      const response = await this.client.im.message.patch({
        path: { message_id: messageId }, data: { content: JSON.stringify(card) },
      });
      if (response.code && response.code !== 0) throw new Error(`Feishu API ${response.code}: ${response.msg ?? "unknown error"}`);
    });
  }

  async createStreamingReply(rootMessageId: string, title: string): Promise<{ cardId: string; messageId: string; elementId: string; sequence: number }> {
    const elementId = "stream_md";
    const card = {
      schema: "2.0",
      config: { update_multi: true, streaming_mode: true, summary: { content: title } },
      header: { template: "blue", title: { tag: "plain_text", content: title } },
      body: { elements: [{ tag: "markdown", element_id: elementId, content: "正在生成…" }] },
    };
    const created = await this.limited(() => this.client.cardkit.v1.card.create({
      data: { type: "card_json", data: JSON.stringify(card) },
    }));
    const cardId = created.data?.card_id;
    if (!cardId) throw new Error("CardKit create returned no card_id");
    const sent = await this.limited(() => this.client.im.message.reply({
      path: { message_id: rootMessageId },
      data: { msg_type: "interactive", content: JSON.stringify({ type: "card", data: { card_id: cardId } }), reply_in_thread: true },
    }));
    const messageId = this.ensureResponse(sent);
    return { cardId, messageId, elementId, sequence: 0 };
  }

  async updateStreamingReply(stream: { cardId: string; elementId: string; sequence: number }, content: string): Promise<number> {
    const sequence = stream.sequence + 1;
    await this.limited(() => this.client.cardkit.v1.cardElement.content({
      path: { card_id: stream.cardId, element_id: stream.elementId },
      data: { content, sequence, uuid: `c_${stream.cardId}_${sequence}` },
    }));
    return sequence;
  }

  async finishStreamingReply(stream: { cardId: string; elementId: string; sequence: number }, summary: string): Promise<void> {
    const sequence = stream.sequence + 1;
    await this.limited(() => this.client.cardkit.v1.card.settings({
      path: { card_id: stream.cardId },
      data: { settings: JSON.stringify({ config: { streaming_mode: false, summary: { content: summary } } }), sequence, uuid: `s_${stream.cardId}_${sequence}` },
    }));
  }

  async deleteMessage(messageId: string): Promise<void> {
    await this.limited(async () => {
      const response = await this.client.im.message.delete({ path: { message_id: messageId } });
      if (response.code && response.code !== 0) throw new Error(`Feishu API ${response.code}: ${response.msg ?? "unknown error"}`);
    });
  }

  async getMessageMetadata(messageId: string): Promise<FeishuMessageMetadata | null> {
    return this.limited(async () => {
      const response = await this.client.im.message.get({ path: { message_id: messageId }, params: { user_id_type: "open_id" } });
      if (response.code && response.code !== 0) throw new Error(`Feishu API ${response.code}: ${response.msg ?? "unknown error"}`);
      const message = response.data?.items?.[0];
      if (!message) return null;
      const chatId = message.chat_id ?? null;
      return {
        chatId,
        threadId: message.thread_id ?? null,
        appLink: message.message_app_link ?? (chatId ? messageAppLink(chatId, messageId) : null),
      };
    });
  }

  async replyText(rootMessageId: string, text: string): Promise<string> {
    let lastId = "";
    for (const part of utf8Chunks(text)) {
      lastId = await this.limited(async () => this.ensureResponse(await this.client.im.message.reply({
        path: { message_id: rootMessageId },
        data: { msg_type: "text", content: JSON.stringify({ text: part }), reply_in_thread: true },
      })));
    }
    return lastId;
  }

  async replyFile(rootMessageId: string, fileName: string, data: Buffer, options: { uuid?: string } = {}): Promise<string> {
    const uploaded = await this.limited(() => this.client.im.file.create({
      data: { file_type: "stream", file_name: fileName, file: data },
    }));
    if (!uploaded?.file_key) throw new Error("Feishu file upload returned no file_key");
    return this.limited(async () => this.ensureResponse(await this.client.im.message.reply({
      path: { message_id: rootMessageId },
      data: { msg_type: "file", content: JSON.stringify({ file_key: uploaded.file_key }), reply_in_thread: true, ...(options.uuid ? { uuid: options.uuid } : {}) },
    })));
  }

  async replyImage(rootMessageId: string, data: Buffer): Promise<string> {
    const uploaded = await this.limited(() => this.client.im.image.create({
      data: { image_type: "message", image: data },
    }));
    if (!uploaded?.image_key) throw new Error("Feishu image upload returned no image_key");
    return this.limited(async () => this.ensureResponse(await this.client.im.message.reply({
      path: { message_id: rootMessageId },
      data: { msg_type: "image", content: JSON.stringify({ image_key: uploaded.image_key }), reply_in_thread: true },
    })));
  }

  async downloadImage(messageId: string, imageKey: string, maxBytes = 10 * 1024 * 1024): Promise<Buffer> {
    const response = await this.client.im.messageResource.get({
      params: { type: "image" }, path: { message_id: messageId, file_key: imageKey },
    });
    return streamToBuffer(response.getReadableStream(), maxBytes);
  }
}
