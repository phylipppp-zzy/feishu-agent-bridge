import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { verifyStatusAfterFailure } from './status.mjs';

function cardWith(ctx, topic, title) {
  const message = ctx.writes(topic).findLast(({ card }) => card?.title === title);
  ctx.trace.check(`出现「${title}」卡片`, () => assert.ok(message));
  return message;
}

function action(message, name, field) {
  const button = message.card.buttons.find(({ value }) =>
    value?.action === name && (field === undefined || value.field === field));
  assert.ok(button, `「${message.card.title}」缺少 ${name} 操作`);
  return button;
}

function assertTurn(ctx, topic, turnId, status) {
  assert.equal(ctx.runtime.store.listTurns(topic.sessionId).find(turn => turn.turnId === turnId)?.status, status);
}

async function waitForCard(ctx, topic, predicate) {
  const deadline = performance.now() + 2200;
  do {
    const message = ctx.writes(topic).findLast(({ card }) => predicate(card));
    if (message) return message;
    await delay(60);
    await ctx.tick();
  } while (performance.now() < deadline);
}

const interruptedCard = card => card.title === 'Codex · 已中断' && card.template === 'grey';
const failedInputReceipt = card => card.title === '操作回执' && card.bodyText.includes('发送输入：失败');

async function busyTurn(ctx) {
  const { trace, runtime, topics: { codex }, providers: { codex: provider } } = ctx;
  let busy, followUpTurnId, cancelButton, panel, stopped;
  await trace.stage(4, '运行中追发消息、排队、插话转向、面板查看与中断恢复', async () => {
    await trace.step('4.0 在 Codex 话题发送「检查核心模块，保持本轮运行」，等待流式进展', async () => {
      busy = await ctx.start(codex, '检查核心模块，保持本轮运行');
      ctx.emitText(codex, '正在检查核心模块。', { final: false });
      await ctx.settle();
      trace.check('原始轮次正在运行', () => assertTurn(ctx, codex, busy.turnId, 'running'));
    });

    await trace.step('4.1 原始轮次运行中，发送普通消息「顺便看下日志」', async () => {
      const count = provider.inputs.length;
      await ctx.send(codex, '顺便看下日志');
      await ctx.settle();
      const input = provider.inputs[count];
      trace.check('普通消息按 new 模式交给后端，未写入显式队列', () => {
        assert.equal(provider.inputs.length, count + 1);
        assert.equal(input.text, '顺便看下日志');
        assert.equal(input.mode, 'new');
        assert.notEqual(input.turnId, busy.turnId);
        assertTurn(ctx, codex, busy.turnId, 'running');
        assert.equal(runtime.store.queuedInputs(codex.sessionId).length, 0);
      });
      trace.check('飞书未发送排队回执', () => {
        assert.ok(ctx.writes(codex).every(({ card }) =>
          card.title !== '操作回执' && card.buttons.every(({ label }) => label !== '查看排队')));
      });
      trace.observe('模拟后端接受了新的轮次。普通追发未入队，飞书没有发送排队回执。', {
        originalTurnId: busy.turnId,
        followUpTurnId: input.turnId,
      });
      followUpTurnId = input.turnId;
    });

    await trace.step('4.1 后端完成追发消息，原始轮次继续运行', async () => {
      await ctx.finish(codex, '日志已看过，未发现新错误。', { turnId: followUpTurnId });
      trace.check('追发消息独立完成，原始轮次仍然运行', () => {
        assertTurn(ctx, codex, followUpTurnId, 'completed');
        assertTurn(ctx, codex, busy.turnId, 'running');
      });
    });

    await trace.step('4.2 发送「/queue 跑完顺便更新一下 README」', async () => {
      const count = provider.inputs.length;
      await ctx.send(codex, '/queue 跑完顺便更新一下 README');
      await ctx.settle();
      const receipt = cardWith(ctx, codex, '已加入排队');
      trace.check('显示查看排队按钮，输入尚未到达后端', () => {
        assert.equal(receipt.card.template, 'blue');
        assert.equal(receipt.card.bodyText, '跑完顺便更新一下 README');
        assert.ok(receipt.card.buttons.some(({ label }) => label === '查看排队'));
        assert.equal(runtime.store.queuedInputs(codex.sessionId).length, 1);
        assert.equal(provider.inputs.length, count);
      });
    });

    await trace.step('4.2 在原始轮次运行时发送「/status」', async () => {
      await ctx.send(codex, '/status');
      await ctx.settle();
      panel = cardWith(ctx, codex, '会话控制');
      cancelButton = action(panel, 'cancel');
      trace.check('面板显示运行状态和排队计数，并提供取消和中断按钮', () => {
        assert.match(panel.card.bodyText, /状态：运行中/);
        assert.match(panel.card.bodyText, /排队中：1 条/);
        assert.match(cancelButton.label, /取消排队/);
        assert.match(action(panel, 'stop').label, /中断/);
        assert.equal(action(panel, 'stop').type, 'primary');
        assert.ok(panel.card.buttons.indexOf(cancelButton) < panel.card.buttons.findIndex(({value}) => value?.action === 'notice_settings'));
        assert.equal(action(panel, 'stop').value.turnId, busy.turnId);
      });
    });

    await trace.step('4.2 点击「取消排队输入 1」', async () => {
      const before = provider.inputs.length;
      const callback = await ctx.click(panel, cancelButton.label);
      await ctx.settle();
      trace.check('取消弹出确认，排队记录消失且没有输入失败回执', () => {
        assert.deepEqual(callback.result, { toast: { type: 'success', content: '已确认' } });
        assert.equal(runtime.store.queuedInputs(codex.sessionId).length, 0);
        assert.equal(provider.inputs.length, before);
        assert.ok(!ctx.writes(codex).some(({ card }) => failedInputReceipt(card)));
        const writes = ctx.writes(codex);
        assert.deepEqual(writes.map(({id,method}) => ({id,method})), [{id:panel.id,method:'im.message.patch'}]);
        assert.ok(!writes[0].card.buttons.some(({ value }) => value?.action === 'cancel'));
      });
    });

    await trace.step('4.2 发送「/panel」复核取消结果', async () => {
      await ctx.send(codex, '/panel');
      await ctx.settle();
      const afterPanel = cardWith(ctx, codex, '会话控制');
      trace.check('更新后的控制面板移除排队计数和取消排队按钮', () => {
        assert.doesNotMatch(afterPanel.card.bodyText, /排队中/);
        assert.ok(!afterPanel.card.buttons.some(({ value }) => value?.action === 'cancel'));
      });
    });

    await trace.step('4.3 发送「/steer 优先只检查核心模块，跳过归档目录」', async () => {
      const count = provider.inputs.length;
      await ctx.send(codex, '/steer 优先只检查核心模块，跳过归档目录');
      await ctx.settle();
      trace.check('精准转向原始运行轮次，话题收到一次确认', () => {
        assert.equal(provider.inputs.length, count + 1);
        const input = provider.inputs[count];
        assert.equal(input.mode, 'steer');
        assert.equal(input.turnId, busy.turnId);
        assert.equal(input.text, '优先只检查核心模块，跳过归档目录');
        const confirmations = ctx.writes(codex).filter(({ card }) => card.title === '已发送引导');
        assert.equal(confirmations.length, 1);
        assert.equal(confirmations[0].card.template, 'blue');
        assert.equal(confirmations[0].card.bodyText, '已向当前运行中的轮次追加引导：优先只检查核心模块，跳过归档目录');
      });
    });

    await trace.step('4.4 发送「/stop」中断原始轮次', async () => {
      const count = provider.interrupts.length;
      await ctx.send(codex, '/stop');
      await ctx.settle();
      const interrupted = await waitForCard(ctx, codex, interruptedCard);
      trace.check('后端收到一次中断并结算为灰色卡片', () => {
        assert.equal(provider.interrupts.length, count + 1);
        assert.equal(provider.interrupts[count].turnId, busy.turnId);
        assertTurn(ctx, codex, busy.turnId, 'interrupted');
        assert.ok(interrupted);
        assert.ok(!ctx.writes(codex).some(({ card }) => failedInputReceipt(card)));
        const notice = ctx.writes(codex).find(({ card }) => card.title === '会话更新' && card.bodyText.includes('未发现残留进程'));
        assert.match(notice?.card.bodyText ?? '', /^本轮已确认中断（未发现残留进程）。\n核对时间 \d{4}-\d{2}-\d{2} \d{2}:\d{2} 北京$/);
      });
    });

    await trace.step('4.4 发送「重新开始：只输出简短结论」', async () => {
      const turn = await ctx.start(codex, '重新开始：只输出简短结论');
      trace.check('新轮次启动后会话恢复运行中', () => {
        assert.equal(runtime.store.getSession(codex.sessionId).status, 'running');
      });
      await ctx.finish(codex, '核心模块运行正常。');
      const result = await waitForCard(ctx, codex, card => card.bodyText.includes('核心模块运行正常。'));
      trace.check('中断后的新输入独立完成', () => {
        assert.notEqual(turn.turnId, busy.turnId);
        assertTurn(ctx, codex, turn.turnId, 'completed');
        assert.equal(runtime.store.getSession(codex.sessionId).status, 'idle');
        assert.ok(result);
      });
    });

    await trace.step('4.4 发送「请检查归档前的运行状态」并打开控制面板', async () => {
      const buttonTurn = await ctx.start(codex, '请检查归档前的运行状态');
      ctx.emitText(codex, '正在检查运行状态。', { final: false });
      await ctx.settle();
      await ctx.send(codex, '/status');
      await ctx.settle();
      const stopPanel = cardWith(ctx, codex, '会话控制');
      const stop = action(stopPanel, 'stop');
      trace.check('停止按钮只指向这次新轮次', () => assert.equal(stop.value.turnId, buttonTurn.turnId));
      stopped = { stopPanel, stop, buttonTurn, before: provider.interrupts.length };
    });

    await trace.step('4.4 点击面板的「中断当前回复」', async () => {
      const { stopPanel, stop, buttonTurn, before } = stopped;
      await ctx.click(stopPanel, stop.label);
      await ctx.settle();
      const interrupted = await waitForCard(ctx, codex, interruptedCard);
      trace.check('按钮中断对应轮次，最终卡为灰色', () => {
        assert.equal(provider.interrupts.length, before + 1);
        assert.equal(provider.interrupts[before].turnId, buttonTurn.turnId);
        assertTurn(ctx, codex, buttonTurn.turnId, 'interrupted');
        assert.ok(interrupted);
        assert.ok(!ctx.writes(codex).some(({ card }) => failedInputReceipt(card)));
      });
    });

    await trace.step('4.4 再次点击旧面板的「中断当前回复」', async () => {
      const { stopPanel, stop, before } = stopped;
      await ctx.click(stopPanel, stop.label);
      await ctx.settle();
      trace.check('按钮只中断对应轮次一次，重复点击显示中断及残留核对结果', () => {
        assert.equal(provider.interrupts.length, before + 1);
        assert.ok(ctx.writes(codex).some(({ card }) =>
          card.title === '中断回复' && /已确认中断（未发现残留进程）。[\s\S]*未再次发出中断/.test(card.bodyText)));
      });
    });
    await verifyStatusAfterFailure(ctx, codex);
  });
}

function assertUpload(ctx, topic, start, filename, bytes) {
  const uploads = [...ctx.wire.uploads.entries()].slice(start);
  assert.equal(uploads.length, 1, `预期只上传 ${filename}`);
  const [key, uploaded] = uploads[0];
  assert.equal(uploaded.name, filename);
  assert.deepEqual(uploaded.content, bytes);
  const reply = ctx.wire.calls.map(call => call.message).find(message =>
    message?.type === 'file' && JSON.parse(message.content).file_key === key);
  assert.ok(reply, '上传后应发送飞书文件消息');
  assert.equal(reply.rootId, topic.rootId, '文件应出现在所操作的会话话题');
  return uploaded;
}

async function models(ctx) {
  const { trace, runtime, topics: { agy, codex } } = ctx;
  for (const [name, topic, expected, selected] of [
    ['Antigravity', agy, /Carbon.*Neon.*Hydrogen/s, /Carbon.*深度推理/],
    ['Codex', codex, /GPT-6\.2 Sol.*GPT-6\.2 Astra|GPT-6\.2 Astra.*GPT-6\.2 Sol/s, /\/ high$/],
  ]) {
    let originalCard, choice;
    await trace.step(`5.1 在 ${name} 话题发送「/model」`, async () => {
      await ctx.send(topic, '/model');
      await ctx.settle();
      originalCard = cardWith(ctx, topic, '模型');
      const buttons = originalCard.card.buttons.filter(({ value }) => value?.action === 'settings');
      choice = buttons.find(({ label }) => selected.test(label));
      trace.check('模型卡显示可用模型与强度，并存在要选择的预设', () => {
        const labels = buttons.map(({ label }) => label).join(' · ');
        assert.match(labels, expected);
        assert.ok(choice, `可见按钮 ${labels}`);
      });
    });
    await trace.step(`5.1 在 ${name} 模型卡点击「${choice.label}」`, async () => {
      const callback = await ctx.click(originalCard, choice.label);
      await ctx.settle();
      const updatedCard = ctx.cards(topic).find(({ id }) => id === originalCard.id);
      trace.check('回调确认且所选模型与强度已写入生产会话设置', () => {
        assert.deepEqual(callback.result, { toast: { type: 'success', content: '已确认' } });
        const setting = runtime.store.confirmedSettings(topic.sessionId);
        assert.equal(setting?.model, choice.value.model);
        assert.deepEqual(setting.preferences, choice.value.preferences);
      });
      trace.check('只更新原模型卡，并以主按钮标记当前预设', () => {
        const writes = ctx.writes(topic).filter(({card}) => card.title === '模型');
        assert.deepEqual(writes.map(({id,method}) => ({id,method})), [{id:originalCard.id,method:'im.message.patch'}]);
        assert.ok(updatedCard.card.bodyText.includes(choice.value.model));
        assert.deepEqual(updatedCard.card.buttons.filter(({type}) => type === 'primary').map(({label}) => label), [`✓ ${choice.label}`]);
      });
    });
    await trace.step(`5.1 在 ${name} 话题重新发送「/model」查看已保存的设置`, async () => {
      await ctx.send(topic, '/model');
      await ctx.settle();
      const reopened = cardWith(ctx, topic, '模型');
      trace.check('重新打开模型卡可见已提交选项', () => {
        assert.ok(reopened.card.bodyText.includes(choice.value.model));
        assert.ok(reopened.card.bodyText.includes(choice.value.preferences.reasoningEffort));
        assert.deepEqual(reopened.card.buttons.filter(({type}) => type === 'primary').map(({label}) => label), [`✓ ${choice.label}`]);
      });
    });
  }
}

async function projectFiles(ctx) {
  const { trace, projects: { bridge }, topics: { codex } } = ctx;
  const hidden = '.journey-note.md';
  await writeFile(join(bridge, hidden), '隐藏笔记\n');

  for (const command of ['/ls', '/ls -a']) {
    await trace.step(`5.2 在 Codex 话题发送「${command}」`, async () => {
      await ctx.send(codex, command);
      await ctx.settle();
      const listing = cardWith(ctx, codex, '项目目录');
      trace.check('目录显示项目文件和子目录，凭据命名文件始终隐藏', () => {
        assert.match(listing.card.bodyText, /README\.md/);
        assert.match(listing.card.bodyText, /outputs\//);
        assert.match(listing.card.bodyText, /src\//);
        assert.doesNotMatch(listing.card.bodyText, /\.env\.example/);
        assert.equal(listing.card.bodyText.includes(hidden), command === '/ls -a');
      });
    });
  }

  for (const [path, filename] of [['README.md', 'README.md'], ['outputs/eval_report.md', 'eval_report.md']]) {
    await trace.step(`5.2 发送「/deliver ${path}」`, async () => {
      const before = ctx.wire.uploads.size;
      const bytes = await readFile(join(bridge, path));
      await ctx.send(codex, `/deliver ${path}`);
      await ctx.settle();
      trace.check('SDK 上传和话题内文件消息对应原始字节，成功时没有多余结果卡', () => {
        assertUpload(ctx, codex, before, filename, bytes);
        assert.ok(!ctx.writes(codex).some(({card}) => card.title === '文件发送结果'));
      });
    });
  }

  await trace.step('5.2 发送「/deliver ../outside_secret.txt」', async () => {
    const before = ctx.wire.uploads.size;
    await ctx.send(codex, '/deliver ../outside_secret.txt');
    await ctx.settle();
    const rejected = cardWith(ctx, codex, '文件操作未完成');
    trace.check('越界路径被拦截且未上传文件', () => {
      assert.match(rejected.card.bodyText, /仅支持项目内路径/);
      assert.equal(ctx.wire.uploads.size, before);
    });
  });
}

async function artifacts(ctx) {
  const { trace, projects: { bridge }, topics: { codex } } = ctx;
  // Production EnrichedPort observes final assistant messages and registers the linked output files.
  const files = [
    ['outputs/logs/metrics.txt', 'accuracy=0.95\n'],
    ['outputs/logs/summary.txt', '测试通过\n'],
    ['outputs/notes/details.md', '# 评估明细\n'],
  ];
  for (const [path, contents] of files) {
    const full = join(bridge, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, contents);
  }

  await trace.step('5.3 发送「整理评估产物」，等待后端返回三个可下载文件', async () => {
    await ctx.start(codex, '整理评估产物');
    await ctx.finish(codex, files.map(([path]) => `[${path}](${pathToFileURL(join(bridge, path)).href})`).join('\n'));
    await ctx.tick();
    const registered = await ctx.runtime.core.listArtifacts(codex.sessionId, { limit: 20 });
    trace.check('生产 ArtifactRegistry 通过最终回答中的文件链接登记了全部产物', () => {
      for (const [path] of files) {
        assert.ok(registered.items.some(item => item.relativePath === path), `缺少 ${path}`);
      }
    });
  });

  let tree;
  await trace.step('5.3 发送「/file」查看跨子目录产物', async () => {
    await ctx.send(codex, '/file');
    await ctx.settle();
    tree = cardWith(ctx, codex, '文件');
    trace.check('目录树包含分支和三个产物的下载操作', () => {
      assert.match(tree.card.bodyText, /├──/);
      assert.match(tree.card.bodyText, /└──/);
      for (const [path] of files) {
        const name = path.split('/').at(-1);
        assert.ok(tree.card.bodyText.includes(name), `树中缺少 ${name}`);
        assert.ok(tree.card.buttons.some(({ label, value }) => value?.action === 'file' && label.includes(name)));
      }
    });
  });

  await trace.step('5.3 点击 metrics.txt 下载按钮，再点击一次定位原文件', async () => {
    const before = ctx.wire.uploads.size;
    const button = tree.card.buttons.find(({ label }) => label.endsWith('metrics.txt'));
    await ctx.click(tree, button.label);
    await ctx.settle();
    await ctx.click(tree, button.label);
    await ctx.settle();
    const located = cardWith(ctx, codex, '文件已发送');
    trace.check('下载精确原文，重复点击提供定位链接且没有重复上传', () => {
      assertUpload(ctx, codex, before, 'metrics.txt', Buffer.from(files[0][1]));
      assert.ok(located.card.buttons.some(({ label, url }) => label === '定位原文件消息' && url));
    });
  });
}

async function historyAndNotices(ctx) {
  const { trace, topics: { codex } } = ctx;
  const marker = index => `检查记录 JOURNEY-HISTORY-${String(index).padStart(2, '0')}`;
  let history;
  await trace.step('5.4 发送「列出需要回查的记录」，后端在一轮中依次返回 22 条记录', async () => {
    await ctx.start(codex, '列出需要回查的记录');
    for (let i = 1; i <= 22; i++) {
      ctx.emitText(codex, marker(i), { final: true, messageId: `journey-history-${i}` });
    }
    await ctx.finish(codex);
    const messages = ctx.runtime.store.snapshot(codex.sessionId).value.messages;
    trace.check('测试用的 22 条原生消息进入真实会话历史', () => {
      assert.equal(messages.filter(message =>
        message.blocks.some(block => block.type === 'text' && block.text.includes('JOURNEY-HISTORY-'))).length, 22);
    });
  });

  await trace.step('5.4 发送「/history」查看第一页', async () => {
    await ctx.send(codex, '/history');
    await ctx.settle();
    history = cardWith(ctx, codex, '会话历史');
    trace.check('首页包含会话内容与下一页按钮', () => {
      assert.match(history.card.bodyText, /assistant:|user:/);
      assert.ok(history.card.buttons.some(({ label }) => label === '下一页'));
    });
  });

  await trace.step('5.4 点击「下一页」', async () => {
    await ctx.click(history, '下一页');
    await ctx.settle();
    const next = cardWith(ctx, codex, '会话历史');
    trace.check('翻页原地更新同一张卡，返回不同的历史内容', () => {
      assert.equal(next.id, history.id);
      assert.equal(next.method, 'im.message.patch');
      assert.notEqual(next.card.bodyText, history.card.bodyText);
      assert.match(next.card.bodyText, /JOURNEY-HISTORY-/);
    });
  });

  await trace.step('5.4 发送「/export」导出历史', async () => {
    const before = ctx.wire.uploads.size;
    await ctx.send(codex, '/export');
    await ctx.settle();
    trace.check('会话历史 Markdown 上载到当前话题，并含分页前后的记录', () => {
      const contents = [...ctx.wire.uploads.values()][before]?.content;
      assert.ok(contents, '缺少导出文件');
      assertUpload(ctx, codex, before, '会话历史.md', contents);
      const markdown = contents.toString('utf8');
      assert.match(markdown, /## assistant \(/);
      assert.ok(markdown.includes(marker(1)));
      assert.ok(markdown.includes(marker(22)));
    });
  });

  let panel;
  await trace.step('5.5 发送「/status」查看会话状态及通知开关', async () => {
    await ctx.send(codex, '/status');
    await ctx.settle();
    panel = cardWith(ctx, codex, '会话控制');
    trace.check('面板显示中文状态及完成、等待、失败设置，无内部修订号或能力枚举', () => {
      assert.match(panel.card.bodyText, /通知：开启（完成：开 · 等待：开 · 失败：开）/);
      assert.doesNotMatch(panel.card.bodyText, /\brev\s*=|\bavailable\b|\bunsupported\b/i);
      assert.equal(action(panel, 'notice_settings', 'waiting').label, '关闭等待提醒');
    });
  });

  await trace.step('5.5 点击「关闭等待提醒」，随后重开状态面板确认', async () => {
    const callback = await ctx.click(panel, '关闭等待提醒');
    await ctx.settle();
    const notice = cardWith(ctx, codex, '会话控制');
    trace.check('开关更新当前控制面板，并保留会话操作', () => {
      assert.equal(notice.id, panel.id);
      assert.equal(notice.method, 'im.message.patch');
      assert.ok(!ctx.writes(codex).some(({card}) => card.title === '通知设置'));
    });
    await ctx.send(codex, '/status');
    await ctx.settle();
    const updated = cardWith(ctx, codex, '会话控制');
    trace.check('原面板和新面板均显示等待提醒已关闭，其他选项仍开启', () => {
      assert.deepEqual(callback.result, { toast: { type: 'success', content: '已确认' } });
      for (const message of [notice, updated]) {
        assert.match(message.card.bodyText, /通知：开启（完成：开 · 等待：关 · 失败：开）/);
        assert.equal(action(message, 'notice_settings', 'waiting').label, '开启等待提醒');
      }
    });
  });

  await trace.step('5.5 点击「开启等待提醒」恢复此话题的通知设置', async () => {
    const current = ctx.cards(codex).findLast(({ card }) => card?.title === '会话控制');
    await ctx.click(current, '开启等待提醒');
    await ctx.settle();
    const notice = cardWith(ctx, codex, '会话控制');
    trace.check('等待提醒可以恢复', () => {
      assert.equal(notice.id, current.id);
      assert.equal(notice.method, 'im.message.patch');
      assert.match(notice.card.bodyText, /等待：开/);
    });
  });
}

async function attachments(ctx) {
  const { trace, sdk, topics: { codex }, providers: { codex: provider } } = ctx;
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jx1sAAAAASUVORK5CYII=',
    'base64',
  );
  const logs = Buffer.from('启动时出错：配置缺少 projectRoot\nTypeError: Invalid configuration\n');
  const pdf = Buffer.from('%PDF-1.4\n% journey fixture\n%%EOF\n');

  async function verifiedAttachment(name, type, mediaType, bytes, reply) {
    const count = provider.inputs.length;
    await ctx.attach(codex, { name, type, mediaType, bytes });
    await ctx.tick();
    trace.check('真实 SDK 资源下载、持久化与派发保留文件类型和字节', () => {
      assert.equal(provider.inputs.length, count + 1);
      const blocks = provider.inputs[count].blocks;
      assert.equal(blocks.length, 1);
      assert.equal(blocks[0].type, 'artifact');
      assert.equal(blocks[0].mediaType, mediaType);
      assert.equal(blocks[0].name, name);
      assert.deepEqual(Buffer.from(blocks[0].content), bytes);
    });
    await ctx.finish(codex, reply);
    const rendered = await waitForCard(ctx, codex, card => card.bodyText.includes(reply));
    trace.check('附件交给后端后，该轮答复发回话题', () => assert.ok(rendered));
  }

  await trace.stage(6, '日常发截图、文本附件与不支持格式反馈', async () => {
    await trace.step('6.1 在 Codex 话题发送 PNG 截图', async () => {
      await verifiedAttachment('image.png', 'image', 'image/png', png, '已收到报错截图。');
    });

    await trace.step('6.1 紧接截图发送「帮我分析上面这张报错截图」', async () => {
      const turn = await ctx.start(codex, '帮我分析上面这张报错截图');
      await ctx.finish(codex, '建议先核对启动目录与配置文件。');
      const answer = await waitForCard(ctx, codex, card => card.bodyText.includes('建议先核对启动目录与配置文件。'));
      trace.check('截图后的普通追问能完成并显示答复', () => {
        assertTurn(ctx, codex, turn.turnId, 'completed');
        assert.ok(answer);
      });
    });

    await trace.step('6.2 在 Codex 话题上传「error_trace.txt」', async () => {
      await verifiedAttachment('error_trace.txt', 'file', 'text/plain', logs, '文本日志提示配置缺少 projectRoot。');
    });

    await trace.step('6.3 在 Codex 话题上传不支持的「paper.pdf」', async () => {
      const count = provider.inputs.length;
      const prior = new Set(sdk.resourceIssues().map(issue => issue.eventId));
      const { replay } = await ctx.attach(codex, { name: 'paper.pdf', type: 'file', mediaType: 'application/pdf', bytes: pdf });
      await ctx.tick();
      await replay();
      await ctx.tick();
      const newIssues = sdk.resourceIssues().filter(issue => !prior.has(issue.eventId));
      trace.check('不支持的附件进入 SDK 拒绝记录且未到达后端', () => {
        assert.deepEqual(newIssues.map(({ state, reason }) => ({ state, reason })), [
          { state: 'rejected', reason: 'unsupported' },
        ]);
        assert.equal(provider.inputs.length, count);
      });
      trace.check('带文件名和 MIME 的 PDF 在事件重放后仍只收到一次格式提示', () => {
        const notices = ctx.writes(codex).filter(({ card }) => card.title === '附件未提交');
        assert.equal(notices.length, 1);
        assert.equal(notices[0].card.bodyText, '仅支持图片（PNG/JPG/GIF/WebP）和 UTF-8 文本文件（.txt）。');
      });
      trace.observe('SDK 资源问题记录包含本次格式拒绝。', newIssues);
    });

    await trace.step('6.4 模拟飞书缺少文件名与 MIME 的 PDF 事件并重放', async () => {
      const count = provider.inputs.length;
      const before = ctx.wire.calls.filter(call => call.method === 'im.messageResource.get').length;
      const { replay } = await ctx.attach(codex, { type: 'file', bytes: pdf });
      await ctx.tick();
      await replay();
      await ctx.tick();
      const db = new DatabaseSync(ctx.sdkDbPath, { readOnly: true });
      let rejected;
      try {
        rejected = db.prepare('SELECT event_id, state, attempts, reason FROM sdk_resource_failures ORDER BY rowid DESC LIMIT 1').get();
      } finally {
        db.close();
      }
      trace.check('拒绝记录写入台账，话题仅收到一次格式提示', () => {
        assert.equal(rejected?.state, 'rejected');
        assert.equal(rejected?.attempts, 1);
        assert.equal(rejected?.reason, 'unsupported resource type');
        assert.equal(provider.inputs.length, count);
        assert.equal(ctx.wire.calls.filter(call => call.method === 'im.messageResource.get').length, before + 1);
        const notices = ctx.writes(codex).filter(({ card }) => card.title === '附件未提交');
        assert.equal(notices.length, 1);
        assert.equal(notices[0].card.bodyText, '仅支持图片（PNG/JPG/GIF/WebP）和 UTF-8 文本文件（.txt）。');
      });
    });
    await trace.step('6.5 在有资源拒绝记录时查看 /health', async () => {
      await ctx.send(null, '/health');
      await ctx.settle();
      const health = cardWith(ctx, null, '健康状态');
      trace.check('异常健康卡使用橙色，并提供待核对操作入口', () => {
        assert.equal(health.card.template, 'orange');
        assert.equal(action(health, 'pending').label, '查看待核对操作');
      });
    });
  });
}

export async function daily(ctx) {
  await busyTurn(ctx);
  await ctx.trace.stage(5, '日常话题工具箱全覆盖', async () => {
    await models(ctx);
    await projectFiles(ctx);
    await artifacts(ctx);
    await historyAndNotices(ctx);
  });
  await attachments(ctx);
}
