import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { evaluateApproval, resolveApprovalFacts } from '../../src/unified/approval-policy.js';
import { runtimeApprovalScope } from '../../src/unified/codex-approval.js';
import { payloadDigest } from '../../src/unified/contracts.js';
import { ToolProgressTracker } from '../../src/unified/tool-progress.js';

const exec = promisify(execFile);

function generation(ctx, topic) {
  return ctx.runtime.store.connectionGeneration(topic.sessionId);
}

function emitInteraction(ctx, topic, details) {
  const id = randomUUID();
  const interaction = {
    interactionId: id,
    sessionId: topic.ref.nativeSessionId,
    turnId: ctx.turn(topic).turnId,
    nativeRequestId: id,
    connectionGeneration: generation(ctx, topic),
    revision: 1,
    status: 'awaiting_answer',
    expiresAt: null,
    toolInputDigest: null,
    nativeResult: null,
    ...details,
  };
  ctx.providers[topic.ref.provider].emit({ type: 'interaction', ref: topic.ref, interaction });
  return interaction;
}

function sourceCard(ctx, interaction) {
  const ref = ctx.runtime.pendingHub.getRef(`interaction:${interaction.interactionId}`);
  return ctx.wire.messages.get(ref?.source_card_message_id);
}

async function toolProgress(ctx) {
  const { trace, topics: { codex: topic }, providers } = ctx;
  const tracker = new ToolProgressTracker();
  let cardId;
  function tool(callId, phase, command) {
    const observation = tracker.observe(topic.ref, generation(ctx, topic), ctx.turn(topic).turnId,
      callId, phase, { tool: 'Bash', summary: `Bash · ${command}` });
    assert.ok(observation, '模拟的工具状态转换必须有效');
    providers.codex.emit(observation);
  }

  await trace.stage(7, '长任务实时工具进度与折叠执行记录', async () => {
    await trace.step('7.1 发起测试检查。后端在输出正文前启动 Bash · pytest tests/', async () => {
      await ctx.start(topic, '运行核心测试，结束后给我简短总结');
      tool('pytest', 'running', 'pytest tests/');
      await ctx.tick();
      const message = ctx.cards(topic).findLast(item => item.card.bodyText.includes('Bash · pytest tests/'));
      trace.check('正文前已发出蓝色 Schema 2.0 进度卡', () => {
        assert.ok(message, '缺少工具先于正文时的进度卡');
        assert.equal(message.card.schema, '2.0');
        assert.equal(message.card.template, 'blue');
        assert.match(message.card.bodyText, /正在处理…\n⏳ 正在执行：Bash · pytest tests\//);
        assert.equal(message.card.collapsiblePanels[0]?.expanded, false);
      });
      cardId = message.id;
    });

    await trace.step('7.2 后端报告五项工具操作，其中两项并行、一项失败', async () => {
      const prior = ctx.wire.messages.get(cardId);
      tool('pytest', 'succeeded', 'pytest tests/');
      tool('typecheck', 'failed', 'npm run check');
      tool('list', 'succeeded', 'git status');
      tool('lint', 'running', 'npm run lint');
      tool('compare', 'running', 'git diff');
      await ctx.tick();
      await delay(1520);
      await ctx.tick();
      const current = ctx.wire.messages.get(cardId);
      const { card } = current;
      const patchDelayMs = Date.parse(current.updatedAt) - Date.parse(prior.updatedAt);
      trace.observe('工具状态批次到达后的同卡更新', {
        patches: current.patchCount - prior.patchCount, intervalMs: patchDelayMs,
      });
      trace.check('五项工具状态合并为一次 PATCH，相隔至少 1500ms', () => {
        assert.equal(current.patchCount - prior.patchCount, 1);
        assert.ok(patchDelayMs >= 1500, `卡片更新间隔为 ${patchDelayMs}ms`);
      });
      trace.check('并行状态在折叠面板外，两个成功及一个失败在默认折叠的执行记录内', () => {
        assert.match(card.bodyText, /⏳ 正在执行：Bash · git diff（另有 1 项并行）/);
        assert.doesNotMatch(card.bodyText, /✗|✓/);
        const [panel] = card.collapsiblePanels;
        assert.equal(panel?.expanded, false);
        assert.equal(panel.title, '执行记录（5 项，失败 1 项）');
        assert.match(panel.bodyText, /✓ Bash · pytest tests\//);
        assert.match(panel.bodyText, /✓ Bash · git status/);
        assert.match(panel.bodyText, /✗ Bash · npm run check/);
      });
      trace.observe('折叠标题里的失败计数措辞', card.collapsiblePanels[0].title);
    });

    const chunks = Array.from({ length: 8 }, (_, i) => `第 ${i + 1} 段输出已接收。\n`);
    const complete = chunks.join('');
    const messageId = 'stage-7-streamed-answer';
    await trace.step('7.3 后端在 200ms 内连续输出八次正文增量', async () => {
      const before = ctx.wire.messages.get(cardId).patchCount;
      const start = performance.now();
      for (let i = 1; i <= chunks.length; i++) {
        ctx.emitText(topic, chunks.slice(0, i).join(''), { messageId });
      }
      const burstMs = performance.now() - start;
      await ctx.tick();
      const during = ctx.wire.messages.get(cardId).patchCount - before;
      trace.observe('八次增量的模拟耗时和期间的 Feishu PATCH 数', { burstMs, patches: during });
      trace.check('八次增量在 200ms 内提交，写卡已合并', () => {
        assert.ok(burstMs < 200, `增量提交耗时 ${burstMs.toFixed(1)}ms`);
        assert.ok(during <= 1, `发送了 ${during} 次 PATCH`);
      });
    });

    await trace.step('7.3 等待本轮结束，查看同一张进度卡保留了多少正文', async () => {
      tool('lint', 'succeeded', 'npm run lint');
      tool('compare', 'succeeded', 'git diff');
      ctx.emitText(topic, complete, { messageId, final: true });
      await ctx.finish(topic);
      await delay(1520);
      await ctx.tick();
      const card = ctx.wire.messages.get(cardId).card;
      trace.check('同一张卡已转为绿色完成态，写出全部八段正文', () => {
        assert.match(card.title, /^Codex · 已完成/);
        assert.equal(card.template, 'green');
        assert.equal(card.bodyText.trim(), complete.trim());
        assert.equal(card.collapsiblePanels[0].title, '执行记录（5 项，失败 1 项）');
      });
    });
  });
}

/** The repository is local and disposable. The commands submitted for approval are never executed. */
async function prepareApprovalRepo(project) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  const git = (...args) => exec('git', ['-C', project, '-c', 'core.hooksPath=/dev/null', ...args], {
    env: { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    timeout: 5_000,
  });
  await git('init', '--quiet', '--initial-branch=main', '--template=');
  await git('-c', 'user.name=Journey Fixture', '-c', 'user.email=journey@example.invalid',
    'commit', '--allow-empty', '--no-gpg-sign', '--quiet', '-m', 'Fixture');
  await git('remote', 'add', 'origin', 'https://github.com/phylipppp-zzy/feishu-agent-bridge.git');
  await git('remote', 'add', 'projtool', 'https://github.com/phylipppp-zzy/projtool.git');
}

/** Use the same shared production gate and native approval observation shape as the adapters. */
async function requestTool(ctx, topic, request, homeDir) {
  const project = ctx.projects.bridge;
  const scope = { ...runtimeApprovalScope(ctx.config), project, cwd: project, homeDir };
  const decision = evaluateApproval(await resolveApprovalFacts(request, scope));
  ctx.trace.observe('生产审批策略返回值', { request, decision });
  if (decision.kind !== 'ask') return { decision };
  const payload = request.kind === 'command' ? { command: request.command } : { paths: request.paths };
  const interaction = emitInteraction(ctx, topic, {
    kind: 'approval',
    scope: 'this_request',
    tool: request.kind === 'command' ? 'Bash' : request.kind === 'read' ? 'Read' : 'Edit',
    action: `${decision.reason}\n${JSON.stringify(payload)}`,
    toolInputDigest: payloadDigest(payload),
  });
  return { decision, interaction };
}

function assertResolvedApproval(ctx, topic, interaction, sourceId, before, decision = 'allow') {
  const response = ctx.providers[topic.ref.provider].responses.at(-1);
  assert.deepEqual(response?.answer, { kind: 'approval', decision, scope: 'this_request' });
  assert.equal(response.interactionId, interaction.interactionId);
  assert.equal(ctx.providers[topic.ref.provider].responses.length, before + 1);
  assert.equal(ctx.runtime.pendingHub.getRef(`interaction:${interaction.interactionId}`)?.card_active, 0);
  const message = ctx.wire.messages.get(sourceId);
  assert.ok(message.patchCount > 0, '源卡必须就地更新');
  assert.equal(message.card.template, decision === 'allow' ? 'green' : 'grey');
  assert.match(message.card.title, decision === 'allow' ? /已确认|已允许/ : /已拒绝/);
  assert.equal(message.card.buttons.filter(button => !button.url).length, 0);
}

async function approvals(ctx) {
  const { trace, topics: { codex: topic }, wire, runtime, providers } = ctx;
  const homeDir = join(ctx.dir, 'approval-home');
  const reviewPath = join(homeDir, 'reviews', 'paper1', 'review.md');
  const command = (text) => ({ kind: 'command', command: text });
  const safeRequests = [
    ['读取工作区 README.md', { kind: 'read', paths: ['README.md'] }],
    ['编辑工作区 README.md', { kind: 'write', paths: ['README.md'] }],
    ['运行 npm test', command('npm test')],
    ['向本人仓库请求 git push origin main', command('git push origin main')],
  ];

  await trace.stage(8, '日常自动放行、禁区拦截与双端审批', async () => {
    await trace.step('8.1 发起项目维护任务，准备本地 Git 审批事实', async () => {
      await prepareApprovalRepo(ctx.projects.bridge);
      writeFileSync(join(ctx.projects.bridge, 'package.json'),
        JSON.stringify({ scripts: { test: 'node --test fixture.test.mjs' } }));
      writeFileSync(join(ctx.projects.bridge, 'fixture.test.mjs'), "import test from 'node:test';\ntest('fixture', () => {});\n");
      mkdirSync(join(homeDir, 'reviews', 'paper1'), { recursive: true });
      writeFileSync(reviewPath, 'Synthetic blind review fixture.\n');
      await ctx.start(topic, '检查项目配置、测试和提交状态');
    });

    for (const [label, request] of safeRequests) {
      await trace.step(`8.1 后端请求${label}`, async () => {
        const cursor = wire.calls.length;
        const { decision } = await requestTool(ctx, topic, request, homeDir);
        await ctx.tick();
        trace.check('允许本次，审批卡静默', () => {
          assert.equal(decision.kind, 'allow_once', JSON.stringify(decision));
          assert.ok(!wire.calls.slice(cursor).some(call => /需人工确认/.test(call.message?.card?.title ?? '')));
        });
      });
    }

    await trace.step('8.2 后端请求向 projtool 执行 git push', async () => {
      const cursor = wire.calls.length;
      const { decision } = await requestTool(ctx, topic, command('git push projtool main'), homeDir);
      await ctx.tick();
      trace.check('生产策略硬拒 projtool 推送且没有弹出审批卡', () => {
        assert.equal(decision.kind, 'deny', JSON.stringify(decision));
        assert.ok(!wire.calls.slice(cursor).some(call => /需人工确认/.test(call.message?.card?.title ?? '')));
      });
    });

    let reviewInteraction, reviewSource;
    await trace.step('8.2 后端请求读取模拟用户目录下的 reviews/paper1/review.md', async () => {
      const cursor = wire.calls.length;
      const { decision, interaction } = await requestTool(ctx, topic, { kind: 'read', paths: [reviewPath] }, homeDir);
      await ctx.tick();
      trace.check('盲审读取禁止自动授权，路径只指向模拟目录', () => {
        assert.ok(['deny', 'ask'].includes(decision.kind), JSON.stringify(decision));
        assert.ok(reviewPath.startsWith(ctx.dir + '/'));
      });
      if (decision.kind === 'deny') {
        trace.check('硬拒后无审批卡', () => {
          assert.ok(!wire.calls.slice(cursor).some(call => /需人工确认/.test(call.message?.card?.title ?? '')));
        });
      } else {
        reviewInteraction = interaction;
        reviewSource = sourceCard(ctx, interaction);
        trace.observe('盲审读取与预期的硬拒有差异。当前策略返回 ask，并在话题发出人工审批卡。');
        trace.check('当前人工审批有拒绝入口', () => {
          assert.ok(reviewSource?.card.buttons.some(button => button.label === '拒绝'));
        });
      }
    });

    if (reviewInteraction) {
      await trace.step('8.2 在话题中拒绝盲审读取请求', async () => {
        const before = providers.codex.responses.length;
        await ctx.click(reviewSource, '拒绝');
        await ctx.tick();
        trace.check('拒绝已送达原端，两个入口撤下', () => {
          assertResolvedApproval(ctx, topic, reviewInteraction, reviewSource.id, before, 'deny');
        });
      });
    }

    await trace.step('8.2 后端请求将模拟盲审目录推送到外部仓库', async () => {
      const reviewProject = dirname(reviewPath);
      await prepareApprovalRepo(reviewProject);
      const cursor = wire.calls.length;
      const { decision } = await requestTool(ctx, topic, command(`git -C "${reviewProject}" push origin main`), homeDir);
      await ctx.tick();
      trace.check('盲审目录推送被生产策略硬拒，话题无审批卡', () => {
        assert.equal(decision.kind, 'deny', JSON.stringify(decision));
        assert.match(decision.reason, /保密盲审/);
        assert.ok(!wire.calls.slice(cursor).some(call => /需人工确认/.test(call.message?.card?.title ?? '')));
      });
    });

    let first, firstSource;
    await trace.step('8.3 后端请求 git push --force origin main，查看话题红线审批卡', async () => {
      const outcome = await requestTool(ctx, topic, command('git push --force origin main'), homeDir);
      trace.check('改写 Git 历史必须人工确认', () => assert.equal(outcome.decision.kind, 'ask'));
      first = outcome.interaction;
      await ctx.tick();
      firstSource = sourceCard(ctx, first);
      trace.check('话题卡是橙色，正文展示中文原因、命令代码块和仅本次操作', () => {
        assert.ok(firstSource, '话题审批卡没有写出');
        assert.equal(firstSource.card.template, 'orange');
        assert.match(firstSource.card.title, /⚠️ 需人工确认/);
        assert.match(firstSource.card.bodyText, /\*\*拦截原因\*\*：[^\n]*\p{Script=Han}/u);
        assert.match(firstSource.card.bodyText, /```(?:bash)?\ngit push --force origin main\n```/);
        assert.match(firstSource.card.bodyText, /生效范围.*仅本次操作/);
        assert.doesNotMatch(firstSource.card.bodyText, /\\["n]|awaiting_answer|\{"command":/);
        assert.equal(firstSource.card.buttons.find(button => button.label === '允许本次')?.type, 'primary');
      });
      if (!firstSource.card.bodyText.includes('```bash\n')) {
        trace.observe('命令已放进代码块，当前代码围栏未标注 bash。');
      }
    });

    await trace.step('8.3 在主群发送 /pending，查看待处理入口与源话题跳转', async () => {
      await ctx.send(null, '/pending');
      await ctx.tick();
      const summary = ctx.cards(null).findLast(message => /汇总（共 1 项）/.test(message.card.title));
      trace.check('待处理汇总显示活动审批且能跳回源话题', () => {
        assert.ok(summary);
        assert.match(summary.card.bodyText, /工具权限: 1 项/);
        assert.ok(summary.card.buttons.some(button => /跳回源话题/.test(button.label) && button.url));
      });
    });

    await trace.step('8.3 在原话题点击允许本次', async () => {
      const before = providers.codex.responses.length;
      const { latencyMs } = await ctx.click(firstSource, '允许本次');
      await ctx.tick();
      trace.check('点击接收低于 100ms，原端只收到一次允许，源卡和待处理卡撤下操作', () => {
        assert.ok(latencyMs < 100, `点击接收耗时 ${latencyMs}ms`);
        assertResolvedApproval(ctx, topic, first, firstSource.id, before);
        const ref = runtime.pendingHub.getRef(`interaction:${first.interactionId}`);
        assert.equal(wire.messages.get(ref.hub_card_message_id).card.buttons.filter(button => !button.url).length, 0);
        const summary = wire.messages.get(runtime.pendingHub.getRoot().summaryMessageId);
        assert.match(summary.card.bodyText, /当前没有待处理事项/);
      });
      trace.observe('允许后的源卡实际标题', wire.messages.get(firstSource.id).card.title);
    });

    await trace.step('8.3 重放同一张原审批卡的旧允许按钮', async () => {
      const before = providers.codex.responses.length;
      const cursor = wire.calls.length;
      const { result } = await ctx.click(firstSource, '允许本次');
      await ctx.tick();
      trace.check('源话题旧按钮只返回已处理的 toast，未发出新卡或审批答复', () => {
        assert.deepEqual(result, { toast: { type: 'info', content: '该项已处理完成，无需重复操作。' } });
        assert.equal(providers.codex.responses.length, before);
        assert.ok(!wire.calls.slice(cursor).some(call => call.message?.card?.title === '操作未执行'));
      });
    });

    let second, secondSource, secondHub;
    await trace.step('8.3 后端请求 ssh gpu6 "hostname"，查看待处理话题中的同一审批', async () => {
      const outcome = await requestTool(ctx, topic, command('ssh gpu6 "hostname"'), homeDir);
      trace.check('SSH 请求必须人工确认', () => assert.equal(outcome.decision.kind, 'ask'));
      second = outcome.interaction;
      await ctx.tick();
      secondSource = sourceCard(ctx, second);
      const ref = runtime.pendingHub.getRef(`interaction:${second.interactionId}`);
      secondHub = wire.messages.get(ref?.hub_card_message_id);
      trace.check('源话题与待处理话题都生成审批卡，且待处理卡有允许和跳转按钮', () => {
        assert.ok(secondSource && secondHub);
        assert.notEqual(secondSource.id, secondHub.id);
        assert.ok(secondHub.card.buttons.some(button => button.label === '允许本次'));
        assert.ok(secondHub.card.buttons.some(button => button.label === '跳回源话题' && button.url));
      });
    });

    await trace.step('8.3 在待处理话题点击允许本次', async () => {
      const before = providers.codex.responses.length;
      await ctx.click(secondHub, '允许本次');
      await ctx.tick();
      trace.check('待处理入口提交后也就地更新源话题卡，原端只收到一次允许', () => {
        assertResolvedApproval(ctx, topic, second, secondSource.id, before);
      });
    });
    await trace.step('8.3 重放待处理话题中的旧允许按钮', async () => {
      const before = providers.codex.responses.length;
      const { result } = await ctx.click(secondHub, '允许本次');
      trace.check('待处理旧卡给出已处理的 toast，且未重复提交审批', () => {
        assert.deepEqual(result, { toast: { type: 'info', content: '该项已处理完成，无需重复操作。' } });
        assert.equal(providers.codex.responses.length, before);
      });
    });
    await trace.step('8.3 等待审批流程完成后的回复', async () => {
      await ctx.finish(topic, '审批流程已结束。');
    });
  });
}

const formCases = [
  {
    label: '9.1 单选', prompt: '优先执行哪种验证？',
    choices: ['快速回归', '全量测试', '只查日志'], multiple: false, allowFreeText: false,
    tag: 'select_static', field: 'q0_choice', selected: '1', values: ['全量测试'],
  },
  {
    label: '9.2 原生多选', prompt: '需要检查哪些输出？',
    choices: ['启动日志', '汇总, 明细', '错误截图', '运行配置'], multiple: true, allowFreeText: false,
    tag: 'multi_select_static', field: 'q0_multi', selected: ['1', '3'], values: ['汇总, 明细', '运行配置'],
  },
  {
    label: '9.3 自由输入', prompt: '还有哪些复现细节？',
    choices: [], multiple: false, allowFreeText: true,
    tag: 'input', field: 'q0_text', selected: '运行两次，第二次失败。\n保留 error_trace.txt。',
    values: ['运行两次，第二次失败。\n保留 error_trace.txt。'],
  },
];

async function questions(ctx) {
  const { trace, topics: { codex: topic }, providers, wire, runtime } = ctx;
  await trace.stage(9, '单选、原生多选与自由输入问答表单', async () => {
    await trace.step('9.1 发起验证任务，等待后端问答表单', async () => {
      await ctx.start(topic, '先问我需要检查哪些验证细节');
    });
    for (const fixture of formCases) {
      let source, question;
      await trace.step(`${fixture.label} · 后端提问“${fixture.prompt}”`, async () => {
        question = emitInteraction(ctx, topic, {
          kind: 'question',
          prompt: fixture.prompt,
          choices: fixture.choices,
          multiple: fixture.multiple,
          allowFreeText: fixture.allowFreeText,
        });
        await ctx.tick();
        source = sourceCard(ctx, question);
        trace.check('话题卡提供单个原生表单控件和提交按钮', () => {
          assert.ok(source, '未送达源问答卡');
          assert.equal(source.card.schema, '2.0');
          assert.ok(source.card.bodyText.includes(fixture.prompt));
          assert.equal(source.card.forms.length, 1);
          const { widgets } = source.card.forms[0];
          assert.equal(widgets.length, 1);
          const [widget] = widgets;
          assert.equal(widget.tag, fixture.tag);
          assert.equal(widget.name, fixture.field);
          if (fixture.choices.length) {
            assert.deepEqual(widget.options.map(option => option.text.content), fixture.choices);
          }
          assert.ok(source.card.buttons.some(button => button.formAction === 'submit' && button.label === '提交答复'));
        });
      });

      await trace.step(`${fixture.label} · 提交答复`, async () => {
        const before = providers.codex.responses.length;
        const fields = { [fixture.field]: fixture.selected };
        await ctx.click(source, '提交答复', fields);
        await ctx.tick();
        trace.check('原端收到完整答案，源卡和汇总卡保留问题及答复并收起表单', () => {
          const response = providers.codex.responses.at(-1);
          assert.equal(providers.codex.responses.length, before + 1);
          assert.equal(response?.interactionId, question.interactionId);
          assert.deepEqual(response.answer, { kind: 'question', values: fixture.values });
          const current = wire.messages.get(source.id);
          assert.ok(current.patchCount > source.patchCount);
          const ref = runtime.pendingHub.getRef(`interaction:${question.interactionId}`);
          assert.equal(ref?.card_active, 0);
          const hub = wire.messages.get(ref.hub_card_message_id);
          for (const { card } of [current, hub]) {
            assert.equal(card.schema, '2.0');
            assert.equal(card.title, '问题 · 已答复');
            assert.equal(card.template, 'green');
            assert.deepEqual(card.forms, []);
            assert.ok(card.bodyText.includes(fixture.prompt));
            assert.ok(card.bodyText.includes(`已答复：${fixture.values.join('、')}`));
            assert.match(card.bodyText, /原端已确认答复/);
          }
        });
      }, { fields: { [fixture.field]: fixture.selected } });
    }
    await trace.step('9.3 等待三个答复提交后的任务结论', async () => {
      await ctx.finish(topic, '已收到选择和复现细节。');
    });
  });
}

export async function interaction(ctx) {
  await toolProgress(ctx);
  await approvals(ctx);
  await questions(ctx);
}
