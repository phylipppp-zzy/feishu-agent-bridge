import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

if (!process.argv.includes("--confirm")) {
  console.error("Refusing to reset the Feishu binding. Stop the service, then run: npm run rebind -- --confirm");
  process.exit(1);
}

try {
  execFileSync("systemctl", ["--user", "is-active", "--quiet", "feishu-codex-bridge.service"]);
  console.error("Stop feishu-codex-bridge.service before rebinding.");
  process.exit(1);
} catch (error) {
  if (error?.status === 0) process.exit(1);
}

const stateDir = resolve(process.env.STATE_DIR ?? join(homedir(), ".local/state/feishu-codex-bridge"));
const databasePath = join(stateDir, "bridge.sqlite");
if (!existsSync(databasePath)) {
  console.error(`No bridge database found at ${databasePath}`);
  process.exit(1);
}

const backupPath = join(stateDir, `bridge.sqlite.before-rebind-${new Date().toISOString().replace(/[:.]/g, "-")}.bak`);
copyFileSync(databasePath, backupPath, 0);
const db = new DatabaseSync(databasePath);
try {
  db.exec("BEGIN IMMEDIATE");
  db.exec(`DELETE FROM settings WHERE key LIKE 'feishu.%' OR key LIKE 'wizard.%' OR key LIKE 'choice.%' OR key LIKE 'prompt.%' OR key LIKE 'session.%';
    UPDATE sessions SET root_message_id=NULL,root_app_link=NULL,chat_id=NULL,thread_id=NULL,session_card_message_id=NULL;
    DELETE FROM messages;
    DELETE FROM run_status;
    DELETE FROM file_cursors;
    DELETE FROM archive_parts;
    UPDATE failures SET resolved=1,updated_at=CURRENT_TIMESTAMP WHERE operation IN ('message_link','message_link_permission','control_card');
    COMMIT;`);
  console.log(`Feishu binding reset. Backup: ${backupPath}`);
  console.log("Start the service, add the bot to the new private topic group, then send /bind <new token> with @bot.");
} catch (error) {
  try { db.exec("ROLLBACK"); } catch { /* transaction was not opened */ }
  throw error;
} finally {
  db.close();
}
