import assert from "node:assert/strict";
import test from "node:test";
import { FEISHU_CALLBACKS, FEISHU_EVENTS, FEISHU_MENUS, FEISHU_SCOPES, feishuDevelopmentConfig, parseEnvironment, renderEnvironment, renderSystemdUnit } from "../src/installer.js";

test("installer requests the bridge's minimal Feishu configuration", () => {
  assert.deepEqual(FEISHU_EVENTS, ["im.message.receive_v1", "application.bot.menu_v6"]);
  assert.deepEqual(FEISHU_CALLBACKS, ["card.action.trigger"]);
  assert.ok(FEISHU_SCOPES.includes("im:message:send_as_bot"));
  assert.deepEqual(FEISHU_MENUS.map((menu) => menu.eventKey), ["codex.home", "codex.new", "codex.sessions", "codex.search", "codex.service"]);
  assert.deepEqual(feishuDevelopmentConfig("ou_owner").visibility, {
    is_visible_to_all: false, visible_list: { user_ids: ["ou_owner"] },
  });
});

test("installer renders portable secret-safe environment and systemd files", () => {
  const env = renderEnvironment({ FEISHU_APP_ID: "cli_test", FEISHU_APP_SECRET: "a\\b\"c" });
  assert.match(env, /FEISHU_APP_SECRET="a\\\\b\\"c"/);
  assert.deepEqual(parseEnvironment(env), { FEISHU_APP_ID: "cli_test", FEISHU_APP_SECRET: "a\\b\"c" });
  const unit = renderSystemdUnit({ projectDir: "/home/alice/tools/bridge", nodeBin: "/usr/bin/node", environmentFile: "/home/alice/.config/bridge/env" });
  // systemd 259 rejects quoted path settings ("path is not absolute"); only Exec lines take quotes.
  assert.match(unit, /^WorkingDirectory=\/home\/alice\/tools\/bridge$/m);
  assert.match(unit, /^EnvironmentFile=\/home\/alice\/\.config\/bridge\/env$/m);
  assert.match(unit, /ExecStart="\/usr\/bin\/node" "\/home\/alice\/tools\/bridge\/dist\/src\/index\.js"/);
  assert.doesNotMatch(unit, /zhangzy|v24\.18\.0/);
  const spaced = renderSystemdUnit({ projectDir: "/home/alice/my tools/100%", nodeBin: "/usr/bin/node", environmentFile: "/home/alice/env", entry: "dist/src/claude/index.js" });
  assert.match(spaced, /^WorkingDirectory=\/home\/alice\/my tools\/100%%$/m);
  assert.match(spaced, /^ExecStart="\/usr\/bin\/node" "\/home\/alice\/my tools\/100%%\/dist\/src\/claude\/index\.js"$/m);
  assert.throws(() => renderSystemdUnit({ projectDir: "relative/dir", nodeBin: "/usr/bin/node", environmentFile: "/home/alice/env" }), /must be absolute/);
  assert.throws(() => renderSystemdUnit({ projectDir: "/home/alice/a\"b", nodeBin: "/usr/bin/node", environmentFile: "/home/alice/env" }), /free of quotes/);
});
