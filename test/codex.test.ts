import assert from "node:assert/strict";
import test from "node:test";
import { parseModelCatalog } from "../src/codex.js";

test("model catalog keeps only visible, well-formed models and their supported efforts", () => {
  const models = parseModelCatalog(JSON.stringify({ models: [
    { slug: "visible", display_name: "Visible", description: "usable", visibility: "list", default_reasoning_level: "medium", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: 42 }] },
    { slug: "hidden", visibility: "hidden", default_reasoning_level: "low", supported_reasoning_levels: [{ effort: "low" }] },
    { slug: "broken", visibility: "list", default_reasoning_level: "high", supported_reasoning_levels: [{ effort: "low" }] },
  ] }));
  assert.deepEqual(models, [{ slug: "visible", displayName: "Visible", description: "usable", defaultReasoningEffort: "medium", supportedReasoningEfforts: ["low", "medium"] }]);
  assert.throws(() => parseModelCatalog("not json"));
});
