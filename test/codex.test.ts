import assert from "node:assert/strict";
import test from "node:test";
import { codexArgs, parseModelCatalog } from "../src/codex.js";

test("Codex runner preserves sandbox controls and supports non-Git directories", () => {
  const dir = "/home/tester/docs";
  assert.deepEqual(codexArgs({ cwd: dir, prompt: "new" }),
    ["-a", "never", "-s", "workspace-write", "exec", "--skip-git-repo-check", "--json", "-C", dir, "-"]);
  assert.deepEqual(codexArgs({ cwd: dir, sessionId: "session-1", prompt: "continue" }),
    ["-a", "never", "-s", "workspace-write", "exec", "resume", "--skip-git-repo-check", "--json", "session-1", "-"]);
  assert.deepEqual(codexArgs({ cwd: dir, prompt: "new", model: "gpt-5.6-sol", reasoningEffort: "high" }),
    ["-a", "never", "-s", "workspace-write", "-m", "gpt-5.6-sol", "-c", 'model_reasoning_effort="high"', "exec", "--skip-git-repo-check", "--json", "-C", dir, "-"]);
  assert.deepEqual(codexArgs({ cwd: dir, sessionId: "session-1", prompt: "continue", model: "gpt-5.6-terra", reasoningEffort: "ultra" }),
    ["-a", "never", "-s", "workspace-write", "-m", "gpt-5.6-terra", "-c", 'model_reasoning_effort="ultra"', "exec", "resume", "--skip-git-repo-check", "--json", "session-1", "-"]);
});

test("model catalog keeps only visible, well-formed models and their supported efforts", () => {
  const models = parseModelCatalog(JSON.stringify({ models: [
    { slug: "visible", display_name: "Visible", description: "usable", visibility: "list", default_reasoning_level: "medium",
      supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: 42 }] },
    { slug: "hidden", visibility: "hidden", default_reasoning_level: "low", supported_reasoning_levels: [{ effort: "low" }] },
    { slug: "broken", visibility: "list", default_reasoning_level: "high", supported_reasoning_levels: [{ effort: "low" }] },
  ] }));
  assert.deepEqual(models, [{ slug: "visible", displayName: "Visible", description: "usable", defaultReasoningEffort: "medium", supportedReasoningEfforts: ["low", "medium"] }]);
  assert.throws(() => parseModelCatalog("not json"));
});
