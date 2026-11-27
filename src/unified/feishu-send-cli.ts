import {
  FeishuSendError,
  listFeishuTopics,
  loadDefaultFeishuContext,
  sendToFeishu,
  type FeishuSendTransport,
} from './feishu-send.js';

export interface CliIo {
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  cwd?: string;
  transport?: FeishuSendTransport;
}

const HELP_TEXT = `用法:
  feishu-send [选项] [文件1 文件2 ...]
  feishu-send --list-topics [数量] [--json]

说明:
  将本地文件、图片或简报消息直接发送到飞书（支持按会话话题路由，图片自动内嵌预览，文档/PDF/表格/代码走对应在线预览文件消息；不传文件时可通过 -m/-t 单独发送纯文本或卡片简报）。

目标选项（四选一；省略时默认发到主群）:
  -s, --session <id>        发到指定会话对应的飞书话题（支持完整 session_id 或原生 UUID）
  -r, --root <message_id>   发到指定根消息对应的话题（reply_in_thread）
  -c, --chat <chat_id>      发到指定群聊主信息流
      --latest              发到最近活跃的用户对话飞书话题（自动排除内部系统话题）

消息与文件选项:
  -m, --caption <text>      附带说明文案（不传文件时直接发送纯文本消息）
  -t, --title <text>        以带标题的卡片发送说明文案（可单独或配合 -m 使用）
      --as-file             图片也强制按原文件消息发送（保留原图不走图片消息）
      --allow-sensitive     允许发送匹配敏感文件规则的文件（默认拦截 .env/私钥/凭据等）
      --dry-run             仅校验文件与解析路由，不实际调用飞书接口
      --json                以 JSON 格式输出结构化结果

查询与配置选项:
      --list-topics [N]     只读列出最近的飞书话题路由（默认 20 条）
      --config <path>       覆盖默认桥接配置文件路径
      --env <path>          覆盖默认凭据 env 文件路径
  -h, --help                显示本帮助信息

示例:
  feishu-send --session e1530534-edd6-4ca4-aa84-755e7b809489 report.pdf plot.png
  feishu-send --latest -t "实验结果" -m "M3-E2 评估曲线与汇总表" metrics.csv loss.png
  feishu-send --dry-run --json ./notes.md
`;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

export async function runFeishuSendCli(args: readonly string[], io?: CliIo): Promise<number> {
  const out = io?.stdout ?? ((line: string) => console.log(line));
  const err = io?.stderr ?? ((line: string) => console.error(line));

  let session: string | undefined;
  let rootMessageId: string | undefined;
  let chatId: string | undefined;
  let latest = false;
  let caption: string | undefined;
  let title: string | undefined;
  let asFile = false;
  let allowSensitive = false;
  let dryRun = false;
  const dashDashIdx = args.indexOf('--');
  const optionArgs = dashDashIdx >= 0 ? args.slice(0, dashDashIdx) : args;
  let json = optionArgs.includes('--json');
  let listTopicsLimit: number | null = null;
  let configPath: string | undefined;
  let envPath: string | undefined;
  const files: string[] = [];

  try {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === '--') {
        files.push(...args.slice(i + 1));
        break;
      }
      if (arg === '-h' || arg === '--help') {
        out(HELP_TEXT.trimEnd());
        return 0;
      }
      if (arg === '-s' || arg === '--session') {
        const val = args[++i];
        if (!val) throw new FeishuSendError('invalid_argument', `${arg} 需要提供会话 ID。`);
        session = val;
        continue;
      }
      if (arg === '-r' || arg === '--root') {
        const val = args[++i];
        if (!val) throw new FeishuSendError('invalid_argument', `${arg} 需要提供根消息 ID。`);
        rootMessageId = val;
        continue;
      }
      if (arg === '-c' || arg === '--chat') {
        const val = args[++i];
        if (!val) throw new FeishuSendError('invalid_argument', `${arg} 需要提供 chat_id。`);
        chatId = val;
        continue;
      }
      if (arg === '--latest') {
        latest = true;
        continue;
      }
      if (arg === '-m' || arg === '--caption') {
        const val = args[++i];
        if (val === undefined) throw new FeishuSendError('invalid_argument', `${arg} 需要提供说明文案。`);
        caption = val;
        continue;
      }
      if (arg === '-t' || arg === '--title') {
        const val = args[++i];
        if (val === undefined) throw new FeishuSendError('invalid_argument', `${arg} 需要提供卡片标题。`);
        title = val;
        continue;
      }
      if (arg === '--as-file') {
        asFile = true;
        continue;
      }
      if (arg === '--allow-sensitive') {
        allowSensitive = true;
        continue;
      }
      if (arg === '--dry-run') {
        dryRun = true;
        continue;
      }
      if (arg === '--json') {
        json = true;
        continue;
      }
      if (arg === '--list-topics') {
        const next = args[i + 1];
        if (next && /^\d+$/.test(next)) {
          listTopicsLimit = Number(next);
          i++;
        } else {
          listTopicsLimit = 20;
        }
        continue;
      }
      if (arg === '--config') {
        const val = args[++i];
        if (!val) throw new FeishuSendError('invalid_argument', '--config 需要提供文件路径。');
        configPath = val;
        continue;
      }
      if (arg === '--env') {
        const val = args[++i];
        if (!val) throw new FeishuSendError('invalid_argument', '--env 需要提供文件路径。');
        envPath = val;
        continue;
      }
      if (arg.startsWith('-')) {
        throw new FeishuSendError('invalid_argument', `未知选项：${arg}（使用 --help 查看用法）`);
      }
      files.push(arg);
    }

    if (listTopicsLimit !== null) {
      const ctx = loadDefaultFeishuContext({
        ...(configPath ? { configPath } : {}),
        ...(envPath ? { envPath } : {}),
      });
      if (!ctx.sdkDbPath) {
        throw new FeishuSendError('target_not_found', `无法从 ${ctx.configPath} 读取 sdkDb 路径。`);
      }
      const topics = listFeishuTopics(ctx.sdkDbPath, listTopicsLimit, ctx.coreDbPath);
      if (json) {
        out(JSON.stringify({ ok: true, count: topics.length, topics }, null, 2));
      } else if (!topics.length) {
        out('暂无已记录的飞书话题路由。');
      } else {
        out(`最近 ${topics.length} 条飞书话题路由（新 → 旧）：`);
        for (const t of topics) {
          const head = t.provider || t.title ? `[${t.provider ?? '?'}] ${t.title ?? '(无标题)'} | ` : '';
          const nativePart = t.nativeSessionId ? `native: ${t.nativeSessionId} | ` : '';
          out(`- ${head}${nativePart}root: ${t.rootId} | session: ${t.sessionId}`);
        }
      }
      return 0;
    }

    const result = await sendToFeishu({
      files,
      ...(session ? { session } : {}),
      ...(rootMessageId ? { rootMessageId } : {}),
      ...(chatId ? { chatId } : {}),
      ...(latest ? { latest: true } : {}),
      ...(caption ? { caption } : {}),
      ...(title ? { title } : {}),
      ...(asFile ? { asFile: true } : {}),
      ...(allowSensitive ? { allowSensitive: true } : {}),
      ...(dryRun ? { dryRun: true } : {}),
      ...(io?.cwd ? { cwd: io.cwd } : {}),
      ...(configPath ? { configPath } : {}),
      ...(envPath ? { envPath } : {}),
      ...(io?.transport ? { transport: io.transport } : {}),
    });

    if (json) {
      out(JSON.stringify(result, null, 2));
    } else {
      const targetDesc =
        result.target.kind === 'topic'
          ? `话题 root=${result.target.rootMessageId}${result.target.sessionId ? ` (${result.target.sessionId})` : ''}`
          : `群聊 chat=${result.target.chatId}`;
      out(`${result.dryRun ? '[DRY-RUN] 计划发送到' : '已发送到'} ${targetDesc}`);
      if (result.captionMessageId) {
        out(`  说明消息: message_id=${result.captionMessageId}`);
      } else if (result.dryRun && (caption?.trim() || title?.trim())) {
        out(`  说明消息: [dry_run] ${title?.trim() ? `卡片 "${title.trim()}"` : '纯文本'}`);
      }
      for (const f of result.files) {
        const idPart = f.messageId ? ` message_id=${f.messageId}` : '';
        out(`  - [${f.mode}] ${f.name} (${formatSize(f.size)})${idPart}`);
        if (f.warning) out(`    提示: ${f.warning}`);
      }
    }
    return 0;
  } catch (error) {
    const code = error instanceof FeishuSendError ? error.code : 'unexpected_error';
    const message = error instanceof Error ? error.message : String(error);
    if (json) {
      err(JSON.stringify({ ok: false, code, error: message }, null, 2));
    } else {
      err(`发送失败 [${code}]: ${message}`);
    }
    return 1;
  }
}
