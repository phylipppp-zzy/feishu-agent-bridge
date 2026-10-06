import assert from "node:assert/strict";
import test from "node:test";
import { SlowCardActions } from "../src/card-actions.js";
import type { CardDefinition } from "../src/types.js";

test("a slow card action answers at once, refuses a second tap while running, and puts its result on the tapped card", async () => {
  const updated: Array<{ id: string; card: CardDefinition }> = [];
  const errors: string[] = [];
  const actions = new SlowCardActions({ updateCard: async (id, card) => { updated.push({ id, card }); } }, (key) => errors.push(key), 20);
  let finish!: () => void;
  const work = new Promise<void>((resolve) => { finish = resolve; });
  let runs = 0;
  const run = () => actions.run("msg-1", "new:msg-1", { step: "pending" }, async () => { runs += 1; await work; return { step: "done" }; }, () => ({ step: "failed" }));

  assert.deepEqual(run(), { delivery: "replace", card: { step: "pending" } });
  assert.deepEqual(run(), { delivery: "toast", text: "正在处理，请稍候。", level: "info" }, "a second tap does not start the work again");
  assert.equal(runs, 1);
  finish();
  const tappedAt = Date.now();
  while (!updated.length) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(Date.now() - tappedAt >= 10, "the result waits for the callback's own card to be in place");
  assert.deepEqual(updated, [{ id: "msg-1", card: { step: "done" } }]);
  assert.equal(actions.busy("new:msg-1"), false);

  actions.run("msg-2", "boom", { step: "pending" }, async () => { throw new Error("boom"); }, (error) => ({ step: "failed", reason: (error as Error).message }));
  while (updated.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(updated[1], { id: "msg-2", card: { step: "failed", reason: "boom" } });
  assert.deepEqual(errors, ["boom"]);
});
