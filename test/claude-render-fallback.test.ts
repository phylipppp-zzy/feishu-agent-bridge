import assert from "node:assert/strict";
import test from "node:test";
import { MAX_RENDER_FALLBACK_ATTEMPTS, sendCardWithRenderFallback, updateCardWithRenderFallback } from "../src/claude/render-fallback.js";
import type { CardDefinition } from "../src/types.js";

const rejected = () => new Error("Feishu API 230099: invalid card content");

function sampleCard(): CardDefinition {
  return {
    schema: "2.0", header: { title: { tag: "plain_text", content: "history" } },
    body: { elements: [
      { tag: "markdown", content: "first" },
      { tag: "markdown", content: "| name | count |\n| --- | ---: |\n| alpha | 1 |\n| beta | 2 |\n\nother table:\nkey | value\n--- | ---\nx | y\n\ncode sample:\n```\n| leave | as code |\n| --- | --- |\n| 1 | 2 |\n```" },
      { tag: "column_set", columns: [{ tag: "column", elements: [{ tag: "markdown", content: "nested | table\n--- | ---\nx | y" }, { tag: "button", text: { tag: "plain_text", content: "继续" }, behaviors: [{ type: "callback", value: { action: "continue_turn" } }] }] }] },
      { tag: "markdown", content: "third" },
    ] },
  };
}

test("degrades rejected multi-table card to ordered markdown segments and returns usable message records", async () => {
  let first = true;
  const sent: CardDefinition[] = [];
  const result = await sendCardWithRenderFallback(sampleCard(), async (card) => {
    sent.push(card);
    if (first) { first = false; throw rejected(); }
    return `om_${sent.length}`;
  });
  assert.equal(result.degraded, true);
  assert.deepEqual(result.messageIds, ["om_2"]);
  assert.equal(result.cards.length, 1);
  const json = JSON.stringify(result.cards[0]);
  assert.match(json, /alpha/);
  assert.match(json, /beta/);
  assert.match(json, /```text/);
  assert.ok(json.includes("```\\n| leave | as code |\\n| --- | --- |"));
  assert.match(json, /continue_turn/);
  assert.match(json, /继续/);
  assert.match(json, /nested \| table/);
  assert.match(json, /first/);
  assert.match(json, /third/);
});

test("bisects one oversized Unicode Markdown element losslessly under a mock JSON byte threshold", async () => {
  // This artificial threshold exercises fallback behavior only; it is not a verified Feishu limit.
  const mockJsonByteThreshold = 30 * 1024;
  const original = "中文🙂🌿内容".repeat(7000);
  assert.ok(Buffer.byteLength(JSON.stringify({ content: original }), "utf8") > mockJsonByteThreshold);
  const sent: CardDefinition[] = [];
  const result = await sendCardWithRenderFallback({
    body: { elements: [
      { tag: "markdown", content: original },
      { tag: "button", text: { tag: "plain_text", content: "继续" }, behaviors: [{ type: "callback", value: { action: "continue_turn" } }] },
    ] },
  }, async (card) => {
    sent.push(card);
    if (Buffer.byteLength(JSON.stringify(card), "utf8") > mockJsonByteThreshold) throw rejected();
    return `om_${sent.length}`;
  });

  assert.equal(result.degraded, true);
  assert.ok(result.messageIds.length > 1);
  const markdown = result.cards.flatMap((card) => card.body && typeof card.body === "object" && Array.isArray((card.body as { elements?: unknown[] }).elements)
    ? (card.body as { elements: Array<{ tag?: string; content?: string }> }).elements.filter((element) => element.tag === "markdown").map((element) => element.content ?? "")
    : []);
  assert.equal(markdown.join(""), original);
  assert.ok(result.cards.some((card) => JSON.stringify(card).includes("continue_turn")), "controls remain available in a delivered segment");
  assert.ok(sent.length <= MAX_RENDER_FALLBACK_ATTEMPTS);
});

test("uses a global attempt cap and propagates rejected one-code-point content", async () => {
  let attempts = 0;
  await assert.rejects(sendCardWithRenderFallback({ body: { elements: [{ tag: "markdown", content: "x" }] } }, async () => { attempts++; throw rejected(); }), /230099/);
  assert.equal(attempts, 2, "original send and unsplittable fallback are attempted once each");

  attempts = 0;
  const oversized = { body: { elements: [{ tag: "markdown", content: "x".repeat(10_000) }] } };
  await assert.rejects(sendCardWithRenderFallback(oversized, async (card) => {
    attempts++;
    const elements = (card.body as { elements: Array<{ content?: string }> }).elements;
    if (elements.some((element) => (element.content?.length ?? 0) > 1)) throw rejected();
    return `om_${attempts}`;
  }), /230099/);
  assert.equal(attempts, MAX_RENDER_FALLBACK_ATTEMPTS);
});

test("does not retry authentication or connection failures", async () => {
  for (const failure of [new Error("Feishu API 99991663: tenant_access_token invalid"), new Error("socket hang up")]) {
    let attempts = 0;
    await assert.rejects(sendCardWithRenderFallback(sampleCard(), async () => { attempts++; throw failure; }), failure);
    assert.equal(attempts, 1);
  }
});

test("replacement path falls back only after a content rejection", async () => {
  const result = await updateCardWithRenderFallback("om_old", sampleCard(), async () => { throw rejected(); }, async () => "om_new");
  assert.deepEqual(result.messageIds, ["om_new"]);
  await assert.rejects(updateCardWithRenderFallback("om_old", sampleCard(), async () => { throw new Error("unauthorized"); }, async () => "om_new"), /unauthorized/);
});

test("a recovered turn render lets the caller advance to its next queued turn", async () => {
  const order: string[] = [];
  let firstAttempt = true;
  const turns = ["turn-1", "turn-2"];
  for (const turn of turns) {
    const card = { body: { elements: [{ tag: "markdown", content: turn }] } };
    const result = await sendCardWithRenderFallback(card, async () => {
      order.push(turn);
      if (turn === "turn-1" && firstAttempt) { firstAttempt = false; throw rejected(); }
      return `om_${turn}`;
    });
    assert.ok(result.messageIds.length);
  }
  assert.deepEqual(order, ["turn-1", "turn-1", "turn-2"]);
});
