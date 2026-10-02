import assert from "node:assert/strict";
import test from "node:test";
import { isTranscriptPath, projectFolderName, sessionProjectDir, transcriptSessionId } from "../src/claude/importer.js";

test("transcripts are found by their place and name, and belong to the directory their session started in", () => {
  const projects = "/home/tester/.claude/projects";
  const path = `${projects}/-home-tester-my-app/aaaaaaaa-0000-4000-8000-000000000001.jsonl`;
  assert.equal(transcriptSessionId(path), "aaaaaaaa-0000-4000-8000-000000000001");
  assert.equal(isTranscriptPath(path, projects), true);
  assert.equal(isTranscriptPath(`${projects}/-home-tester-my-app/aaaaaaaa-0000-4000-8000-000000000001/subagents/agent-1.jsonl`, projects), false);
  assert.equal(projectFolderName("/home/tester/my_app.v2"), "-home-tester-my-app-v2");
  // The shell moved into a subdirectory; the folder still names the starting directory.
  assert.equal(sessionProjectDir(path, "/home/tester/my-app/src/lib"), "/home/tester/my-app");
  assert.equal(sessionProjectDir(path, "/home/tester/my-app"), "/home/tester/my-app");
  // A directory outside the project (for example one added with --add-dir) is kept as it is.
  assert.equal(sessionProjectDir(path, "/data/shared"), "/data/shared");
  assert.equal(sessionProjectDir(path, null), null);
});
