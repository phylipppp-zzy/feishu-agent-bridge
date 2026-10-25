import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configureCardUi } from "../src/card-kit.js";
import { cardContentBytes } from "../src/text-limits.js";
import type { CardDefinition } from "../src/types.js";
import {
  TRUNCATION_NOTICE, UsageError, buildNotifyCard, loadAttachments, loadEnv, parseArgs, parseEnvFile, readChatId, readCredentials, run, sendNotification,
  type NotifyPort,
} from "../src/claude/notify.js";

async function withDir(work: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "claude-notify-"));
  try { await work(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("arguments need a title and exactly one of --markdown-file and --text, and --attach may repeat", () => {
  const parsed = parseArgs(["--title", "周报", "--markdown-file", "a.md", "--attach", "x.pdf", "--attach=y.csv", "--dry-run"], "/env");
  assert.deepEqual(parsed, { title: "周报", markdownFile: "a.md", text: null, attach: ["x.pdf", "y.csv"], envFile: "/env", dryRun: true });
  assert.equal(parseArgs(["--title", "t", "--text", "正文", "--env-file", "/e"]).envFile, "/e");
  assert.throws(() => parseArgs(["--text", "正文"]), UsageError);
  assert.throws(() => parseArgs(["--title", "t"]), /二选一/);
  assert.throws(() => parseArgs(["--title", "t", "--text", "a", "--markdown-file", "b.md"]), /二选一/);
  assert.throws(() => parseArgs(["--title", "t", "--text"]), /缺少取值/);
  assert.throws(() => parseArgs(["--title", "t", "--text", "a", "--bogus", "1"]), /不认识/);
  assert.throws(() => parseArgs(["--title", "a", "--title", "b", "--text", "x"]), /只能给一次/);
});

test("an env file follows the systemd format and never overrides variables that are already set", async () => {
  const parsed = parseEnvFile(`# comment\nA=1\nB="two words"\nC='x y'\n\nD="say \\"hi\\""\nbroken line\nE=\n`);
  assert.deepEqual(parsed, { A: "1", B: "two words", C: "x y", D: 'say "hi"', E: "" });
  await withDir(async (dir) => {
    const file = join(dir, "env");
    await writeFile(file, "FEISHU_APP_ID=from-file\nFEISHU_APP_SECRET=\"secret\"\n");
    const merged = await loadEnv(file, { FEISHU_APP_ID: "from-env" });
    assert.equal(merged.FEISHU_APP_ID, "from-env");
    assert.equal(merged.FEISHU_APP_SECRET, "secret");
    const none = await loadEnv(join(dir, "missing"), { FEISHU_APP_ID: "a", FEISHU_APP_SECRET: "b" });
    assert.equal(readCredentials(none, "x").appId, "a");
    assert.throws(() => readCredentials({}, join(dir, "missing")), /FEISHU_APP_ID/);
    assert.equal(readCredentials({ FEISHU_APP_ID: "a", FEISHU_APP_SECRET: "b", STATE_DIR: "/s" }, "x").stateDir, "/s");
  });
});

test("the card carries the title and body, and a body over the card limit is cut with a notice", () => {
  configureCardUi(2);
  const short = buildNotifyCard("周报", "## 本周\n- 完成实验");
  assert.equal(short.truncated, false);
  const json = JSON.stringify(short.card);
  assert.match(json, /周报/);
  assert.match(json, /完成实验/);
  const long = buildNotifyCard("周报", "汉字".repeat(20_000));
  assert.equal(long.truncated, true);
  const text = ((long.card as unknown as { body: { elements: Array<{ content: string }> } }).body.elements[0]!).content;
  assert.ok(text.endsWith(TRUNCATION_NOTICE));
  assert.ok(cardContentBytes(text) < 25_000);
});

test("the chat id is read from the bridge database, and an unbound or missing database gives null", async () => {
  await withDir(async (dir) => {
    assert.equal(await readChatId(dir), null);
    const db = new DatabaseSync(join(dir, "bridge.sqlite"));
    db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.close();
    assert.equal(await readChatId(dir), null);
    const writer = new DatabaseSync(join(dir, "bridge.sqlite"));
    writer.prepare("INSERT INTO settings(key,value) VALUES(?,?)").run("feishu.chat_id", "oc_group");
    writer.close();
    assert.equal(await readChatId(dir), "oc_group");
  });
});

function fakePort(failFile?: string): NotifyPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async sendCard(chatId: string, sent: CardDefinition) { calls.push(`card:${chatId}:${JSON.stringify(sent).includes("周报")}`); return "om_root"; },
    async replyFile(root: string, name: string) {
      if (name === failFile) throw new Error("upload failed");
      calls.push(`file:${root}:${name}`); return `om_${name}`;
    },
  };
}

test("sending posts the card first, then the files into its topic in order", async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, "a.md"), "a");
    await writeFile(join(dir, "b.csv"), "b");
    const attachments = await loadAttachments([join(dir, "a.md"), join(dir, "b.csv")]);
    const port = fakePort();
    configureCardUi(2);
    const rootId = await sendNotification(port, "oc_group", buildNotifyCard("周报", "正文").card, attachments);
    assert.equal(rootId, "om_root");
    assert.deepEqual(port.calls, ["card:oc_group:true", "file:om_root:a.md", "file:om_root:b.csv"]);
    await assert.rejects(sendNotification(fakePort("b.csv"), "oc_group", buildNotifyCard("周报", "正文").card, attachments), /om_root.*b\.csv/);
  });
});

test("a missing attachment fails before any message is sent", async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, "a.md"), "a");
    await assert.rejects(loadAttachments([join(dir, "a.md"), join(dir, "nope.pdf")]), /附件不存在/);
    await assert.rejects(run(["--title", "t", "--text", "x", "--attach", join(dir, "nope.pdf"), "--env-file", join(dir, "env")], {}, () => undefined), /附件不存在/);
  });
});

test("a dry run prints the card and attachments without credentials or network", async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, "r.md"), "# 报告\n内容");
    const lines: string[] = [];
    await run(["--title", "周报", "--markdown-file", join(dir, "r.md"), "--dry-run"], {}, (line) => lines.push(line));
    assert.match(lines[0]!, /报告/);
    assert.match(lines[1]!, /无/);
  });
});
