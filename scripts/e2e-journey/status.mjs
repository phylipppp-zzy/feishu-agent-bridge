import assert from 'node:assert/strict';

export async function verifyStatusAfterFailure(ctx, topic) {
  const { trace, runtime } = ctx;
  const provider = ctx.providers[topic.ref.provider];
  const assertStatus = (expected, label, template) => {
    assert.equal(runtime.store.getSession(topic.sessionId).status, expected);
    const panel = ctx.writes(topic).findLast(({ card }) => card.title === '会话控制')?.card;
    assert.ok(panel?.bodyText.includes(`状态：${label}`));
    if (template) assert.equal(panel.template, template);
    else assert.notEqual(panel.template, 'red');
  };
  const openPanel = async () => {
    await ctx.send(topic, '/status');
    await ctx.settle();
  };
  let failed, recovery;
  await trace.step('运行失败后打开 /status', async () => {
    failed = await ctx.start(topic, '验证一次独立的后端运行失败');
    failed = await ctx.finish(topic, undefined, { turnId: failed.turnId, status: 'failed' });
    await openPanel();
    trace.check('面板显示真实运行失败且没有重复的发送输入失败回执', () => {
      assertStatus('failed', '执行失败', 'red');
      assert.ok(ctx.writes(topic).some(({ card }) => card.title === '会话更新' && card.bodyText.includes('运行失败')));
      assert.ok(!ctx.writes(topic).some(({ card }) =>
        card.title === '操作回执' && card.bodyText.includes('发送输入：失败')));
    });
  });
  await trace.step('失败后启动新轮次并打开 /status', async () => {
    recovery = await ctx.start(topic, '验证失败后的下一轮可以正常完成');
    await openPanel();
    trace.check('面板显示运行中', () => assertStatus('running', '运行中', 'blue'));
  });
  await trace.step('新轮次完成，再收到前一轮的失败事件', async () => {
    await ctx.finish(topic, '后续轮次已成功完成。', { turnId: recovery.turnId });
    provider.emit({ type: 'turn', ref: topic.ref, turn: failed });
    await openPanel();
    trace.check('旧轮次的重复失败事件不会让面板退回执行失败', () => assertStatus('idle', '空闲'));
  });
}
