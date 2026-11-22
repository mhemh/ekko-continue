import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../server.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// plan.updated(ended) fires before run.completed, so the plugin settles it first.
const PLAN_SETTLE = 1700;

async function setup(config = {}) {
  const listeners = new Map();
  const runs = [];
  const models = [];
  const messageRows = [];
  const taskPlans = [];
  const rpc = new Map();
  const connections = [];
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ekko-continue-'));
  const ctx = {
    config: { cooldownMs: 0, backoffBaseMs: 0, backoffMaxMs: 0, ...config },
    identity: { userId: 7, profile: 'default' },
    paths: { dataDir: dir },
    log: { info() {}, warn() {}, error() {} },
    events: {
      on(pattern, fn) {
        listeners.set(pattern, fn);
        return () => listeners.delete(pattern);
      },
    },
    extensions: {
      rpc: {
        register(name, fn) {
          rpc.set(name, fn);
          return () => rpc.delete(name);
        },
      },
    },
    lifecycle: { add() {} },
    host: {
      sessions: {
        async connect(id, listener) {
          const connection = { id, listener, closed: false, close() { this.closed = true; } };
          connections.push(connection);
          return connection;
        },
        async get(id) {
          return { session: { id, agent_mode: 'primary' } };
        },
        async run(id, input, options) {
          runs.push({ id, input, options });
          return { status: 'accepted', run_id: `run-${runs.length}` };
        },
        async setModel(id, model) {
          models.push({ id, model });
          return { ok: true };
        },
        async messages(id, query = {}) {
          const limit = Number(query.limit) || 20;
          const offset = Number(query.offset) || 0;
          const rows = messageRows.filter((row) => row.session_id === id);
          const window = rows.slice(Math.max(0, rows.length - offset - limit), rows.length - offset);
          const plans = taskPlans.filter((plan) => plan.session_id === id);
          return { messages: window, taskPlans: plans, total: rows.length, offset, limit, hasMore: offset + window.length < rows.length };
        },
      },
    },
  };
  apply(ctx);
  return { ctx, listeners, runs, models, messageRows, taskPlans, rpc, dir, connections };
}

async function emit(listeners, type, data, options = {}) {
  const listener = listeners.get(type);
  assert.ok(listener, `missing listener for ${type}`);
  const event = {
    id: options.id ?? `evt-${Math.random()}`,
    type,
    timestamp: Date.now(),
    data,
  };
  const run = options.run ?? { identity: { userId: 7, profile: 'default' } };
  await listener(event, run);
  // Deferred work is drained by the plugin pump, not by the event handler.
  await sleep(280);
}

test('retryable failure sends the continue prompt', async (t) => {
  const harness = await setup();
  t.after(() => fs.rm(harness.dir, { recursive: true, force: true }));
  await emit(harness.listeners, 'chat.run.failed', {
    subject: { session_id: 's1' },
    summary: '429 Too Many Requests',
  });
  assert.equal(harness.runs.length, 1);
  assert.equal(harness.runs[0].id, 's1');
  assert.equal(harness.runs[0].input, '继续');
});

test('auth failures are not retried', async (t) => {
  const harness = await setup();
  t.after(() => fs.rm(harness.dir, { recursive: true, force: true }));
  await emit(harness.listeners, 'chat.run.failed', {
    subject: { session_id: 's1' },
    summary: '401 invalid api key',
  });
  assert.equal(harness.runs.length, 0);
});

test('attempt cap stops further continuations', async (t) => {
  const harness = await setup({ maxAttempts: 2 });
  t.after(() => fs.rm(harness.dir, { recursive: true, force: true }));
  for (let i = 0; i < 4; i += 1) {
    await emit(harness.listeners, 'chat.run.failed', {
      subject: { session_id: 's1' },
      summary: 'transport timeout',
    });
  }
  assert.equal(harness.runs.length, 2);
});

test('truncated completion continues', async (t) => {
  const harness = await setup();
  t.after(() => fs.rm(harness.dir, { recursive: true, force: true }));
  await emit(harness.listeners, 'chat.run.completed', {
    subject: { session_id: 's1' },
    state: { finish_reason: 'length' },
  });
  assert.equal(harness.runs.length, 1);
  assert.equal(harness.runs[0].input, '继续');
});

test('normal completion resets the attempt counter', async (t) => {
  const harness = await setup();
  t.after(() => fs.rm(harness.dir, { recursive: true, force: true }));
  await emit(harness.listeners, 'chat.run.failed', {
    subject: { session_id: 's1' },
    summary: '503 service unavailable',
  });
  await emit(harness.listeners, 'chat.run.completed', {
    subject: { session_id: 's1' },
    state: { finish_reason: 'stop' },
  });
  await emit(harness.listeners, 'chat.run.failed', {
    subject: { session_id: 's1' },
    summary: '503 service unavailable',
  });
  assert.equal(harness.runs.length, 2);
});

test('a scheduled continuation is cancelled by chat.run.stopped', async (t) => {
  const harness = await setup({ backoffBaseMs: 2000, backoffMaxMs: 2000 });
  t.after(() => fs.rm(harness.dir, { recursive: true, force: true }));
  await emit(harness.listeners, 'chat.run.failed', {
    subject: { session_id: 's1' },
    summary: 'timeout',
  });
  await emit(harness.listeners, 'chat.run.stopped', {
    subject: { session_id: 's1' },
  });
  await sleep(280);
  assert.equal(harness.runs.length, 0);
});

test('continuation runs with the session profile', async (t) => {
  const harness = await setup();
  t.after(() => fs.rm(harness.dir, { recursive: true, force: true }));
  await emit(harness.listeners, 'chat.run.failed', {
    subject: { session_id: 's1' },
    summary: 'timeout',
  }, { run: { identity: { userId: 7, profile: 'work' } } });
  assert.equal(harness.runs.length, 1);
  assert.equal(harness.runs[0].options.profile, 'work');
});

test('duplicate business event ids are ignored', async (t) => {
  const harness = await setup();
  t.after(() => fs.rm(harness.dir, { recursive: true, force: true }));
  const data = { subject: { session_id: 's1' }, summary: 'timeout' };
  await emit(harness.listeners, 'chat.run.failed', data, { id: 'same-event' });
  await emit(harness.listeners, 'chat.run.failed', data, { id: 'same-event' });
  assert.equal(harness.runs.length, 1);
});

test('group chat events are ignored', async (t) => {
  const harness = await setup();
  t.after(() => fs.rm(harness.dir, { recursive: true, force: true }));
  await emit(harness.listeners, 'chat.run.failed', {
    subject: { session_id: 's1', room_id: 'room-1' },
    summary: 'timeout',
  });
  assert.equal(harness.runs.length, 0);
});

test('run listeners return a promise so the invocation stays alive', async (t) => {
  const harness = await setup();
  t.after(() => fs.rm(harness.dir, { recursive: true, force: true }));
  for (const type of ['chat.run.failed', 'chat.run.completed']) {
    const listener = harness.listeners.get(type);
    assert.ok(listener);
    const result = listener({
      id: `evt-${type}`,
      type,
      timestamp: Date.now(),
      data: { subject: { session_id: 's1', room_id: 'room-1' }, summary: 'timeout' },
    }, { identity: { userId: 7, profile: 'default' } });
    assert.ok(result && typeof result.then === 'function', `${type} listener must return a promise`);
    await result;
  }
});

test('context failures switch to the fallback model when configured', async (t) => {
  const harness = await setup({
    fallbackProvider: 'custom:backup',
    fallbackModel: 'big-context',
  });
  t.after(() => fs.rm(harness.dir, { recursive: true, force: true }));
  await emit(harness.listeners, 'chat.run.failed', {
    subject: { session_id: 's1' },
    summary: 'maximum context length exceeded',
  });
  assert.equal(harness.models.length, 1);
  assert.deepEqual(harness.models[0].model, {
    provider: 'custom:backup',
    model: 'big-context',
  });
  assert.equal(harness.runs.length, 1);
});

test('disabled plugin does not run or record a continuation', async (t) => {
  const harness = await setup({ enabled: false });
  t.after(() => fs.rm(harness.dir, { recursive: true, force: true }));
  await emit(harness.listeners, 'chat.run.failed', {
    subject: { session_id: 's1' },
    summary: 'timeout',
  });
  assert.equal(harness.runs.length, 0);
});

async function connectSession(harness, sid = 's1') {
  await emit(harness.listeners, 'chat.run.started', { subject: { session_id: sid } });
  for (let i = 0; i < 20; i += 1) {
    const connection = [...harness.connections].reverse().find((item) => item.id === sid);
    if (connection) return connection;
    await sleep(50);
  }
  assert.fail('expected a live session connection');
}

test('socket failure text is used for the decision', async (t) => {
  const harness = await setup();
  t.after(() => fs.rm(harness.dir, { recursive: true, force: true }));
  const connection = await connectSession(harness);
  connection.listener({ event: 'run.failed', session_id: 's1', error: '502 bad gateway' });
  await sleep(280);
  assert.equal(harness.runs.length, 1);
});

test('socket auth failure stops and suppresses the business fallback', async (t) => {
  const harness = await setup();
  t.after(() => fs.rm(harness.dir, { recursive: true, force: true }));
  const connection = await connectSession(harness);
  connection.listener({ event: 'run.failed', session_id: 's1', error: '401 invalid api key' });
  await emit(harness.listeners, 'chat.run.failed', {
    subject: { session_id: 's1' },
    summary: 'run failed',
  });
  await sleep(280);
  assert.equal(harness.runs.length, 0);
});

test('socket abort suppresses the follow-up business failure', async (t) => {
  const harness = await setup();
  t.after(() => fs.rm(harness.dir, { recursive: true, force: true }));
  const connection = await connectSession(harness);
  connection.listener({ event: 'abort.completed', session_id: 's1' });
  await emit(harness.listeners, 'chat.run.failed', {
    subject: { session_id: 's1' },
    summary: 'run failed',
  });
  assert.equal(harness.runs.length, 0);
});

test('user cancelled runs are not continued', async (t) => {
  const harness = await setup();
  t.after(() => fs.rm(harness.dir, { recursive: true, force: true }));
  const connection = await connectSession(harness);
  connection.listener({ event: 'run.failed', session_id: 's1', error: 'Run canceled' });
  await sleep(280);
  assert.equal(harness.runs.length, 0);
});

test('queued-message interruptions are not continued', async (t) => {
  const harness = await setup();
  t.after(() => fs.rm(harness.dir, { recursive: true, force: true }));
  const connection = await connectSession(harness);
  connection.listener({
    event: 'run.failed',
    session_id: 's1',
    error: 'interrupted',
    interrupted: true,
    stop_reason: 'queue_insertion',
    queue_remaining: 1,
  });
  await sleep(280);
  assert.equal(harness.runs.length, 0);
});

test('socket truncated completion continues', async (t) => {
  const harness = await setup();
  t.after(() => fs.rm(harness.dir, { recursive: true, force: true }));
  const connection = await connectSession(harness);
  connection.listener({ event: 'run.completed', session_id: 's1', stop_reason: 'length' });
  await sleep(280);
  assert.equal(harness.runs.length, 1);
});

test('ekko-agent completions read truncation from the persisted message', async (t) => {
  const harness = await setup();
  t.after(() => fs.rm(harness.dir, { recursive: true, force: true }));
  harness.messageRows.push({
    id: 42,
    session_id: 's1',
    role: 'assistant',
    content: 'partial answer',
    finish_reason: 'length',
    run_marker: 'run-1',
  });
  const connection = await connectSession(harness);
  connection.listener({
    event: 'run.completed',
    session_id: 's1',
    message_id: 42,
    run_id: 'run-1',
    output: 'partial answer',
  });
  await sleep(320);
  assert.equal(harness.runs.length, 1);
  assert.equal(harness.runs[0].input, '继续');
});

test('persisted stop finish_reason resets without continuing', async (t) => {
  const harness = await setup();
  t.after(() => fs.rm(harness.dir, { recursive: true, force: true }));
  harness.messageRows.push({
    id: 7,
    session_id: 's1',
    role: 'assistant',
    content: 'done',
    finish_reason: 'stop',
    run_marker: 'run-1',
  });
  const connection = await connectSession(harness);
  connection.listener({ event: 'run.completed', session_id: 's1', message_id: 7, run_id: 'run-1' });
  await sleep(320);
  assert.equal(harness.runs.length, 0);
});

test('business completion falls back to the persisted finish_reason', async (t) => {
  const harness = await setup();
  t.after(() => fs.rm(harness.dir, { recursive: true, force: true }));
  harness.messageRows.push({
    id: 9,
    session_id: 's1',
    role: 'assistant',
    content: 'partial',
    finish_reason: 'max_tokens',
    run_marker: 'run-9',
  });
  await emit(harness.listeners, 'chat.run.completed', {
    subject: { session_id: 's1', message_id: 9, run_id: 'run-9' },
    state: { finish_reason: 'stop' },
  });
  await sleep(280);
  assert.equal(harness.runs.length, 1);
});

function planSnapshot(overrides = {}) {
  const now = Date.now();
  return {
    session_id: 's1',
    plan_id: 'plan-1',
    run_id: 'run-1',
    revision: 1,
    execution_state: 'ended',
    created_at: now - 1000,
    updated_at: now,
    plan: [
      { id: 'a', step: 'first step', status: 'completed' },
      { id: 'b', step: 'second step', status: 'pending' },
    ],
    ...overrides,
  };
}

test('ended task plan with remaining steps continues', async (t) => {
  const harness = await setup();
  t.after(() => fs.rm(harness.dir, { recursive: true, force: true }));
  const connection = await connectSession(harness);
  connection.listener({ event: 'plan.updated', ...planSnapshot() });
  await sleep(PLAN_SETTLE);
  assert.equal(harness.runs.length, 1);
  assert.equal(harness.runs[0].input, '继续');
});

test('ended task plan with every step completed does not continue', async (t) => {
  const harness = await setup();
  t.after(() => fs.rm(harness.dir, { recursive: true, force: true }));
  const connection = await connectSession(harness);
  connection.listener({
    event: 'plan.updated',
    ...planSnapshot({
      plan: [
        { id: 'a', step: 'first step', status: 'completed' },
        { id: 'b', step: 'second step', status: 'completed' },
      ],
    }),
  });
  await sleep(PLAN_SETTLE);
  assert.equal(harness.runs.length, 0);
});

test('interrupted task plans do not continue', async (t) => {
  const harness = await setup();
  t.after(() => fs.rm(harness.dir, { recursive: true, force: true }));
  const connection = await connectSession(harness);
  connection.listener({ event: 'plan.updated', ...planSnapshot({ execution_state: 'interrupted' }) });
  await sleep(PLAN_SETTLE);
  assert.equal(harness.runs.length, 0);
});

test('the same plan revision only continues once', async (t) => {
  const harness = await setup();
  t.after(() => fs.rm(harness.dir, { recursive: true, force: true }));
  const connection = await connectSession(harness);
  const plan = planSnapshot();
  connection.listener({ event: 'plan.updated', ...plan });
  await sleep(300);
  connection.listener({ event: 'plan.updated', ...plan, updated_at: plan.updated_at + 5 });
  await sleep(PLAN_SETTLE);
  assert.equal(harness.runs.length, 1);
});

test('the follow-up completion event does not duplicate a plan trigger', async (t) => {
  const harness = await setup();
  t.after(() => fs.rm(harness.dir, { recursive: true, force: true }));
  const connection = await connectSession(harness);
  connection.listener({ event: 'plan.updated', ...planSnapshot() });
  await sleep(300);
  await emit(harness.listeners, 'chat.run.completed', {
    subject: { session_id: 's1' },
    state: { finish_reason: 'stop' },
  });
  await sleep(PLAN_SETTLE);
  assert.equal(harness.runs.length, 1);
});

test('business completion continues when the persisted plan has remaining steps', async (t) => {
  const harness = await setup();
  t.after(() => fs.rm(harness.dir, { recursive: true, force: true }));
  harness.messageRows.push({
    id: 11,
    session_id: 's1',
    role: 'assistant',
    content: 'partial answer',
    finish_reason: 'stop',
    run_marker: 'run-11',
  });
  harness.taskPlans.push(planSnapshot({ plan_id: 'plan-11', run_id: 'run-11', revision: 4 }));
  await emit(harness.listeners, 'chat.run.completed', {
    subject: { session_id: 's1', message_id: 11, run_id: 'run-11' },
    state: { finish_reason: 'stop' },
  });
  await sleep(280);
  assert.equal(harness.runs.length, 1);
});

test('stale task plans from another run do not continue', async (t) => {
  const harness = await setup();
  t.after(() => fs.rm(harness.dir, { recursive: true, force: true }));
  harness.messageRows.push({
    id: 12,
    session_id: 's1',
    role: 'assistant',
    content: 'done',
    finish_reason: 'stop',
    run_marker: 'run-12',
  });
  harness.taskPlans.push(planSnapshot({
    plan_id: 'plan-old',
    run_id: 'run-old',
    updated_at: Date.now() - 10 * 60 * 1000,
  }));
  await emit(harness.listeners, 'chat.run.completed', {
    subject: { session_id: 's1', message_id: 12, run_id: 'run-12' },
    state: { finish_reason: 'stop' },
  });
  await sleep(280);
  assert.equal(harness.runs.length, 0);
});

test('replayed socket events are ignored', async (t) => {
  const harness = await setup();
  t.after(() => fs.rm(harness.dir, { recursive: true, force: true }));
  const connection = await connectSession(harness);
  connection.listener({ event: 'run.failed', session_id: 's1', error: '502 bad gateway', replayed: true });
  await sleep(280);
  assert.equal(harness.runs.length, 0);
});

test('activity rpc returns logged entries', async (t) => {
  const harness = await setup();
  t.after(() => fs.rm(harness.dir, { recursive: true, force: true }));
  await emit(harness.listeners, 'chat.run.failed', {
    subject: { session_id: 's1' },
    summary: 'timeout',
  });
  await sleep(280);
  const handler = harness.rpc.get('activity');
  assert.ok(handler);
  const result = await handler({ limit: 20 }, { identity: { userId: 7, profile: 'default' } });
  assert.ok(result.entries.length >= 1);
  assert.equal(result.entries.at(-1).session_id, 's1');
  assert.equal(result.config.enabled, true);
});