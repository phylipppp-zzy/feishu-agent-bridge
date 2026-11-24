import assert from 'node:assert/strict';
import { DecisionSyncStore } from '../../src/unified/decision-sync.js';
import { TaskHandoffService } from '../../src/unified/task-handoff.js';
import { TaskTopicChannel } from '../../src/unified/task-topic-channel.js';
import { WatchHub } from '../../src/unified/watch-hub.js';

const confirmed = { type: 'success', content: '已确认' };
const hasAction = (action, value = {}) => (button) =>
  button.value?.action === action &&
  Object.entries(value).every(([key, expected]) => button.value[key] === expected);

export async function tasks(ctx) {
  const { trace, runtime, sdk, providers, wire } = ctx;
  const { agy, codex } = ctx.topics;
  const taskChannel = runtime.taskChannel;
  const handoffService = runtime.taskHandoff;
  const watchHub = runtime.watchHub;
  const decisions = runtime.decisionSync;
  const taskTitle = '跨后端联合攻关';
  let binding, topic, taskUrl, agyTarget, codexTarget, panel, preview;
  let decisionCard;

  await trace.stage(12, '跨后端任务话题接力与看守、决策联动', async () => {
    await trace.step(`主群发送 /task ${taskTitle}`, async () => {
      await ctx.send(null, `/task ${taskTitle}`);
      await ctx.settle();

      trace.check('运行时启用了真实的任务、交接、看守和决策服务', () => {
        assert.ok(taskChannel instanceof TaskTopicChannel);
        assert.ok(handoffService instanceof TaskHandoffService);
        assert.ok(watchHub instanceof WatchHub);
        assert.ok(decisions instanceof DecisionSyncStore);
      });
      [binding] = taskChannel.listActiveBindings();
      trace.check('创建一个有独立根消息的任务话题', () => {
        assert.equal(taskChannel.listActiveBindings().length, 1);
        assert.equal(binding.state, 'active');
        assert.equal(binding.activeTargetId, null);
      });
      const token = sdk.lookupTaskTopic(binding.destination, ctx.config.ownerOpenId);
      taskUrl = await sdk.topicLinkForTask(ctx.config.allowedDestinations[0], binding.taskId);
      const created = ctx.cards(null).findLast((message) => message.card.title === '任务话题已创建');
      trace.check('主群创建回执含标题和可跳转到新话题的按钮', () => {
        assert.equal(token?.taskId, binding.taskId);
        assert.ok(taskUrl?.startsWith('https://applink.feishu.cn/'));
        assert.ok(created?.card.bodyText.includes(taskTitle));
        assert.equal(created.card.buttons.find((button) => button.label === '打开任务话题')?.url, taskUrl);
      });
      topic = ctx.topic(binding.destination, codex.sessionId);
    });

    await trace.step(`任务话题发送 /task mount ${agy.sessionId}`, async () => {
      await ctx.send(topic, `/task mount ${agy.sessionId}`);
      await ctx.settle();
      [agyTarget] = taskChannel.listTargets(binding.taskId);
      trace.check('首个交互目标 Antigravity 自动成为当前输入目标', () => {
        assert.equal(agyTarget?.native.provider, 'agy');
        assert.equal(agyTarget.sessionId, agy.sessionId);
        assert.equal(agyTarget.accessMode, 'interactive');
        assert.equal(taskChannel.getBinding(binding.taskId).activeTargetId, agyTarget.targetId);
      });
    });

    await trace.step(`任务话题发送 /task mount ${codex.sessionId}`, async () => {
      await ctx.send(topic, `/task mount ${codex.sessionId}`);
      await ctx.settle();
      const targets = taskChannel.listTargets(binding.taskId);
      codexTarget = targets.find((target) => target.native.provider === 'codex');
      trace.check('任务话题挂载两个可交互目标，当前输入仍指向 Antigravity', () => {
        assert.equal(targets.length, 2);
        assert.equal(codexTarget?.sessionId, codex.sessionId);
        assert.equal(codexTarget.accessMode, 'interactive');
        assert.equal(taskChannel.getBinding(binding.taskId).activeTargetId, agyTarget.targetId);
      });
    });

    await trace.step('任务话题发送 /task 查看已挂载目标', async () => {
      await ctx.send(topic, '/task');
      await ctx.settle();
      panel = ctx.cards(topic).findLast((message) => message.card.title === '任务目标面板');
      trace.check('面板显示中文目标状态、切换按钮，正文没有原始版本计数', () => {
        assert.ok(panel);
        assert.match(panel.card.bodyText, /当前输入目标\s*[:：]\s*Antigravity/);
        assert.match(panel.card.bodyText, /【已挂载】 Codex.*可交互/);
        assert.doesNotMatch(panel.card.bodyText, /\brev\s*=|\bactiveRevision\b|\brootGeneration\b/);
        assert.ok(panel.card.buttons.some(hasAction('switch_target', { targetId: codexTarget.targetId })));
      });
    });

    await trace.step('点击任务面板的「切换到 Codex」', async () => {
      const { result } = await ctx.click(panel, hasAction('switch_target', { targetId: codexTarget.targetId }));
      await ctx.settle();
      const switched = ctx.cards(topic).findLast((message) => message.card.title === '任务目标面板');
      trace.check('切换返回「已确认」并把当前输入目标更新为 Codex', () => {
        assert.deepEqual(result?.toast, confirmed);
        assert.equal(taskChannel.getBinding(binding.taskId).activeTargetId, codexTarget.targetId);
        assert.match(switched?.card.bodyText, /当前输入目标\s*[:：]\s*Codex/);
      });
      trace.observe('切换后显示的面板消息', { before: panel.id, after: switched.id });
    });

    await trace.step(`任务话题发送 /handoff ${agyTarget.targetId} 预览交接`, async () => {
      const before = providers.agy.inputs.length;
      await ctx.send(topic, `/handoff ${agyTarget.targetId}`);
      await ctx.settle();
      preview = ctx.cards(topic).findLast((message) => message.card.title.includes('跨后端交接预览'));
      trace.check('预览显示来源、目标、摘要和确认按钮，点击前没有提交模型输入', () => {
        assert.ok(preview);
        assert.match(preview.card.title, /Codex → Antigravity/);
        assert.match(preview.card.bodyText, /目标工作目录[\s\S]*摘要/);
        assert.ok(preview.card.buttons.some(hasAction('confirm_handoff')));
        assert.equal(providers.agy.inputs.length, before);
      });
    });

    await trace.step('点击交接预览中的「确认交接到 Antigravity」', async () => {
      const confirmAction = hasAction('confirm_handoff');
      const handoffId = preview.card.buttons.find(confirmAction).value.handoffId;
      const before = providers.agy.inputs.length;
      const { result } = await ctx.click(preview, confirmAction);
      await ctx.tick();
      await ctx.settle();
      trace.check('交接仅提交一次，结构化摘要到达 Antigravity，任务输入目标保持 Codex', () => {
        assert.deepEqual(result?.toast, confirmed);
        assert.equal(handoffService.getHandoff(handoffId).status, 'submitted');
        assert.equal(providers.agy.inputs.length, before + 1);
        const input = providers.agy.inputs.at(-1);
        assert.deepEqual(input.ref, agy.ref);
        assert.match(input.text, /显式任务交接摘要[\s\S]*交接摘要[\s\S]*从 Codex .*交接到 Antigravity/);
        assert.equal(taskChannel.getBinding(binding.taskId).activeTargetId, codexTarget.targetId);
      });
      const shown = wire.messages.get(preview.id);
      trace.observe('确认交接后，原预览卡上仍可见的按钮', shown.card.buttons.map((button) => button.label));
      await ctx.finish(agy, '已收到交接摘要，Antigravity 可以接续验证。');
    });

    await trace.step('用户留在任务话题发送「请继续验证这次交接」并等待回复', async () => {
      const prompt = '请继续验证这次交接';
      const reply = 'Codex 已验证交接记录，下一步检查实验产物。';
      const agyInputCount = providers.agy.inputs.length;
      await ctx.start(topic, prompt);
      await ctx.finish(topic, reply);
      trace.check('当前目标 Codex 收到任务话题输入，并在相同根消息下回复', () => {
        const input = providers.codex.inputs.at(-1);
        assert.deepEqual(input.ref, codex.ref);
        assert.equal(input.text, prompt);
        assert.equal(providers.agy.inputs.length, agyInputCount);
        assert.ok(ctx.cards(topic).some((message) =>
          message.rootId === topic.rootId &&
          message.card.title.startsWith('Codex · 回复') &&
          message.card.bodyText.includes(reply)));
      });
    });

    await trace.step('看守检测到任务需要检查并发送一条运行提醒', async () => {
      const result = await watchHub.publish({
        eventId: 'journey-task-watch-alert',
        objectId: 'journey-task-check',
        source: 'watch',
        state: 'alert',
        severity: 'high',
        occurredAt: new Date().toISOString(),
        title: '跨后端验证需要检查',
        summary: '任务的两个目标已经挂载，请回到任务话题核对交接。',
        sourceRef: { taskId: binding.taskId, destination: topic.destination },
      });
      const watchMessageId = result.deliveries[0]?.messageId;
      const watchRoot = watchHub.getRoot();
      const alert = wire.messages.get(watchMessageId);
      trace.check('看守提醒投递到看守话题，并带有同一个任务话题的回跳链接', () => {
        assert.equal(result.ingest.status, 'accepted');
        assert.equal(result.deliveries.length, 1);
        assert.equal(result.deliveries[0].status, 'sent');
        assert.equal(watchRoot.state, 'active');
        assert.ok(alert?.card.title.includes('跨后端验证需要检查'));
        assert.equal(alert.rootId, watchRoot.rootMessageId);
        assert.equal(alert.card.buttons.find((button) => button.label === '返回任务话题')?.url, taskUrl);
      });
    });

    const decisionId = 'D1';
    const decisionTitle = '确定跨后端验证顺序';
    await trace.step('计划器登记决策，用户在待处理话题查看「确定跨后端验证顺序」', async () => {
      decisions.createDecision({
        decisionId,
        kind: 'business_decision',
        title: decisionTitle,
        prompt: '先验证 Codex 还是 Antigravity 的实验产物？',
        options: [
          { id: 'c', label: '先验证 Codex' },
          { id: 'a', label: '先验证 Antigravity' },
        ],
        source: { system: 'journey-planner', sessionId: codex.sessionId, destination: topic.destination },
      });
      await ctx.tick();
      const ref = runtime.pendingHub.getRef(`decision:${decisionId}`);
      const pendingRoot = runtime.pendingHub.getRoot();
      decisionCard = wire.messages.get(ref?.hub_card_message_id);
      trace.check('待处理话题展示真实决策卡及两个回答选项', () => {
        assert.equal(pendingRoot.state, 'active');
        assert.equal(decisions.getDecision(decisionId).status, 'pending');
        assert.ok(decisionCard?.card.title.includes(decisionTitle));
        assert.equal(decisionCard.rootId, pendingRoot.rootMessageId);
        for (const selectedOptionId of ['c', 'a']) {
          assert.ok(decisionCard.card.buttons.some(hasAction('decision_answer', { decisionId, selectedOptionId })));
        }
      });
    });

    await trace.step('在待处理话题点击决策卡中的「先验证 Codex」', async () => {
      const { result } = await ctx.click(decisionCard, hasAction('decision_answer', {
        decisionId,
        selectedOptionId: 'c',
      }));
      await ctx.tick();
      await ctx.settle();
      trace.check('决策返回「已确认」，SQLite 中的回答与点击选项一致，待处理项撤下', () => {
        assert.deepEqual(result?.toast, confirmed);
        assert.equal(decisions.getDecision(decisionId).status, 'answered');
        const answers = decisions.getAnswers(decisionId);
        assert.equal(answers.length, 1);
        assert.equal(answers[0].selectedOptionId, 'c');
        assert.equal(answers[0].selectedLabel, '先验证 Codex');
        assert.equal(runtime.pendingHub.getRef(`decision:${decisionId}`)?.card_active, 0);
        assert.ok(!wire.messages.get(decisionCard.id).card.buttons.some(hasAction('decision_answer')));
      });
    });
  });
}
