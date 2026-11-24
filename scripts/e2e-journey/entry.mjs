import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';

const labels = message => message.card.buttons.map(button => button.label);

function lastCard(ctx, target) {
  const last = ctx.writes(target).at(-1);
  assert.ok(last, '该步骤没有发出卡片');
  return last;
}

function newTopic(ctx, provider) {
  const binding = ctx.runtime.channel.bindingsForRestore().find(candidate =>
    ctx.runtime.store.getSession(candidate.sessionId).native.provider === provider);
  assert.equal(binding?.accessMode, 'interactive', `${provider} 话题应可续聊`);
  return ctx.topic(binding.destination);
}

async function mainChat(ctx) {
  const { trace } = ctx;
  await trace.stage(1, '主群日常入口、帮助健康与误发防迷航', async () => {
    let help;
    await trace.step('1.0 初始化待处理入口与本地调度', async () => {
      await ctx.settle();
    });
    await trace.step('1.1 在主群发送 /help', async () => {
      await ctx.send(null, '/help');
      await ctx.settle();
      help = lastCard(ctx, null);
      trace.check('帮助卡列出主群操作与导航按钮', () => {
        assert.equal(help.card.title, '帮助');
        assert.match(help.card.bodyText, /主群常用入口/);
        assert.deepEqual(labels(help), ['会话列表', '新建会话']);
      });
    });
    await trace.step('1.1 点击帮助卡的「会话列表」', async () => {
      await ctx.click(help, '会话列表');
      await ctx.settle();
      trace.check('按钮打开会话列表', () => assert.match(lastCard(ctx, null).card.title, /会话/));
    });
    await trace.step('1.1 在主群发送 /help admin', async () => {
      await ctx.send(null, '/help admin');
      await ctx.settle();
      trace.check('运维帮助列出 /health、/ops、/unbind 和 /export', () => {
        const { card } = lastCard(ctx, null);
        assert.equal(card.title, '帮助 · 运维管理');
        for (const command of ['/health', '/ops', '/unbind', '/export']) assert.ok(card.bodyText.includes(command));
        assert.deepEqual(card.buttons, []);
      });
    });
    await trace.step('1.2 在主群直接发送「今天跑一下实验」', async () => {
      const before = ctx.wire.calls.length;
      await ctx.send(null, '今天跑一下实验');
      await ctx.settle();
      trace.check('未提及机器人时没有出站调用，也没有模型输入', () => {
        assert.equal(ctx.wire.calls.length, before);
        assert.ok(Object.values(ctx.providers).every(provider => provider.inputs.length === 0));
      });
    });
    await trace.step('1.2 在主群 @bot 发送「今天跑一下实验」', async () => {
      await ctx.send(null, '@bot 今天跑一下实验', { mention: true });
      await ctx.settle();
      trace.check('显示进入话题的引导与两个导航入口', () => {
        const message = lastCard(ctx, null);
        assert.equal(message.card.title, '请选择会话');
        assert.match(message.card.bodyText, /请先选择已有会话或新建会话再发送任务/);
        assert.deepEqual(labels(message), ['会话列表', '新建会话']);
      });
    });
    for (const command of ['/model', '/stop', '/ls', '/file', '/export']) {
      await trace.step(`1.2 在未绑定的主群发送 ${command}`, async () => {
        await ctx.send(null, command);
        await ctx.settle();
        trace.check('显示话题专用命令的引导', () => assert.equal(lastCard(ctx, null).card.title, '请在会话话题中使用'));
      });
    }
    await trace.step('1.3 在主群发送 /health', async () => {
      await ctx.send(null, '/health');
      await ctx.settle();
      trace.check('健康卡的表格包含组件、状态及最近动态', () => {
        const { card } = lastCard(ctx, null);
        assert.match(card.title, /健康/);
        const columns = card.raw.elements.filter(element => element.tag === 'column_set');
        assert.ok(columns.length >= 2);
        assert.match(card.bodyText, /组件[\s\S]*状态[\s\S]*最近动态/);
        assert.match(card.bodyText, /Feishu|飞书/);
        assert.match(card.bodyText, /正常|尚未触发/);
      });
    });
  });
}

async function blankSession(ctx) {
  const { trace, topics, providers, wire } = ctx;
  await trace.stage(2, '标准新建空白会话与话题内日常多轮连续对话', async () => {
    let draft;
    await trace.step('2.1 在主群发送 /new，不填写首句', async () => {
      await ctx.send(null, '/new');
      await ctx.settle();
      draft = lastCard(ctx, null);
      trace.check('蓝色新建卡列出三个后端与 Top-5 项目', () => {
        assert.equal(draft.card.title, '新建会话');
        assert.equal(draft.card.template, 'blue');
        assert.deepEqual(labels(draft).slice(0, 3).map(label => label.replace(/^✓ /, '')), ['Antigravity', 'Codex', 'Claude']);
        assert.equal(draft.card.buttons.filter(button => button.value?.action === 'new_pick').length, 5);
        assert.ok(labels(draft).includes('feishu-agent-bridge'));
        assert.ok(labels(draft).includes('gui-rl'));
        assert.doesNotMatch(draft.card.bodyText, /首句任务/);
      });
    });
    await trace.step('2.1 点击 Codex', async () => {
      const before = draft;
      await ctx.click(draft, 'Codex');
      await ctx.settle();
      draft = lastCard(ctx, null);
      trace.check('原卡原地更新为当前后端 Codex', () => {
        assert.equal(draft.id, before.id);
        assert.equal(draft.method, 'im.message.patch');
        assert.match(draft.card.bodyText, /当前后端：Codex/);
      });
    });
    await trace.step('2.1 点击 feishu-agent-bridge，进入新话题', async () => {
      await ctx.click(draft, 'feishu-agent-bridge');
      await ctx.settle();
      topics.codex = newTopic(ctx, 'codex');
      trace.check('创建根卡和交互绑定，空白会话没有自动输入', () => {
        const { rootId, sessionId } = topics.codex;
        assert.equal(ctx.runtime.store.getSession(sessionId).project, ctx.projects.bridge);
        assert.match(wire.messages.get(rootId).card.title, /^\[Codex · feishu-agent-bridge\]/);
        assert.equal(providers.codex.inputs.length, 0);
      });
      trace.observe('本步骤记录主群草稿更新、话题根消息和话题内回复。', {
        rootMessageId: topics.codex.rootId, destination: topics.codex.destination,
      });
    });
    await trace.step('2.2 输入「请先介绍一下当前目录的主要模块结构」，观察流式回复', async () => {
      const prompt = '请先介绍一下当前目录的主要模块结构';
      const inputIndex = providers.codex.inputs.length;
      const started = performance.now();
      const sent = await ctx.send(topics.codex, prompt);
      await ctx.runtime.flushInteractive();
      const latency = performance.now() - started;
      trace.observe('普通输入从事件派发到前台队列清空的实测时间。', { latencyMs: latency, sdkLatencyMs: sent.latencyMs });
      trace.check('常规输入由前台快速派发（小于 100 ms）', () => {
        assert.equal(providers.codex.inputs[inputIndex]?.text, prompt);
        assert.ok(latency < 100, `输入耗时 ${latency.toFixed(1)} ms`);
      });
      const streamed = ctx.emitText(topics.codex, '入口在 `src/index.ts`。');
      await ctx.tick();
      trace.check('先收到运行中的蓝色卡片', () => {
        assert.ok(ctx.writes(topics.codex).some(message => message.card.template === 'blue'
          && message.card.bodyText.includes('src/index.ts')));
      });
      ctx.emitText(topics.codex, '入口在 `src/index.ts`。输出在 `outputs/`。', {
        messageId: streamed.messageId, final: true,
      });
      await ctx.finish(topics.codex);
      const deadline = performance.now() + 2200;
      while (performance.now() < deadline && !ctx.writes(topics.codex).some(message => message.card.template === 'green')) {
        await setTimeout(50);
        await ctx.tick();
      }
      trace.check('完成卡为绿色，话题标题同步，短轮次没有额外文本推送', () => {
        assert.ok(ctx.writes(topics.codex).some(message => message.card.template === 'green'
          && /^Codex · 已完成 · 用时 /.test(message.card.title)));
        assert.equal(wire.messages.get(topics.codex.rootId).card.title, `[Codex · feishu-agent-bridge] ${prompt}`);
        assert.ok(![...wire.messages.values()].some(message => message.type === 'text' && message.rootId === topics.codex.rootId));
      });
    });
    await trace.step('2.3 追问「把刚才提到的入口文件里的配置校验逻辑总结成 3 条要点」', async () => {
      const reply = '1. 检查 `path` 是否存在。\n2. 读取项目配置。\n3. 返回校验结果。';
      await ctx.start(topics.codex, '把刚才提到的入口文件里的配置校验逻辑总结成 3 条要点');
      await ctx.finish(topics.codex, reply);
      trace.check('同一话题的完成卡保留 Markdown 列表和行内代码', () => {
        assert.ok(ctx.writes(topics.codex).some(message => message.card.template === 'green' && message.card.bodyText.includes(reply)));
      });
    });
    await trace.step('2.3 在 Codex 话题发送 /swarm 检查所有边界条件', async () => {
      const before = providers.codex.inputs.length;
      await ctx.send(topics.codex, '/swarm 检查所有边界条件');
      await ctx.settle();
      trace.check('Codex 话题说明 /swarm 仅支持 Antigravity', () => {
        const { card } = lastCard(ctx, topics.codex);
        assert.equal(card.title, '当前会话不支持 /swarm');
        assert.match(card.bodyText, /Antigravity/);
        assert.equal(providers.codex.inputs.length, before);
      });
    });
  });
}

async function firstPrompt(ctx) {
  const { trace, providers, topics } = ctx;
  await trace.stage(3, '主群带首句新建会话直达开跑', async () => {
    let draft;
    const prompt = '帮我排查长回复截断并汇总实验看板';
    await trace.step(`3.1 在主群发送 /new agy ${prompt}`, async () => {
      await ctx.send(null, `/new agy ${prompt}`);
      await ctx.settle();
      draft = lastCard(ctx, null);
      trace.check('新建卡预览首句与指定后端', () => {
        assert.match(draft.card.bodyText, /当前后端：Antigravity/);
        assert.ok(draft.card.bodyText.includes(`首句任务：${prompt}`));
      });
    });
    await trace.step('3.1 点击 gui-rl，观察话题自动发送首句', async () => {
      await ctx.click(draft, 'gui-rl');
      await ctx.settle();
      topics.agy = newTopic(ctx, 'agy');
      trace.check('首句恰好派发一次，且落入新建的 Antigravity 话题', () => {
        assert.equal(ctx.runtime.store.getSession(topics.agy.sessionId).project, ctx.projects.gui);
        assert.deepEqual(providers.agy.inputs.map(input => input.text), [prompt]);
        assert.equal(providers.agy.inputs[0].ref.nativeSessionId, topics.agy.ref.nativeSessionId);
        assert.equal(ctx.turn(topics.agy)?.status, 'running');
      });
      trace.check('话题根卡与接入卡均显示首句标题，接入卡没有闪现空闲状态', () => {
        const root = ctx.wire.messages.get(topics.agy.rootId);
        const binding = ctx.writes(topics.agy).find(({card}) => /已接入/.test(card.bodyText));
        assert.equal(root.card.title, `[AGY · gui-rl] ${prompt}`);
        assert.equal(binding?.card.title, prompt);
        assert.doesNotMatch(binding.card.bodyText, /空闲/);
      });
      await ctx.finish(topics.agy, '已检查长回复边界，并整理实验看板。');
    });
    await trace.step('3.2 在主群用 /create claude <项目目录> 直接创建', async () => {
      await ctx.send(null, `/create claude ${ctx.projects.research}`);
      await ctx.settle();
      topics.claude = newTopic(ctx, 'claude');
      trace.check('创建 Claude 话题并完成交互绑定', () => {
        assert.equal(ctx.runtime.store.getSession(topics.claude.sessionId).project, ctx.projects.research);
        assert.match(ctx.wire.messages.get(topics.claude.rootId).card.title, /^\[Claude · research\]/);
      });
    });
    await trace.step('3.3 在已经绑定的 Codex 话题发送 /new', async () => {
      await ctx.send(topics.codex, '/new');
      await ctx.settle();
      trace.check('话题内显示回主群新建会话的引导', () => {
        assert.equal(lastCard(ctx, topics.codex).card.title, '请在主群新建会话');
      });
    });
  });
}

export async function entry(ctx) {
  await mainChat(ctx);
  await blankSession(ctx);
  await firstPrompt(ctx);
}
