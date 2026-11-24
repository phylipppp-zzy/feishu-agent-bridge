import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

function completionCard(ctx, topic, pattern = /已完成/) {
  const message = ctx.writes(topic).findLast(({ card }) => pattern.test(card.title));
  assert.ok(message, `未收到${pattern}卡片`);
  return message;
}

function visibleWrites(ctx, topic, type) {
  return ctx.wire.calls.slice(ctx.trace.currentStep.callIndex).filter(({ response, message }) =>
    response?.code === 0 && message && (message.id === topic.rootId || message.rootId === topic.rootId) &&
    (!type || message.type === type)).map(({ message }) => message);
}

async function waitForPatchWindow(ctx, topic) {
  const previous = ctx.cards(topic).findLast(({ card }) => /进行中/.test(card.title));
  if (!previous) return;
  // This wait is real wall time and remains visible in the step latency.
  const wait = Date.parse(previous.updatedAt) + 1510 - Date.now();
  if (wait > 0) await delay(wait);
  await ctx.tick();
}

function reportFixture(file) {
  const head = `# 核心结论\n[评估报告](${pathToFileURL(file).href}) [来源会话](conversation://journey/10)\n\n`;
  const tail = '\n\nFINAL_TAIL_MARKER_99';
  const paragraph = '边界样本通过验证，建议继续检查长回复和文件投递。\n';
  const middle = paragraph.repeat(250).slice(0, 4200 - head.length - tail.length);
  return {
    raw: head + middle + tail,
    display: '# 核心结论\n`评估报告` `来源会话`\n\n' + middle + tail,
  };
}

function ultraLongFixture() {
  const head = 'HEAD_ANCHOR\n\n```text\n';
  const tail = '\n```\n\nTAIL_ANCHOR';
  const bytesLeft = 26_000 - Buffer.byteLength(head + tail);
  return head + '中文'.repeat(Math.floor(bytesLeft / 6)) + 'x'.repeat(bytesLeft % 6) + tail;
}

function assertFileDelivery(ctx, topic, namePattern, content, mark) {
  const uploads = [...ctx.wire.uploads.entries()].slice(mark);
  assert.equal(uploads.length, 1);
  const [[fileKey, upload]] = uploads;
  assert.match(upload.name, namePattern);
  assert.deepEqual(upload.content, Buffer.from(content));
  assert.ok(ctx.wire.messages.has(topic.rootId), '文件投递话题根消息不存在');
  assert.ok([...ctx.wire.messages.values()].some(message => message.rootId === topic.rootId &&
    message.type === 'file' && JSON.parse(message.content).file_key === fileKey), '飞书话题未收到对应的文件消息');
}

async function longReplies(ctx) {
  const { trace, topics: { codex, claude }, providers, wire } = ctx;
  await trace.stage(10, '多段聚合、长文完整渲染、文件直发、120 秒锁屏提醒与限流容错', async () => {
    await trace.step('10.1 请求分三次报告实验进展，期间穿插两次工具步骤', async () => {
      await ctx.start(codex, '请分阶段汇报实验进展');
      const parts = ['先核对数据来源。', '再分析失败样本。', '最后补充回归结论。'];
      for (const [index, text] of parts.entries()) {
        ctx.emitText(codex, text, { messageId: `journey-aggregation-${index}`, final: true });
        if (index < parts.length - 1) {
          providers.codex.event(codex.ref, 'tool.updated', {
            turnId: ctx.turn(codex).turnId, callId: `aggregation-tool-${index}`,
            tool: 'Read', phase: 'succeeded', summary: `Read · 实验记录 ${index + 1}`,
          });
        }
        await ctx.settle();
      }
      await ctx.finish(codex);
      await waitForPatchWindow(ctx, codex);
      trace.check('完成卡按原顺序保留三段回复和段落空行', () => {
        const { card } = completionCard(ctx, codex);
        assert.equal(card.template, 'green');
        assert.equal(card.raw.body.elements[0].content, parts.join('\n\n'));
      });
    });

    let longCard;
    const reportPath = join(ctx.projects.bridge, 'outputs', 'eval_report.md');
    const report = reportFixture(reportPath);
    const reportContents = '# 评估报告\n\n已验证长文、中文与文件投递。\n';
    await trace.step('10.2 请求输出 4200 字符 Markdown 报告，保留首尾并收集关联文件', async () => {
      // Stage 5 has already delivered the original version. A newly generated report
      // makes this a separate delivery and exercises the real registry's versioning.
      writeFileSync(reportPath, reportContents);
      await ctx.start(codex, '给我完整的实验评估报告，并附上评估文件');
      ctx.emitText(codex, report.raw, { final: true });
      await ctx.tick();
      await ctx.finish(codex);
      await waitForPatchWindow(ctx, codex);
      longCard = completionCard(ctx, codex);
      trace.check('4200 字符全文可见，仅本地链接的显示形式被改写', () => {
        assert.equal(report.raw.length, 4200);
        assert.ok(longCard.card.wireBytes >= 12_000 && longCard.card.wireBytes <= 15_000);
        const body = longCard.card.raw.body.elements[0].content;
        assert.equal(body, report.display);
        assert.match(body, /^# 核心结论\n/);
        assert.match(body, /FINAL_TAIL_MARKER_99$/);
        assert.doesNotMatch(body, /(?:file|conversation):\/\//);
        assert.ok(longCard.card.buttons.some(button => button.label === '发送文件：eval_report.md'));
      });
    });
    await trace.step('10.2 点击「发送文件：eval_report.md」一次', async () => {
      const mark = wire.uploads.size;
      await ctx.click(longCard, '发送文件：eval_report.md');
      await ctx.tick();
      trace.check('按钮上传当前报告的精确字节并在原话题发送文件消息', () => {
        assertFileDelivery(ctx, codex, /^eval_report\.md$/, reportContents, mark);
      });
    });

    const ultra = ultraLongFixture();
    let ultraCard;
    await trace.step('10.3 请求显示包含代码围栏的 26000 字节长文', async () => {
      await ctx.start(codex, '展开全部诊断记录，包括代码块');
      await ctx.finish(codex, ultra);
      await waitForPatchWindow(ctx, codex);
      ultraCard = completionCard(ctx, codex);
      trace.check('预览符合线协议，保留首尾，且省略提示位于成对围栏之外', () => {
        assert.equal(Buffer.byteLength(ultra), 26_000);
        assert.ok(Buffer.byteLength(ultraCard.content) < 30_000);
        const body = ultraCard.card.raw.body.elements[0].content;
        assert.match(body, /^HEAD_ANCHOR/);
        assert.match(body, /TAIL_ANCHOR$/);
        assert.match(body, /\n```\n\n> .*已省略[^\n]*\n\n```\n/);
        assert.equal(body.match(/^```/gm)?.length, 4);
      });
    });
    await trace.step('10.3 点击「发送完整正文 (.txt)」', async () => {
      const mark = wire.uploads.size;
      await ctx.click(ultraCard, '发送完整正文 (.txt)');
      await ctx.tick();
      trace.check('全文附件逐字节匹配未裁剪的 UTF-8 原稿', () => {
        assertFileDelivery(ctx, codex, /^完整正文-.+\.txt$/, ultra, mark);
      });
    });

    let progressCard;
    let failureOffset;
    const streamMessageId = 'journey-feishu-fault-recovery';
    const finalText = '## 限流后仍然完整\n\n- **第一项**\n- 第二项\n\nFAULT_RECOVERY_TAIL';
    await trace.step('10.4 启动流式回复并收到进行中卡片', async () => {
      await ctx.start(codex, '输出验证报告，模拟飞书限流');
      ctx.emitText(codex, '正在整理验证报告……', { messageId: streamMessageId });
      await ctx.settle();
      progressCard = completionCard(ctx, codex, /进行中/);
      trace.check('开始时发送 Schema 2.0 进行中卡片', () => {
        assert.equal(progressCard.card.schema, '2.0');
        assert.equal(progressCard.card.template, 'blue');
      });
    });
    await trace.step('10.4 完成回复时注入 PATCH 限流 230429', async () => {
      await waitForPatchWindow(ctx, codex);
      failureOffset = wire.calls.length;
      wire.fault('im.message.patch', 230429);
      ctx.emitText(codex, finalText, { messageId: streamMessageId, final: true });
      await ctx.finish(codex);
      trace.check('限流后的进行中卡片保留，终态等待重试', () => {
        assert.match(wire.messages.get(progressCard.id).card.title, /进行中/);
        assert.ok(!ctx.writes(codex).some(({ card }) => /已完成/.test(card?.title ?? '')));
      });
    });
    await trace.step('10.4 等待 3 秒退避，重试 PATCH 时注入 230099', async () => {
      wire.fault('im.message.patch', 230099);
      await delay(3050);
      await ctx.tick();
      trace.check('两次 API 拒绝后原卡片以纯文本更新，完整正文和终态均保留', () => {
        const attempts = wire.calls.slice(failureOffset).filter(call =>
          call.method === 'im.message.patch' && call.message?.id === progressCard.id);
        assert.deepEqual(attempts.map(call => call.response?.code), [230429, 230099, 0]);
        const write = wire.messages.get(progressCard.id);
        assert.equal(write.id, progressCard.id);
        assert.match(write.card.title, /已完成/);
        assert.equal(write.card.template, 'green');
        const block = write.card.raw.body.elements[0];
        assert.equal(block.tag, 'div');
        assert.equal(block.text.tag, 'plain_text');
        assert.equal(block.text.content, finalText);
      });
    });

    await trace.step('10.5 Claude 话题请求短摘要，供应商用时 12 秒', async () => {
      await ctx.start(claude, '简要总结检查结果');
      const turn = await ctx.finish(claude, '短任务已经完成。', { durationMs: 12_000 });
      trace.observe('用适配层的起止时间模拟运行时长，步骤耗时按真实墙钟测量。',
        { startedAt: turn.startedAt, endedAt: turn.endedAt });
      await waitForPatchWindow(ctx, claude);
      trace.check('12 秒回复为绿色完成卡，话题内无额外文本通知', () => {
        const { card } = completionCard(ctx, claude);
        assert.match(card.title, /用时 12秒/);
        assert.equal(card.template, 'green');
        assert.equal(visibleWrites(ctx, claude, 'text').length, 0);
      });
    });
    await trace.step('10.5 Claude 话题请求详细摘要，供应商用时 150 秒且首行超 80 字', async () => {
      const firstLine = '实验检查结果全部通过，'.repeat(12) + '可继续复测。';
      await ctx.start(claude, '总结较长的验证任务');
      const turn = await ctx.finish(claude, `# ${firstLine}\n\n附录。`, { durationMs: 150_000 });
      trace.observe('用适配层的起止时间模拟运行时长，步骤耗时按真实墙钟测量。',
        { startedAt: turn.startedAt, endedAt: turn.endedAt });
      await waitForPatchWindow(ctx, claude);
      await ctx.tick();
      trace.check('150 秒回复只发送一条文本通知，摘要恰到 79 字后接单省略号', () => {
        assert.match(completionCard(ctx, claude).card.title, /用时 2分30秒/);
        const pushes = visibleWrites(ctx, claude, 'text');
        assert.equal(pushes.length, 1);
        assert.equal(JSON.parse(pushes[0].content).text,
          `✅ 本轮已完成（用时 2分30秒）· ${[...firstLine].slice(0, 79).join('')}…`);
      });
    });
  });
}

async function isolatedSessions(ctx) {
  const { trace, topics: { codex, agy }, providers, runtime, wire } = ctx;
  await trace.stage(11, '会话隔离、筛选搜索、一键接入电脑会话、归档解绑与异常通知', async () => {
    await trace.step('11.1 在 Codex 与 Antigravity 两个话题同时发起任务', async () => {
      await Promise.all([
        ctx.send(codex, '请整理独立的代码结论'),
        ctx.send(agy, '请整理独立的实验结论'),
      ]);
      await ctx.settle();
      await trace.check('两个独立会话同时运行，各自只有自己的当前轮次', async () => {
        const [codeState, agyState] = await Promise.all([
          runtime.core.getWorkState(codex.sessionId), runtime.core.getWorkState(agy.sessionId),
        ]);
        assert.equal(codeState.runningTurns.length, 1);
        assert.equal(agyState.runningTurns.length, 1);
        assert.notEqual(codeState.runningTurns[0].turnId, agyState.runningTurns[0].turnId);
      });
    });
    await trace.step('11.1 同时接收两条带独立标记的回复', async () => {
      const codeText = 'CODEX_TOPIC_ONLY · 代码分析已完成';
      const agyText = 'AGY_TOPIC_ONLY · 实验分析已完成';
      await Promise.all([ctx.finish(codex, codeText), ctx.finish(agy, agyText)]);
      await waitForPatchWindow(ctx, codex);
      await waitForPatchWindow(ctx, agy);
      trace.check('两个完成卡分别发往正确根消息，跨话题写入次数为零', () => {
        assert.equal(completionCard(ctx, codex).card.bodyText, codeText);
        assert.equal(completionCard(ctx, agy).card.bodyText, agyText);
        assert.equal(ctx.writes(codex).filter(write => write.content.includes('AGY_TOPIC_ONLY')).length, 0);
        assert.equal(ctx.writes(agy).filter(write => write.content.includes('CODEX_TOPIC_ONLY')).length, 0);
        const allMessages = [...wire.messages.values()];
        assert.ok(allMessages.filter(message => message.content.includes('CODEX_TOPIC_ONLY')).every(message => message.rootId === codex.rootId));
        assert.ok(allMessages.filter(message => message.content.includes('AGY_TOPIC_ONLY')).every(message => message.rootId === agy.rootId));
      });
    });

    const desktopTitle = '修复 GRPO 奖励函数数值下溢';
    const otherTitle = '整理 GRPO 相关实验';
    let searchCard;
    let filteredCard;
    let desktopTopic;
    let upgradeCard;
    await trace.step('11.2 主群发送 /sessions GRPO 搜索桌面会话', async () => {
      providers.codex.seed({ id: 'desktop-grpo-reward', title: desktopTitle, project: ctx.projects.gui });
      providers.agy.seed({ id: 'desktop-grpo-experiments', title: otherTitle, project: ctx.projects.research });
      await ctx.send(null, '/sessions GRPO');
      await ctx.tick();
      searchCard = completionCard(ctx, null, /^会话列表$/);
      trace.check('关键词命中两个后端的桌面会话，两条结果均可接入', () => {
        assert.ok(searchCard.card.bodyText.includes(desktopTitle));
        assert.ok(searchCard.card.bodyText.includes(otherTitle));
        assert.equal(searchCard.card.buttons.filter(button => button.value?.action === 'bind').length, 2);
      });
    });
    await trace.step('11.2 在搜索结果点击「Codex」筛选', async () => {
      await ctx.click(searchCard, 'Codex');
      await ctx.tick();
      filteredCard = completionCard(ctx, null, /^会话列表$/);
      trace.check('筛选沿用 GRPO 关键词，按后端元数据保留 Codex 会话', () => {
        assert.equal(filteredCard.id, searchCard.id);
        assert.ok(filteredCard.card.bodyText.includes(desktopTitle));
        assert.ok(!filteredCard.card.bodyText.includes(otherTitle));
        assert.equal(filteredCard.card.buttons.filter(button => button.value?.action === 'bind').length, 1);
      });
    });
    await trace.step('11.3 点击 Codex 搜索结果的「接入」进入只读话题', async () => {
      const { value } = filteredCard.card.buttons.find(button => button.value?.action === 'bind');
      await ctx.click(filteredCard, button => button.value?.action === 'bind');
      await ctx.tick();
      const binding = runtime.channel.bindingsForRestore().find(item => item.sessionId === value.sessionId);
      assert.ok(binding, '未创建桌面会话的只读话题');
      desktopTopic = ctx.topic(binding.destination);
      upgradeCard = ctx.cards(desktopTopic).findLast(message => message.card.buttons.some(button => button.value?.action === 'upgrade'));
      trace.check('绑定为 read_only，卡面提供「接入并续聊」按钮和主群跳转链接', () => {
        assert.equal(binding.accessMode, 'read_only');
        assert.ok(upgradeCard);
        assert.ok(upgradeCard.card.buttons.some(button => button.label.includes('接入并续聊')));
        assert.ok(ctx.cards(null).some(message => message.card.buttons.some(button => button.url)));
      });
    });
    await trace.step('11.3 在只读桌面话题点击「接入并续聊」一次', async () => {
      await ctx.click(upgradeCard, button => button.value?.action === 'upgrade');
      await ctx.tick();
      trace.check('更新原卡片，写明可续聊，没有重复发送控制卡', () => {
        assert.equal(runtime.channel.accessMode(desktopTopic.destination), 'interactive');
        const patches = ctx.writes(desktopTopic).filter(write => write.method === 'im.message.patch' && write.id === upgradeCard.id);
        assert.ok(patches.some(({ card }) => card?.bodyText.includes('✅ 已接入，现在可直接发送消息续聊')));
        assert.equal(ctx.writes(desktopTopic).filter(write => write.method !== 'im.message.patch' && write.type === 'interactive').length, 0);
      });
    });
    await trace.step('11.3 接入后立即向原桌面会话发送追问', async () => {
      await ctx.start(desktopTopic, '沿用桌面的 GRPO 上下文，给出修复思路');
      await ctx.finish(desktopTopic, '先改用稳定的对数空间计算。');
      await waitForPatchWindow(ctx, desktopTopic);
      trace.check('追问使用原桌面会话，得到绿色完成卡', () => {
        assert.equal(desktopTopic.ref.nativeSessionId, 'desktop-grpo-reward');
        assert.equal(completionCard(ctx, desktopTopic).card.template, 'green');
      });
    });
    await trace.step('11.3 回主群再次发送 /sessions GRPO，查看已接入的会话', async () => {
      await ctx.send(null, '/sessions GRPO');
      await ctx.tick();
      const listed = completionCard(ctx, null, /^会话列表$/);
      trace.check('已接入项使用「打开」跳转，未接入项保留「接入」', () => {
        assert.ok(listed.card.buttons.some(button => /打开/.test(button.label) && button.url));
        assert.ok(listed.card.buttons.some(button => /接入/.test(button.label) && button.value?.action === 'bind'));
      });
    });

    await trace.step('11.4 发起请求，供应商返回额度接近限制和执行失败', async () => {
      await ctx.start(desktopTopic, '验证额度不足时的提示');
      const { turnId } = ctx.turn(desktopTopic);
      ctx.emitText(desktopTopic, '已开始检查。');
      await ctx.settle();
      providers.codex.event(desktopTopic.ref, 'provider.usage_limit', { status: 'allowed_warning' }, { objectId: turnId });
      await ctx.finish(desktopTopic, undefined, { status: 'failed' });
      await waitForPatchWindow(ctx, desktopTopic);
      trace.check('失败卡为红色，另外收到明确仍可继续的中文额度提示', () => {
        const failed = completionCard(ctx, desktopTopic, /执行失败/);
        const quota = completionCard(ctx, desktopTopic, /^额度提示$/);
        assert.equal(failed.card.template, 'red');
        assert.match(quota.card.bodyText, /额度接近限制，当前仍可继续/);
      });
    });
    await trace.step('11.4 失败后在同一话题发送新消息', async () => {
      await ctx.start(desktopTopic, '请只给出一行可行的结论');
      await ctx.finish(desktopTopic, '请求已恢复，可以继续。');
      await waitForPatchWindow(ctx, desktopTopic);
      trace.check('同一会话可继续执行，回复正常完成', () => {
        assert.equal(completionCard(ctx, desktopTopic).card.bodyText, '请求已恢复，可以继续。');
      });
    });

    let archivePanel;
    await trace.step('11.5 在一次性桌面话题执行 /status 查找归档入口', async () => {
      await ctx.send(desktopTopic, '/status');
      await ctx.tick();
      archivePanel = completionCard(ctx, desktopTopic, /^会话控制$/);
      trace.check('面板包含归档和恢复归档按钮', () => {
        assert.ok(archivePanel.card.buttons.some(button => button.label === '归档'));
        assert.ok(archivePanel.card.buttons.some(button => button.label === '恢复归档'));
      });
    });
    await trace.step('11.5 点击「归档」', async () => {
      const before = providers.codex.archives.length;
      await ctx.click(archivePanel, '归档');
      await ctx.tick();
      trace.check('归档请求进入该桌面会话的供应商适配层一次', () => {
        assert.equal(providers.codex.archives.length, before + 1);
        assert.deepEqual(providers.codex.archives.at(-1), { ref: desktopTopic.ref, archived: true });
      });
    });
    await trace.step('11.5 在一次性话题发送 /unbind', async () => {
      await ctx.send(desktopTopic, '/unbind');
      await ctx.tick();
      trace.check('绑定确实移除，当前界面没有给用户确认消息', () => {
        assert.ok(!runtime.channel.bindingsForRestore().some(binding => binding.destination === desktopTopic.destination));
        assert.equal(visibleWrites(ctx, desktopTopic).length, 0);
      });
      trace.observe('解绑在后台完成，用户没有收到确认卡或文本。');
    });
    await trace.step('11.5 解绑后继续向旧话题发送一条普通消息', async () => {
      const before = providers.codex.inputs.length;
      const beforeUnknown = runtime.channel.unknownInbox();
      await ctx.send(desktopTopic, '解绑后还能继续吗？');
      await trace.check('当前实现将旧话题输入视作后台派发异常', () => {
        return assert.rejects(() => ctx.tick(), /dispatch or synchronization failed/);
      });
      await ctx.tick();
      trace.check('消息未交给后端，旧话题无提示，并在后台留下待核对入站记录', () => {
        assert.equal(providers.codex.inputs.length, before);
        assert.equal(visibleWrites(ctx, desktopTopic).length, 0);
        const newUnknown = runtime.channel.unknownInbox().filter(id => !beforeUnknown.includes(id));
        assert.equal(newUnknown.length, 1);
        assert.match(newUnknown[0], /^message:om_user_/);
      });
      trace.observe('仍能往旧话题发消息。后台留下未确认的入站记录，飞书端保持静默。');
    });
  });
}

export async function replies(ctx) {
  await longReplies(ctx);
  await isolatedSessions(ctx);
}
