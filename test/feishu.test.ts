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
