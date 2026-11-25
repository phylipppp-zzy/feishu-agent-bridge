import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const unit = 'feishu-unified-production.service';
const properties = [
  'ActiveState', 'SubState', 'MainPID', 'ExecMainStartTimestamp', 'FragmentPath', 'ExecStartPre',
];
const repo = fileURLToPath(new URL('../../', import.meta.url));

async function readCommand(executable, args) {
  try {
    const { stdout } = await execFile(executable, args, {
      cwd: repo,
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const detail = error.stderr?.trim() || error.code;
    throw new Error(`${executable} ${args.join(' ')} 执行失败（${detail}）`, { cause: error });
  }
}

function inspectDatabase(path, inspect) {
  const db = new DatabaseSync(path, { readOnly: true, timeout: 1000 });
  try {
    return inspect(db);
  } finally {
    db.close();
  }
}

function recordTables(trace, db, filename, expected) {
  const statement = db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name=?");
  const present = expected.filter(table => statement.get(table));
  trace.observe(`只读查询 ${filename} 的 schema`, { present });
  for (const table of expected) {
    trace.check(`${filename} 含 ${table}`, () => assert.ok(present.includes(table)));
  }
}

export async function runLiveCheck(trace) {
  const stateDir = join(homedir(), '.local/state/feishu-unified-bridge');
  const config = join(homedir(), '.config/feishu-unified-bridge/config.json');
  await trace.stage(0, '切换后线上服务只读验证', async () => {
    await trace.step('读取生产 systemd 单元状态', async () => {
      const output = await readCommand('systemctl', ['--user', 'show', unit, '-p', properties.join(',')]);
      const fields = Object.fromEntries(output.trim().split('\n').map(line => {
        const equal = line.indexOf('=');
        return [line.slice(0, equal), line.slice(equal + 1)];
      }));
      // ExecStartPre can contain arguments from deployment-specific drop-ins.
      const { ExecStartPre, ...status } = fields;
      trace.observe('systemd 状态', { ...status, execStartPreConfigured: Boolean(ExecStartPre) });
      trace.check('ActiveState=active', () => assert.equal(fields.ActiveState, 'active'));
      trace.check('SubState=running', () => assert.equal(fields.SubState, 'running'));
      trace.check('生产进程存在且有启动时间', () => {
        assert.ok(Number(fields.MainPID) > 0);
        assert.ok(fields.ExecMainStartTimestamp);
      });
    });

    await trace.step('检查生产单元最近 20 条日志', async () => {
      const output = await readCommand('journalctl', ['--user', '-u', unit, '-n', '20', '--no-pager']);
      for (const marker of ['offline preflight passed', 'Unified runtime started.']) {
        const found = output.includes(marker);
        trace.observe('日志标记', { marker, found });
        trace.check(`日志包含 ${marker}`, () => assert.ok(found));
      }
    });

    await trace.step('只读检查 core.sqlite 的会话存储', () => {
      inspectDatabase(join(stateDir, 'core.sqlite'), db => {
        recordTables(trace, db, 'core.sqlite', ['sessions']);
        trace.observe('核心 SQLite 会话数', db.prepare('SELECT count(*) AS sessions FROM sessions').get());
      });
    });

    await trace.step('只读检查 channel.sqlite 的草稿、卡片、绑定和健康记录', () => {
      inspectDatabase(join(stateDir, 'channel.sqlite'), db => {
        recordTables(trace, db, 'channel.sqlite', [
          'channel_turn_card_attempts', 'channel_new_session_drafts', 'channel_bindings', 'channel_health_facts',
        ]);
        const bindingCount = db.prepare('SELECT count(*) AS activeBindings FROM channel_bindings').get();
        trace.observe('当前绑定数', bindingCount);
        const health = db.prepare(
          'SELECT component, status, observed_at, success_at, failure_at FROM channel_health_facts ORDER BY component',
        ).all();
        trace.observe('生产 channel_health_facts 行', health);
        trace.check('存在健康记录且状态有效', () => {
          assert.ok(health.length > 0);
          for (const { status, component } of health) {
            assert.ok(['healthy', 'degraded', 'unverified'].includes(status), component);
          }
        });
      });
    });

    await trace.step('只读检查 sdk.sqlite 的卡片 Schema 记录', () => {
      inspectDatabase(join(stateDir, 'sdk.sqlite'), db => {
        recordTables(trace, db, 'sdk.sqlite', ['sdk_card_schemas']);
        const schemas = db.prepare(
          'SELECT schema_version, count(*) AS messages FROM sdk_card_schemas GROUP BY schema_version ORDER BY schema_version',
        ).all();
        trace.observe('SDK 卡片 Schema 计数', schemas);
        trace.check('已记录的 Schema 版本有效', () => {
          for (const { schema_version } of schemas) assert.ok(['1.0', '2.0'].includes(schema_version));
        });
      });
    });

    await trace.step('用生产启动脚本验证配置语法', async () => {
      const info = statSync(config);
      trace.observe('配置文件权限', {
        mode: (info.mode & 0o777).toString(8).padStart(4, '0'),
        ownedByCurrentUser: info.uid === process.getuid(),
      });
      const stdout = await trace.check('统一启动脚本的语法验证退出码为 0', () =>
        readCommand(process.execPath, ['scripts/unified-start.mjs', '--config', config]));
      trace.observe('启动脚本输出', stdout.trim());
    });
  });
}
