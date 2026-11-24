import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

const milliseconds = start => Math.round((performance.now() - start) * 1000) / 1000;
const errorRecord = error => ({
  name: error?.name ?? 'Error',
  message: error?.message ?? String(error),
  ...(error?.stack ? { stack: error.stack } : {}),
});

function timedRecord(fields) {
  return {
    ...fields,
    startedAt: new Date().toISOString(),
    status: 'running',
    checks: [],
    observations: [],
  };
}

function checkCount(stage, status) {
  return [stage, ...stage.steps]
    .flatMap(item => item.checks)
    .filter(check => check.status === status).length;
}

export class JourneyTrace {
  constructor({ wire, options } = {}) {
    this.wire = wire;
    this.options = options;
    this.startedAt = new Date().toISOString();
    this.start = performance.now();
    this.stages = [];
  }

  async stage(id, title, fn) {
    if (this.currentStage) throw new Error('Journey stages cannot overlap');
    const stage = timedRecord({ id, title, steps: [] });
    this.stages.push(stage);
    this.currentStage = stage;
    const start = performance.now();
    const callIndex = this.wire?.calls.length ?? 0;
    try {
      const result = await fn();
      stage.status = 'pass';
      return result;
    } catch (error) {
      stage.status = 'fail';
      stage.error = errorRecord(error);
      throw error;
    } finally {
      stage.latencyMs = milliseconds(start);
      const stepCalls = new Set(stage.steps.flatMap(step => step.calls));
      stage.additionalCalls = this.wire?.calls.slice(callIndex).filter(call => !stepCalls.has(call)) ?? [];
      this.currentStage = undefined;
    }
  }

  async step(action, fn, details) {
    if (!this.currentStage || this.currentStep) throw new Error('Journey steps require a stage and cannot overlap');
    const step = timedRecord({ action, details, callbacks: [], dispatches: [] });
    this.currentStage.steps.push(step);
    this.currentStep = step;
    const start = performance.now();
    const callIndex = this.wire?.calls.length ?? 0;
    step.callIndex = callIndex;
    try {
      const result = await fn();
      step.status = 'pass';
      return result;
    } catch (error) {
      step.status = 'fail';
      step.error = errorRecord(error);
      throw error;
    } finally {
      step.latencyMs = milliseconds(start);
      step.calls = this.wire?.calls.slice(callIndex) ?? [];
      this.currentStep = undefined;
    }
  }

  check(label, assertion) {
    const record = this.currentStep ?? this.currentStage;
    if (!record) throw new Error('Journey assertions require a stage');
    const check = { label, status: 'running' };
    record.checks.push(check);
    const pass = value => {
      if (value === false) return fail(new Error(label));
      check.status = 'pass';
      return value;
    };
    const fail = error => {
      check.status = 'fail';
      check.error = errorRecord(error);
      throw error;
    };
    let result;
    try {
      result = assertion();
    } catch (error) {
      return fail(error);
    }
    return typeof result?.then === 'function' ? result.then(pass, fail) : pass(result);
  }

  observe(text, details) {
    const record = this.currentStep ?? this.currentStage;
    if (!record) throw new Error('Journey observations require a stage');
    record.observations.push({ text, details });
  }

  recordCallback(callback) {
    if (!this.currentStep) throw new Error('Journey callbacks require a step');
    this.currentStep.callbacks.push({ ...callback, result: callback.result ?? null });
  }

  recordDispatch(dispatch) {
    if (!this.currentStep) throw new Error('Journey dispatches require a step');
    this.currentStep.dispatches.push(dispatch);
  }

  get status() {
    return this.failure || this.stages.some(stage => stage.status !== 'pass') ? 'fail' : 'pass';
  }

  recordFailure(error) {
    this.failure = errorRecord(error);
  }

  snapshot() {
    return {
      version: 1,
      startedAt: this.startedAt,
      status: this.status,
      latencyMs: milliseconds(this.start),
      liveCheck: Boolean(this.options?.liveCheck),
      failure: this.failure,
      stages: this.stages,
      calls: this.wire?.calls ?? [],
      messages: this.wire?.messages ? [...this.wire.messages.values()] : [],
      invariantFailures: this.wire?.invariantFailures ?? [],
    };
  }

  print() {
    const outcome = this.status === 'pass' ? '通过' : '失败';
    for (const stage of this.stages) {
      console.log(`阶段 ${stage.id} ${stage.status === 'pass' ? '通过' : '失败'} · ${stage.title}`);
      for (const step of stage.steps) {
        console.log(`  ${step.status === 'pass' ? '✓' : '✗'} ${step.action} (${step.latencyMs} ms)`);
      }
      if (stage.error) console.log(`  ${stage.error.message}`);
    }
    console.log(`\n旅程整体${outcome}，共 ${this.stages.length} 个阶段，耗时 ${milliseconds(this.start)} ms。\n`);
    console.log(metricsTable(this.stages));
  }

  async write({ jsonOut, reportOut } = {}) {
    const snapshot = this.snapshot();
    const outputs = [];
    if (jsonOut) outputs.push(writeFile(jsonOut, `${JSON.stringify(snapshot, null, 2)}\n`));
    if (reportOut) outputs.push(writeFile(reportOut, markdownReport(snapshot)));
    const settled = await Promise.allSettled(outputs);
    const errors = settled.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, '写入旅程测试输出失败');
  }
}

function metricsTable(stages) {
  return [
    '| 阶段 | 结果 | 步骤 | 墙钟耗时 ms | 检查通过 | 检查失败 | 飞书 API 调用 |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: |',
    ...stages.map(stage => {
      const calls = stage.steps.reduce((count, step) => count + step.calls.length, stage.additionalCalls.length);
      const status = stage.status === 'pass' ? '通过' : '失败';
      return `| ${stage.id} | ${status} | ${stage.steps.length} | ${stage.latencyMs} | ${checkCount(stage, 'pass')} | ${checkCount(stage, 'fail')} | ${calls} |`;
    }),
  ].join('\n');
}

function block(value, language = '') {
  // The card text may itself contain Markdown fences. Keep the entire payload literal.
  const longest = Math.max(2, ...(value.match(/`+/g) ?? []).map(run => run.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${language}\n${value}\n${fence}`;
}

const jsonBlock = value => block(JSON.stringify(value, null, 2), 'json');

function describeCard(card, rejected) {
  const lines = [
    `卡片 Schema ${card.schema}，标题 ${JSON.stringify(card.title ?? '')}，标题栏颜色 ${JSON.stringify(card.template ?? null)}，序列化大小 ${card.wireBytes ?? '未知'} 字节。`,
    '标题栏',
    jsonBlock(card.header ?? { title: card.title, template: card.template }),
    rejected ? '尝试写入的卡片正文（飞书接口拒绝，用户未看到）' : '卡片正文（原样记录）',
    block(card.bodyText ?? ''),
  ];
  if (card.buttonRows?.length) {
    lines.push('按钮行（按实际布局与顺序）', jsonBlock(card.buttonRows));
  } else if (card.buttons?.length) {
    lines.push('按钮', jsonBlock(card.buttons));
  }
  if (card.forms?.length) lines.push('表单控件和选项', jsonBlock(card.forms));
  if (card.collapsiblePanels?.length) lines.push('折叠面板', jsonBlock(card.collapsiblePanels));
  return lines;
}

function describeCall(call) {
  const rejected = Boolean(call.error || call.response?.code);
  const lines = [
    `**${call.method}** · ${call.latencyMs?.toFixed(3) ?? '未知'} ms · ${call.at ?? ''}`,
  ];
  const message = call.message;
  if (message) {
    const { id, chatId, rootId, threadId, type, patchCount } = message;
    lines.push(`消息 ${id ?? '未分配'} · 群 ${chatId ?? '未知'} · 根消息 ${rootId ?? '无'} · 话题 ${threadId ?? '无'} · 类型 ${type} · 更新次数 ${patchCount ?? 0}。`);
  }
  const card = message?.card ?? call.card;
  if (card) lines.push(...describeCard(card, rejected));
  if (message?.type === 'text') {
    let content = message.content;
    try { content = JSON.parse(content).text; } catch { /* retain original wire bytes */ }
    lines.push(rejected ? '尝试发送的文本消息（用户未看到）' : '文本消息', block(content ?? ''));
  }
  if (message && ['file', 'image'].includes(message.type)) lines.push('附件消息', block(message.content ?? ''));
  if (call.upload) {
    const { key, name, byteLength, sha256 } = call.upload;
    lines.push(`上传文件 ${JSON.stringify(name)} · ${byteLength} 字节 · SHA-256 ${sha256} · file_key ${key}。`);
  }
  if (call.resource) {
    const { byteLength, sha256 } = call.resource;
    lines.push(`下载用户附件 ${JSON.stringify(call.request?.path?.file_key)} · ${byteLength} 字节 · SHA-256 ${sha256}。`);
  }
  if (rejected) {
    lines.push('飞书接口错误', jsonBlock(call.error ?? call.response));
    if (!message && typeof call.request?.data?.content === 'string') {
      lines.push('尝试写入的原始消息', block(call.request.data.content));
    }
  }
  return lines;
}

function appendChecks(lines, record) {
  if (record.checks.length) {
    lines.push(record.checks.map(check => `- ${check.status === 'pass' ? '通过' : '失败'} · ${check.label}`).join('\n'));
    for (const check of record.checks) {
      if (check.error) lines.push(block(check.error.message));
    }
  }
  if (record.error) lines.push('步骤错误', block(record.error.message));
}

function appendObservations(lines, observations) {
  for (const observation of observations) {
    lines.push(`实际观察 · ${observation.text}`);
    if (observation.details !== undefined) lines.push(jsonBlock(observation.details));
  }
}

function describeStep(step) {
  const lines = [
    `### ${step.action}`,
    `结果 ${step.status === 'pass' ? '通过' : '失败'} · 墙钟耗时 ${step.latencyMs} ms · 开始时间 ${step.startedAt}。`,
  ];
  if (step.details !== undefined) lines.push('模拟输入', jsonBlock(step.details));
  if (step.dispatches.length) lines.push('生产接收与分派计时', jsonBlock(step.dispatches));
  for (const callback of step.callbacks) {
    const { result, ...click } = callback;
    lines.push('点击与回调', jsonBlock(click));
    lines.push(result ? '实际回调返回值' : '回调未返回 toast。');
    if (result) lines.push(jsonBlock(result));
  }
  if (step.calls.length) {
    for (const call of step.calls) lines.push(...describeCall(call));
  } else {
    lines.push('此步骤无飞书 API 调用。');
  }
  const visiblySent = step.calls.some(call =>
    /(?:^|\.)message\.(create|reply|patch)$/.test(call.method)
      && call.message && !call.error && !call.response?.code);
  if (!visiblySent && !step.callbacks.some(callback => callback.result?.toast)) {
    lines.push('此步骤无用户可见消息、卡片更新或 toast。');
  }
  appendObservations(lines, step.observations);
  appendChecks(lines, step);
  return lines;
}

export function markdownReport(snapshot) {
  const lines = [
    '# 飞书统一平台端到端用户旅程与 UX 实录',
    `结果 ${snapshot.status === 'pass' ? '通过' : '失败'} · 开始时间 ${snapshot.startedAt} · 墙钟总耗时 ${snapshot.latencyMs} ms。`,
    '飞书消息由本地 SDK 传输模拟器捕获，卡片、分派和持久化走生产实现。正文按飞书 API 收到的内容原样展示。表内耗时采用本机墙钟，模拟的长任务用时单独记录。',
    snapshot.liveCheck ? '本次包含线上只读检查。' : '本次仅运行离线旅程。',
    '## 阶段总览',
    metricsTable(snapshot.stages),
  ];
  if (snapshot.failure) lines.push('运行错误', block(snapshot.failure.message));
  for (const stage of snapshot.stages) {
    lines.push(`## 阶段 ${stage.id} · ${stage.title}`);
    for (const step of stage.steps) lines.push(...describeStep(step));
    if (stage.additionalCalls.length) {
      lines.push('### 阶段内其他飞书 API 调用');
      for (const call of stage.additionalCalls) lines.push(...describeCall(call));
    }
    appendObservations(lines, stage.observations);
    appendChecks(lines, stage);
  }
  return `${lines.join('\n\n')}\n`;
}
