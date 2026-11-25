import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createHarness } from './e2e-journey/harness.mjs';
import { entry } from './e2e-journey/entry.mjs';
import { daily } from './e2e-journey/daily.mjs';
import { interaction } from './e2e-journey/interaction.mjs';
import { replies } from './e2e-journey/replies.mjs';
import { tasks } from './e2e-journey/tasks.mjs';
import { runLiveCheck } from './e2e-journey/live.mjs';
import { JourneyTrace } from './e2e-journey/trace.mjs';

async function main() {
  const { values } = parseArgs({ options: {
    'report-out': { type: 'string' },
    'json-out': { type: 'string' },
    'live-check': { type: 'boolean', default: false },
  } });
  const options = { reportOut: values['report-out'], jsonOut: values['json-out'], liveCheck: values['live-check'] };
  if (options.jsonOut && options.reportOut && resolve(options.jsonOut) === resolve(options.reportOut)) {
    throw new Error('JSON 与 Markdown 报告必须使用不同的输出路径');
  }
  const trace = new JourneyTrace({ options });
  let context;
  try {
    if (options.liveCheck) await runLiveCheck(trace);
    context = await createHarness(trace);
    for (const journey of [entry, daily, interaction, replies, tasks]) await journey(context);
    assert.deepEqual(context.wire.invariantFailures, [], 'Feishu 传输约束失败');
    context.wire.assertLedger();
  } catch (error) {
    trace.recordFailure(error);
    console.error(error);
  } finally {
    try {
      await context?.close();
    } catch (error) {
      trace.recordFailure(error);
      console.error(error);
    }
  }
  try {
    await trace.write(options);
  } catch (error) {
    trace.recordFailure(error);
    console.error(error);
  }
  trace.print();
  return trace.status === 'pass' ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
