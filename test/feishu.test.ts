import assert from "node:assert/strict";
import test from "node:test";
import type * as Lark from "@larksuiteoapi/node-sdk";
import { messageAppLink, parseCardAction, parseIncoming, utf8Chunks } from "../src/feishu.js";
import { isRetryableTransportError } from "../src/inbound-events.js";

type MessageEvent = Parameters<NonNullable<Lark.EventHandles["im.message.receive_v1"]>>[0];

test("classifies only transient Feishu transport failures as retryable", () => {
  assert.equal(isRetryableTransportError(new Error("Feishu API 429: rate limited")), true);
  assert.equal(isRetryableTransportError(new Error("ETIMEDOUT")), true);
  assert.equal(isRetryableTransportError(new Error("Feishu API 400: invalid request")), false);
});

test("normalizes a rich post and recognizes the configured bot mention", () => {
  const event = {
    sender: { sender_type: "user", sender_id: { open_id: "ou-user" } },
    message: {
      message_id: "message-1", chat_id: "chat-1", chat_type: "group", message_type: "post",
      create_time: "1", root_id: "root-1",
      mentions: [{ key: "@_user_1", id: { open_id: "ou-bot" }, name: "bot" }],
      content: JSON.stringify({ zh_cn: { title: "", content: [[
        { tag: "at", user_id: "ou-bot" }, { tag: "text", text: "分析图片" }, { tag: "img", image_key: "img-1" },
      ]] } }),
    },
  } as MessageEvent;
  assert.deepEqual(parseIncoming(event, "ou-bot"), {
    messageId: "message-1", chatId: "chat-1", chatType: "group", rootId: "root-1", senderOpenId: "ou-user", mentionedBot: true,
    text: "分析图片", imageKeys: ["img-1"],
  });
});

test("does not treat another user mention as a bot mention", () => {
  const event = {
    sender: { sender_type: "user", sender_id: { open_id: "ou-user" } },
    message: {
      message_id: "message-2", chat_id: "chat-1", chat_type: "group", message_type: "text", create_time: "1",
      mentions: [{ key: "@_user_1", id: { open_id: "ou-other" }, name: "other" }],
      content: JSON.stringify({ text: "@_user_1 do not run this" }),
    },
  } as MessageEvent;
  assert.equal(parseIncoming(event, "ou-bot")?.mentionedBot, false);
});

test("normalizes a card action delivered over WebSocket", () => {
  assert.deepEqual(parseCardAction({
    context: { open_message_id: "card-1", open_chat_id: "chat-1" },
    operator: { open_id: "ou-user" },
    action: { tag: "button", value: { action: "choice_answer", optionIndex: 1 } },
  }), {
    openId: "ou-user", chatId: "chat-1", openMessageId: "card-1", action: "choice_answer",
    value: { action: "choice_answer", optionIndex: 1 }, formValues: {},
  });
});

test("builds an encoded Feishu message deep link", () => {
  assert.equal(messageAppLink("oc_test value", "om_test&value"),
    "https://applink.feishu.cn/client/chat/open?openChatId=oc_test+value&openMessageId=om_test%26value");
});

test("splits outbound text at UTF-8 byte boundaries", () => {
  const parts = utf8Chunks("a你b好", 4);
  assert.deepEqual(parts, ["a你", "b好"]);
  assert.ok(parts.every((part) => Buffer.byteLength(part, "utf8") <= 4));
});

test("preserves snake_case and camelCase card form values", () => {
  for (const key of ["form_value", "formValue"] as const) {
    const action = parseCardAction({ context: { open_message_id: "card-1", open_chat_id: "chat-1" }, operator: { open_id: "ou-user" },
      action: { tag: "button", value: { action: "submit_task" }, [key]: { task_prompt: "a task" } } });
    assert.equal(action?.formValues.task_prompt, "a task");
  }
});

test("normalizes a wrapped JSON 2.0 form callback", () => {
  const action = parseCardAction({ event: {
    context: { open_message_id: "card-2", open_chat_id: "chat-2" }, operator: { open_id: "ou-user" },
    action: { tag: "button", name: "task_form_b1", value: { action: "submit_task", wizardId: "w1" }, form_value: { task_prompt: "implement this" } },
  } } as unknown as Lark.RawCardActionEvent);
  assert.equal(action?.action, "submit_task");
  assert.equal(action?.formValues.task_prompt, "implement this");
});

function postEvent(content: unknown, mentions: MessageEvent["message"]["mentions"] = []): MessageEvent {
  return {
    sender: { sender_type: "user", sender_id: { open_id: "ou-user" } },
    message: {
      message_id: "message-post", chat_id: "chat-1", chat_type: "p2p", message_type: "post", create_time: "1",
      mentions, content: JSON.stringify(content),
    },
  } as MessageEvent;
}

test("post containing only a link keeps the link text and URL", () => {
  const parsed = parseIncoming(postEvent({ zh_cn: { content: [[{ tag: "a", text: "项目", href: "https://example.com/repo" }]] } }), "ou-bot");
  assert.equal(parsed?.text, "项目 (https://example.com/repo)");
  assert.deepEqual(parsed?.imageKeys, []);
});

test("post title is the first line and bare or self-labelled links render as the URL", () => {
  const parsed = parseIncoming(postEvent({ zh_cn: { title: "项目资料", content: [
    [{ tag: "a", text: "项目", href: "https://example.com/repo" }],
    [{ tag: "text", text: "镜像：" }, { tag: "a", text: "https://example.com/m", href: "https://example.com/m" }],
    [{ tag: "a", text: "", href: "https://example.com/empty" }],
  ] } }), "ou-bot");
  assert.equal(parsed?.text, "项目资料\n项目 (https://example.com/repo)\n镜像：https://example.com/m\nhttps://example.com/empty");
});

test("post paragraphs keep order with mixed text, images, md, code and emotions", () => {
  const parsed = parseIncoming(postEvent({ title: "", content: [
    [{ tag: "text", text: "第一段" }, { tag: "emotion", emoji_type: "SMILE" }, { tag: "text", text: "继续" }],
    [{ tag: "img", image_key: "img-1" }],
    [{ tag: "md", text: "**第二段**" }, { tag: "img", image_key: "img-2" }],
    [{ tag: "hr" }],
    [{ tag: "code_block", language: "TS", text: "const a = 1;" }],
  ] }), "ou-bot");
  assert.equal(parsed?.text, "第一段继续\n**第二段**\nconst a = 1;");
  assert.deepEqual(parsed?.imageKeys, ["img-1", "img-2"]);
});

test("multi-language post uses only the zh_cn version", () => {
  const content = {
    en_us: { title: "Docs", content: [[{ tag: "text", text: "english" }, { tag: "img", image_key: "img-en" }]] },
    zh_cn: { title: "资料", content: [[{ tag: "text", text: "中文" }, { tag: "img", image_key: "img-zh" }]] },
  };
  const parsed = parseIncoming(postEvent(content), "ou-bot");
  assert.equal(parsed?.text, "资料\n中文");
  assert.deepEqual(parsed?.imageKeys, ["img-zh"]);
  const fallback = parseIncoming(postEvent({ ja_jp: { content: [[{ tag: "text", text: "日本語" }]] }, en_us: { content: [[{ tag: "text", text: "english" }]] } }), "ou-bot");
  assert.equal(fallback?.text, "english");
});

test("post without a title starts with the first paragraph", () => {
  const parsed = parseIncoming(postEvent({ zh_cn: { content: [[{ tag: "text", text: "第一行" }], [{ tag: "text", text: "第二行" }]] } }), "ou-bot");
  assert.equal(parsed?.text, "第一行\n第二行");
});

test("post with malformed fields does not throw or invent text", () => {
  assert.equal(parseIncoming(postEvent({ zh_cn: { title: "标题", content: "not an array" } }), "ou-bot")?.text, "标题");
  assert.equal(parseIncoming(postEvent({ content: { tag: "text", text: "x" } }), "ou-bot")?.text, "");
  assert.equal(parseIncoming(postEvent({ zh_cn: "nope" }), "ou-bot")?.text, "");
  const parsed = parseIncoming(postEvent({ content: [
    "paragraph-string", null, [null, 1, "text", ["nested"], { tag: "a", text: "无链接" }, { tag: "a", href: 5 }, { tag: "unknown", text: "伪造" }],
    [{ tag: "img", image_key: 7 }, { tag: "text", text: 9 }, { tag: "text", text: "有效" }],
  ] }), "ou-bot");
  assert.equal(parsed?.text, "无链接\n有效");
  assert.deepEqual(parsed?.imageKeys, []);
});

test("post at elements are dropped while the rest of the paragraph remains", () => {
  const parsed = parseIncoming(postEvent({ zh_cn: { content: [
    [{ tag: "at", user_id: "ou-bot", user_name: "bot" }, { tag: "text", text: " 请看 " }, { tag: "a", text: "文档", href: "https://example.com/doc" }],
  ] } }, [{ key: "@_user_1", id: { open_id: "ou-bot" }, name: "bot" }] as MessageEvent["message"]["mentions"]), "ou-bot");
  assert.equal(parsed?.text, "请看 文档 (https://example.com/doc)");
  assert.equal(parsed?.mentionedBot, true);
});
