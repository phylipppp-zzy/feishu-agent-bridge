import assert from "node:assert/strict";
import test from "node:test";
import { buildBacklogSummary, deliverBacklogSummary, type BacklogEntry } from "../src/claude/backlog-summary.js";
import type { CardDefinition } from "../src/types.js";

const entries: BacklogEntry[] = Array.from({ length: 83 }, (_, index) => ({
  status: "ended",
  id: `item-${index}`,
  title: `Title ${index}`,
  source: `Session ${index % 4}`,
  body: `Full body for ${index}\nSecond line ${index}`,
}));

test("builds one bounded overview card and preserves every full backlog body in Markdown", () => {
  const built = buildBacklogSummary(entries, new Date("2026-11-13T12:00:00.000Z"));
  assert.ok(built);
  assert.equal(built.count, 83);
  assert.match(JSON.stringify(built.card), /83 项/);
  for (const entry of entries) {
    assert.ok(built.markdown.includes(entry.id));
    assert.ok(built.markdown.includes(entry.title));
    assert.ok(built.markdown.includes(entry.body));
    assert.ok(built.markdown.includes(entry.source!));
  }
});

test("delivers exactly one card and one complete markdown file and returns both message IDs", async () => {
  const calls: string[] = [];
  let fullFile = "";
  const result = await deliverBacklogSummary(entries, {
    async replyCard(rootId: string, _card: CardDefinition, options?: { uuid?: string }) { calls.push("card"); assert.equal(rootId, "om_session_root"); assert.equal(options?.uuid, "card-dedupe"); return "om_card"; },
    async replyFile(rootId: string, fileName: string, data: Buffer, options?: { uuid?: string }) {
      calls.push("file"); assert.equal(rootId, "om_session_root"); assert.equal(options?.uuid, "file-dedupe"); assert.match(fileName, /^backlog-.*\.md$/); fullFile = data.toString("utf8"); return "om_file";
    },
  }, "om_session_root", new Date("2026-11-13T12:00:00.000Z"), {
    cardUuid: "card-dedupe", markdownUuid: "file-dedupe",
    onCardMessage: async (messageId) => { assert.equal(messageId, "om_card"); },
  });
  assert.deepEqual(calls, ["card", "file"]);
  assert.deepEqual(result, { cardMessageId: "om_card", markdownMessageId: "om_file", count: 83 });
  assert.ok(fullFile.includes("Full body for 82\nSecond line 82"));
});

test("empty backlog is a no-op", async () => {
  let sends = 0;
  const result = await deliverBacklogSummary([], {
    async replyCard() { sends++; return "om_card"; },
    async replyFile() { sends++; return "om_file"; },
  }, "oc_chat");
  assert.equal(result, null);
  assert.equal(sends, 0);
});

test("rejects active or approval work instead of hiding it in the summary", () => {
  const active = { ...entries[0]!, status: "active" } as unknown as BacklogEntry;
  assert.throws(() => buildBacklogSummary([active]), /Only ended turns/);
});

test("resumes after card persistence without sending a second card or duplicating a known attachment", async () => {
  let cards = 0;
  let files = 0;
  const port = {
    async replyCard() { cards++; return "om_card_new"; },
    async replyFile(_rootId: string, _name: string, _data: Buffer, options?: { uuid?: string }) {
      files++;
      assert.equal(options?.uuid, "file-dedupe");
      if (files === 1) throw new Error("socket hang up");
      return "om_file_new";
    },
  };
  await assert.rejects(deliverBacklogSummary(entries, port, "om_session_root", new Date("2026-11-13T12:00:00.000Z"), {
    markdownUuid: "file-dedupe", onCardMessage: async (id) => { assert.equal(id, "om_card_new"); },
  }), /socket hang up/);
  assert.equal(cards, 1);
  const partial = await deliverBacklogSummary(entries, port, "om_session_root", new Date("2026-11-13T12:00:00.000Z"), {
    cardMessageId: "om_card_new", markdownUuid: "file-dedupe",
  });
  assert.equal(partial?.markdownMessageId, "om_file_new");
  assert.equal(cards, 1);
  assert.equal(files, 2);
  const retry = await deliverBacklogSummary(entries, port, "om_session_root", new Date("2026-11-13T12:00:00.000Z"), {
    cardMessageId: "om_card_new", markdownMessageId: "om_file_new",
  });
  assert.deepEqual(retry, { cardMessageId: "om_card_new", markdownMessageId: "om_file_new", count: 83 });
  assert.equal(cards, 1);
  assert.equal(files, 2);
});
