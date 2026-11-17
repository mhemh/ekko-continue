import fs from 'node:fs/promises';
import path from 'node:path';

const ACTIVITY_LIMIT = 1000;
const PENDING_TTL_MS = 60000;
const FALLBACK_GRACE_MS = 700;
const STALE_EVENT_MS = 5 * 60 * 1000;
const MESSAGE_LOOKUP_LIMIT = 12;
const MESSAGE_LOOKUP_TIMEOUT_MS = 3000;
const SKIP_STOP_REASONS = new Set(['queue_insertion', 'aborted', 'waiting_for_tasks']);

const DEFAULTS = {
  enabled: true,
  prompt: '继续',
  maxAttempts: 5,
  cooldownMs: 5000,
  backoffBaseMs: 2000,
  backoffMaxMs: 30000,
  fallbackProvider: '',
  fallbackModel: '',
  fallbackApiMode: '',
};

const CLASSIFIERS = [
  ['auth', /invalid.?api.?key|unauthorized|authentication|api key.{0,20}(invalid|missing|expired)|\b401\b|\b403\b|密钥|鉴权|认证失败/i],
  ['quota', /insufficient.?quota|\bquota\b|billing|credit balance|余额|额度|配额|欠费/i],
  ['context', /context.?(length|window)|maximum context|too many tokens|prompt is too long|token limit|上下文.{0,8}(超|长)|超出.{0,8}上下文/i],
  ['max-tokens', /max.?tokens|max(imum)?.?output|finish_reason.{0,6}length|output.{0,12}(limit|length)|输出.{0,8}(长度|上限)|截断/i],
  ['rate-limit', /rate.?limit|too many requests|\b429\b|overloaded|请求.{0,8}(频繁|过快)|限流|并发/i],
  ['queue-insertion', /insert a queued message|queued message interrupt|排队.{0,6}(插入|消息)/i],
  ['cancel', /run cancell?ed|run aborted|aborted by user|stopped by user|user.{0,8}(stop|cancel)|用户.{0,8}(停止|取消|中断)|已(停止|取消)/i],
  ['interrupted', /interrupt|cancell?ed|aborted/i],
  ['transport', /econn(reset|refused)|etimedout|timeout|timed out|fetch failed|network|socket|connection|disconnect|transport|连接|网络|超时|断线/i],
  ['server', /internal server error|bad gateway|service unavailable|gateway timeout|\b50[0234]\b|upstream|server error|服务.{0,6}(异常|不可用)|上游/i],
  ['fatal', /invalid.request|bad request|\b400\b|model.{0,24}(not found|does not exist|unsupported)|not supported|content policy|safety|moderation|invalid.{0,24}(parameter|schema)|未知模型|模型不存在|参数错误/i],
];

function toInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function toText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeConfig(raw) {
  const config = raw && typeof raw === 'object' ? raw : {};
  const prompt = toText(config.prompt) || DEFAULTS.prompt;
  return {
    enabled: config.enabled !== false,
    prompt: prompt.slice(0, 2000),
    maxAttempts: toInt(config.maxAttempts, DEFAULTS.maxAttempts, 1, 20),
    cooldownMs: toInt(config.cooldownMs, DEFAULTS.cooldownMs, 0, 600000),
    backoffBaseMs: toInt(config.backoffBaseMs, DEFAULTS.backoffBaseMs, 0, 600000),
    backoffMaxMs: toInt(config.backoffMaxMs, DEFAULTS.backoffMaxMs, 0, 3600000),
    fallbackProvider: toText(config.fallbackProvider).slice(0, 200),
    fallbackModel: toText(config.fallbackModel).slice(0, 300),
    fallbackApiMode: toText(config.fallbackApiMode).slice(0, 100),
  };
}

function stringify(value, depth = 0) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (depth > 4) return '';
  try {
    return JSON.stringify(value).slice(0, 20000);
  } catch {
    return '';
  }
}

function haystackOf(event) {
  const data = event?.data ?? {};
  return [
    event?.type,
    data.summary,
    data.error,
    data.error_message,
    data.message,
    data.detail,
    data.state,
  ].map((value) => stringify(value)).join('\n').slice(0, 30000);
}

function classify(text) {
  for (const [kind, pattern] of CLASSIFIERS) {
    if (pattern.test(text)) return kind;
  }
  return 'any';
}

function decide(kind, config) {
  if (kind === 'auth') {
    return { action: 'stop', reason: '认证或密钥错误，不自动重试' };
  }
  if (kind === 'quota') {
    return { action: 'stop', reason: '配额或余额错误，不自动重试' };
  }
  if (kind === 'fatal') {
    return { action: 'stop', reason: '不可重试的请求错误' };
  }
  if (kind === 'cancel') {
    return { action: 'stop', reason: '用户已停止本次运行，不自动续跑' };
  }
  if (kind === 'queue-insertion') {
    return { action: 'stop', reason: '为插入排队消息而中断，交给排队消息继续' };
  }
  if (kind === 'context') {
    if (config.fallbackProvider && config.fallbackModel) {
      return { action: 'continue-with', reason: '上下文溢出，切换备用模型后继续' };
    }
    return { action: 'stop', reason: '上下文溢出且未配置备用模型' };
  }
  return { action: 'continue', reason: '可重试失败，发送续跑提示' };
}

function pickSessionId(event) {
  const data = event?.data ?? {};
  const subject = data.subject ?? {};
  const state = data.state ?? {};
  const candidates = [
    subject.session_id,
    subject.sessionId,
    subject.session,
    state.session_id,
    state.sessionId,
    state.session,
    data.session_id,
    data.sessionId,
    event?.identity?.sessionId,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    if (candidate && typeof candidate === 'object' && typeof candidate.id === 'string') {
      return candidate.id.trim();
    }
  }
  return '';
}

function skippedScope(data) {
  const subject = data?.subject ?? {};
  const state = data?.state ?? {};
  for (const key of ['workflow_id', 'room_id', 'group_id', 'parent_session_id', 'parent_id']) {
    const value = subject[key] ?? state[key];
    if (value !== undefined && value !== null && value !== '') return '工作流、群聊或子会话';
  }
  if (state.agent_mode === 'subagent' || state.mode === 'subagent' || subject.agent_mode === 'subagent') {
    return '子智能体会话';
  }
  return '';
}

function finishReasonOf(message) {
  const value = message?.finish_reason ?? message?.finishReason
    ?? message?.stop_reason ?? message?.stopReason;
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isTruncatedFinish(reason) {
  return /^(length|max_tokens|max_output_tokens)$/.test(reason);
}

function isTruncated(data) {
  const state = data?.state ?? {};
  const summary = data?.summary && typeof data.summary === 'object' ? data.summary : {};
  const finish = data?.finish_reason ?? data?.finishReason ?? data?.stop_reason ?? data?.stopReason
    ?? state.finish_reason ?? state.finishReason ?? state.stop_reason ?? state.stopReason
    ?? summary.finish_reason ?? summary.finishReason ?? summary.stop_reason ?? summary.stopReason;
  if (typeof finish === 'string' && isTruncatedFinish(finish.trim().toLowerCase())) return true;
  return data?.truncated === true || data?.max_tokens_reached === true
    || state.truncated === true || state.max_tokens_reached === true || summary.truncated === true;
}

function isSkippedRaw(raw) {
  if (raw?.background === true || raw?.background_snapshot === true) return '后台委派任务事件';
  if (raw?.interrupted === true) return '运行被中断（插入排队消息或用户操作）';
  if (SKIP_STOP_REASONS.has(String(raw?.stop_reason ?? ''))) return '运行以中断/停止状态结束';
  if (Number(raw?.queue_remaining || 0) > 0) return '仍有排队消息，交给队列继续';
  return '';
}

function isBusy(session) {
  if (!session || typeof session !== 'object') return false;
  if (session.running === true) return true;
  const status = session.state ?? session.status;
  return ['running', 'queued', 'starting', 'stopping'].includes(status);
}

function normalizeSession(result) {
  const session = result?.session ?? result;
  if (!session || typeof session !== 'object') return null;
  if (session.agent_mode === 'subagent' || session.mode === 'subagent') return null;
  return session;
}

function errorText(error) {
  return String(error?.message ?? error ?? 'unknown error').slice(0, 800);
}

function isStale(event) {
  const timestamp = Number(event?.timestamp);
  return Number.isFinite(timestamp) && timestamp > 0 && Date.now() - timestamp > STALE_EVENT_MS;
}

function publicConfig(config) {
  return { ...config };
}

export function apply(ctx) {
  const attempts = new Map();
  const seen = new Map();
  const pending = new Map();
  const connections = new Map();
  const ring = [];
  let disposed = false;
  let writeChain = Promise.resolve();

  const configNow = () => normalizeConfig(ctx.config);

  const record = (entry) => {
    const item = { at: Date.now(), ...entry };
    ring.push(item);
    if (ring.length > ACTIVITY_LIMIT) ring.shift();
    const dataDir = ctx.paths?.dataDir;
    if (!dataDir) return;
    const line = `${JSON.stringify(item)}\n`;
    writeChain = writeChain
      .then(async () => {
        await fs.mkdir(dataDir, { recursive: true });
        const file = path.join(dataDir, 'activity.jsonl');
        try {
          const stat = await fs.stat(file);
          if (stat.size > 1000000) {
            await fs.rm(`${file}.1`, { force: true });
            await fs.rename(file, `${file}.1`);
          }
        } catch {
          // first write
        }
        await fs.appendFile(file, line);
      })
      .catch((error) => {
        ctx.log?.warn?.('activity log write failed', { error: errorText(error) });
      });
  };

  const log = (message, data) => {
    try {
      ctx.log?.info?.(`ekko-continue: ${message}`, data);
    } catch {
      // logging must never break the runtime
    }
  };

  const fresh = (event) => {
    const id = event?.id;
    if (!id) return true;
    if (seen.has(id)) return false;
    seen.set(id, Date.now());
    if (seen.size > 500) {
      const now = Date.now();
      for (const [key, at] of seen) {
        if (now - at > 600000) seen.delete(key);
      }
      if (seen.size > 500) seen.delete(seen.keys().next().value);
    }
    return true;
  };

  const identityOf = (run) => ({
    userId: run?.identity?.userId ?? ctx.identity?.userId ?? 0,
    profile: run?.identity?.profile ?? ctx.identity?.profile ?? 'default',
  });

  const keyOf = (sid, run) => {
    const { userId, profile } = identityOf(run);
    return `${userId}|${profile}|${sid}`;
  };

  const ensureAttempt = (key, sid, profile) => {
    let state = attempts.get(key);
    if (!state) {
      state = { count: 0, lastAt: 0, timer: null, sid, profile, lastRawAt: 0, generation: 0, finishCheck: false };
      attempts.set(key, state);
      if (attempts.size > 500) {
        const oldestKey = attempts.keys().next().value;
        const oldest = attempts.get(oldestKey);
        if (oldest?.timer) clearTimeout(oldest.timer);
        attempts.delete(oldestKey);
      }
    }
    return state;
  };

  const resetAttempt = (key) => {
    const state = attempts.get(key);
    if (!state) return;
    state.count = 0;
    state.lastAt = 0;
  };

  const markPending = (key) => {
    const list = pending.get(key) ?? [];
    list.push(Date.now());
    pending.set(key, list);
  };

  const popPending = (key) => {
    const list = pending.get(key);
    if (!list?.length) return;
    list.pop();
    if (!list.length) pending.delete(key);
  };

  const consumePending = (key) => {
    const list = pending.get(key);
    if (!list?.length) return false;
    const now = Date.now();
    while (list.length && now - list[0] > PENDING_TTL_MS) list.shift();
    if (!list.length) {
      pending.delete(key);
      return false;
    }
    list.shift();
    if (!list.length) pending.delete(key);
    return true;
  };

  const runContinuation = async ({ key, sid, action, run, kind, reason, userId }) => {
    if (disposed) return;
    const config = configNow();
    if (!config.enabled) {
      record({ user_id: userId, session_id: sid, action: 'skip', reason: '插件已禁用' });
      return;
    }
    const state = attempts.get(key);
    if (!state) return;
    if (state.count >= config.maxAttempts) {
      record({ user_id: userId, session_id: sid, action: 'cap', attempt: state.count, reason: '达到单会话续跑上限' });
      return;
    }
    const host = run?.host ?? ctx.host;
    let session;
    try {
      session = normalizeSession(await host.sessions.get(sid));
    } catch (error) {
      record({ user_id: userId, session_id: sid, action: 'skip', kind, reason: `读取会话失败：${errorText(error)}` });
      return;
    }
    if (!session) {
      record({ user_id: userId, session_id: sid, action: 'skip', kind, reason: '会话不可用或为子会话' });
      return;
    }
    if (isBusy(session)) {
      record({ user_id: userId, session_id: sid, action: 'skip', kind, reason: '会话仍在运行，跳过本次续跑' });
      return;
    }
    state.count += 1;
    state.lastAt = Date.now();
    record({
      user_id: userId,
      session_id: sid,
      kind,
      action,
      attempt: state.count,
      reason,
      status: 'sending',
    });
    try {
      if (action === 'continue-with') {
        const model = { provider: config.fallbackProvider, model: config.fallbackModel };
        if (config.fallbackApiMode) model.apiMode = config.fallbackApiMode;
        await host.sessions.setModel(sid, model);
      }
      markPending(key);
      const result = await host.sessions.run(sid, config.prompt, {});
      record({
        user_id: userId,
        session_id: sid,
        kind,
        action,
        attempt: state.count,
        status: 'sent',
        detail: result?.status ?? result?.run_id ?? '',
      });
      log('continuation sent', { session_id: sid, kind, action, attempt: state.count });
    } catch (error) {
      popPending(key);
      record({
        user_id: userId,
        session_id: sid,
        kind,
        action,
        attempt: state.count,
        status: 'error',
        reason: errorText(error),
      });
      log('continuation failed', { session_id: sid, error: errorText(error) });
    }
  };

  const schedule = ({ sid, event, kind, decision, run }) => {
    const config = configNow();
    const key = keyOf(sid, run);
    const { userId, profile } = identityOf(run);
    const state = ensureAttempt(key, sid, profile);
    if (state.timer) {
      record({ user_id: userId, session_id: sid, kind, action: 'skip', reason: '已有待执行的续跑' });
      return;
    }
    if (state.count >= config.maxAttempts) {
      record({ user_id: userId, session_id: sid, kind, action: 'cap', attempt: state.count, reason: '达到单会话续跑上限' });
      return;
    }
    const now = Date.now();
    const cooldownLeft = Math.max(0, (state.lastAt || 0) + config.cooldownMs - now);
    const backoff = Math.min(config.backoffMaxMs, config.backoffBaseMs * 2 ** state.count);
    const delay = Math.max(cooldownLeft, backoff);
    state.timer = setTimeout(() => {
      state.timer = null;
      if (disposed) return;
      runContinuation({
        key,
        sid,
        action: decision.action,
        run,
        kind,
        reason: decision.reason,
        userId,
      }).catch((error) => log('continuation task failed', { session_id: sid, error: errorText(error) }));
    }, delay);
    record({
      user_id: userId,
      session_id: sid,
      kind,
      action: decision.action,
      attempt: state.count + 1,
      delay_ms: delay,
      reason: decision.reason,
      status: 'scheduled',
      event: event?.type ?? '',
    });
    log('continuation scheduled', { session_id: sid, kind, action: decision.action, delay_ms: delay });
  };

  const truncationFromMessages = async (host, sid, messageId, runId) => {
    if (!host?.sessions?.messages) return { checked: false, truncated: false };
    let timer;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('message lookup timeout')), MESSAGE_LOOKUP_TIMEOUT_MS);
      });
      const result = await Promise.race([
        host.sessions.messages(sid, { limit: MESSAGE_LOOKUP_LIMIT, offset: 0 }),
        timeout,
      ]);
      const messages = Array.isArray(result?.messages) ? result.messages
        : Array.isArray(result?.data?.messages) ? result.data.messages : [];
      const assistants = messages.filter((message) => message?.role === 'assistant');
      const wantedId = messageId == null ? '' : String(messageId);
      const wantedRun = runId == null ? '' : String(runId);
      const row = (wantedId && messages.find((message) => String(message?.id) === wantedId))
        || (wantedRun && [...assistants].reverse().find((message) => String(message?.run_marker ?? message?.runMarker ?? '') === wantedRun))
        || [...assistants].reverse().find((message) => finishReasonOf(message))
        || null;
      if (!row) return { checked: false, truncated: false };
      const reason = finishReasonOf(row);
      return { checked: Boolean(reason), truncated: isTruncatedFinish(reason) };
    } catch (error) {
      log('completion finish_reason lookup failed', { session_id: sid, error: errorText(error) });
      return { checked: false, truncated: false };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  /** ekko-agent only exports stop_reason=length via the persisted message, so the
   * finish_reason of the final assistant row is the reliable truncation source. */
  const resolveCompletion = async ({ key, sid, run, state, messageId, runId, event }) => {
    const generation = state.generation;
    state.finishCheck = true;
    let truncated = false;
    try {
      const lookup = await truncationFromMessages(run?.host ?? ctx.host, sid, messageId, runId);
      truncated = lookup.truncated;
    } catch (error) {
      log('completion resolution failed', { session_id: sid, error: errorText(error) });
    }
    if (disposed || attempts.get(key) !== state || state.generation !== generation) return;
    state.finishCheck = false;
    if (state.timer) return;
    if (truncated) {
      schedule({ sid, event: event ?? { type: 'session.run.completed' }, kind: 'max-tokens', decision: decide('max-tokens', configNow()), run });
      return;
    }
    resetAttempt(key);
  };

  const closeConnection = (key) => {
    const entry = connections.get(key);
    if (!entry) return;
    connections.delete(key);
    try {
      entry.close?.();
    } catch {
      // transport already closed
    }
  };

  const ensureConnection = ({ key, sid, run }) => {
    if (disposed) return;
    const existing = connections.get(key);
    if (existing) return;
    const host = run?.host ?? ctx.host;
    if (!host?.sessions?.connect) return;
    const entry = { status: 'connecting', sid, run, close: null };
    connections.set(key, entry);
    Promise.resolve()
      .then(() => host.sessions.connect(sid, (raw) => handleRawEvent(key, raw), 'chat'))
      .then((connection) => {
        if (disposed || connections.get(key) !== entry) {
          try {
            connection?.close?.();
          } catch {
            // ignore
          }
          return;
        }
        entry.status = 'open';
        entry.close = () => connection?.close?.();
      })
      .catch((error) => {
        if (connections.get(key) === entry) connections.delete(key);
        log('session transport unavailable', { session_id: sid, error: errorText(error) });
      });
  };

  const rawTextOf = (raw) => [
    raw?.error,
    raw?.code,
    raw?.message,
    raw?.detail,
    raw?.stop_reason,
    raw?.finish_reason,
  ].map((value) => stringify(value)).join('\n').slice(0, 30000);

  /** The business event projection drops raw error text on purpose, so the
   * decision needs the session socket payload captured while the run is live. */
  const handleRawEvent = (key, raw) => {
    if (disposed || !raw || typeof raw !== 'object') return;
    const entry = connections.get(key);
    if (!entry) return;
    const { sid, run } = entry;
    const { userId } = identityOf(run);
    if (raw.replayed === true || raw.restored === true || raw.background_snapshot === true) return;
    if (raw.event === 'transport.error' || raw.event === 'transport.disconnected') {
      closeConnection(key);
      log('session transport closed', { session_id: sid, reason: raw.event });
      return;
    }
    if (raw.event !== 'run.failed' && raw.event !== 'run.completed') return;
    const state = ensureAttempt(key, sid, entry.run?.identity?.profile ?? 'default');
    state.lastRawAt = Date.now();

    if (raw.event === 'run.failed') {
      closeConnection(key);
      const skipped = isSkippedRaw(raw);
      if (skipped) {
        record({ user_id: userId, session_id: sid, action: 'skip', kind: 'interrupted', reason: skipped, transport: 'socket' });
        return;
      }
      const kind = classify(rawTextOf(raw));
      const decision = decide(kind, configNow());
      if (decision.action === 'stop') {
        record({ user_id: userId, session_id: sid, kind, action: 'stop', reason: decision.reason, transport: 'socket' });
        return;
      }
      schedule({ sid, event: { type: 'session.run.failed' }, kind, decision, run });
      return;
    }

    closeConnection(key);
    if (isSkippedRaw(raw)) {
      resetAttempt(key);
      return;
    }
    if (isTruncated(raw)) {
      schedule({ sid, event: { type: 'session.run.completed' }, kind: 'max-tokens', decision: decide('max-tokens', configNow()), run });
      return;
    }
    resolveCompletion({
      key,
      sid,
      run,
      state,
      messageId: raw.message_id,
      runId: raw.run_id,
      event: { type: 'session.run.completed' },
    }).catch((error) => log('completion check failed', { session_id: sid, error: errorText(error) }));
  };

  const onRunEvent = async (event, run, phase) => {
    if (disposed) return;
    const config = configNow();
    if (!config.enabled) return;
    if (!fresh(event) || isStale(event)) return;
    const data = event?.data ?? {};
    const sid = pickSessionId(event);
    if (!sid) {
      record({ user_id: identityOf(run).userId, action: 'skip', reason: '事件缺少会话 ID', event: event?.type ?? '' });
      return;
    }
    const scope = skippedScope(data);
    if (scope) {
      record({ user_id: identityOf(run).userId, session_id: sid, action: 'skip', reason: `忽略${scope}`, event: event?.type ?? '' });
      return;
    }
    const key = keyOf(sid, run);
    const { userId, profile } = identityOf(run);
    const state = ensureAttempt(key, sid, profile);
    if (phase === 'completed') {
      if (state.timer || state.finishCheck || Date.now() - state.lastRawAt < 5000) return;
      if (isTruncated(data)) {
        schedule({ sid, event, kind: 'max-tokens', decision: decide('max-tokens', config), run });
        return;
      }
      const subject = data.subject ?? {};
      await resolveCompletion({
        key,
        sid,
        run,
        state,
        messageId: data.message_id ?? subject.message_id,
        runId: subject.run_id ?? data.run_id,
        event,
      });
      return;
    }
    // A live socket subscription carries the real error text; this business
    // event is only the fallback when that transport is not established.
    if (state.fallbackTimer) return;
    const delay = connections.has(key) ? FALLBACK_GRACE_MS : 0;
    state.fallbackTimer = setTimeout(() => {
      state.fallbackTimer = null;
      if (disposed || state.timer || (state.lastRawAt && Date.now() - state.lastRawAt < 5000)) return;
      const kind = classify(haystackOf(event));
      const decision = decide(kind, configNow());
      if (decision.action === 'stop') {
        record({
          user_id: userId,
          session_id: sid,
          kind,
          action: 'stop',
          reason: decision.reason,
          event: event?.type ?? '',
        });
        return;
      }
      schedule({ sid, event, kind, decision, run });
    }, delay);
  };

  const listeners = [
    ctx.events.on('chat.run.failed', (event, run) => {
      onRunEvent(event, run, 'failed').catch((error) => log('run.failed handler failed', { error: errorText(error) }));
    }),
    ctx.events.on('chat.run.completed', (event, run) => {
      onRunEvent(event, run, 'completed').catch((error) => log('run.completed handler failed', { error: errorText(error) }));
    }),
    ctx.events.on('chat.run.started', (event, run) => {
      if (disposed || isStale(event)) return;
      const sid = pickSessionId(event);
      if (!sid) return;
      const data = event?.data ?? {};
      if (skippedScope(data)) return;
      const key = keyOf(sid, run);
      const state = ensureAttempt(key, sid, identityOf(run).profile);
      state.generation += 1;
      state.finishCheck = false;
      if (!consumePending(key)) {
        if (state.timer) {
          clearTimeout(state.timer);
          state.timer = null;
          record({ user_id: run?.identity?.userId, session_id: sid, action: 'skip', reason: '用户发起了新的运行，取消待执行的续跑' });
        }
        resetAttempt(key);
      }
      ensureConnection({ key, sid, run });
    }),
  ];

  const readActivity = async (limit, userId) => {
    const dataDir = ctx.paths?.dataDir;
    if (dataDir) {
      try {
        const text = await fs.readFile(path.join(dataDir, 'activity.jsonl'), 'utf8');
        const lines = text.split('\n').filter(Boolean).slice(-limit * 4);
        const entries = [];
        for (const line of lines) {
          try {
            const item = JSON.parse(line);
            if (item.user_id === undefined || item.user_id === userId) entries.push(item);
          } catch {
            // ignore damaged line
          }
        }
        return entries.slice(-limit);
      } catch {
        // fall through to memory
      }
    }
    return ring.filter((item) => item.user_id === undefined || item.user_id === userId).slice(-limit);
  };

  const rpcDisposer = ctx.extensions.rpc.register('activity', async (input, run) => {
    const limit = toInt(input?.limit, 100, 1, 500);
    const { userId } = identityOf(run);
    const entries = await readActivity(limit, userId);
    const prefix = `${userId}|`;
    const sessions = [];
    for (const [key, state] of attempts) {
      if (!key.startsWith(prefix)) continue;
      sessions.push({
        session_id: state.sid ?? key.slice(prefix.length + (state.profile?.length ?? 0) + 1),
        count: state.count,
        pending: Boolean(state.timer),
        last_at: state.lastAt || null,
      });
    }
    return {
      config: publicConfig(configNow()),
      entries,
      sessions,
    };
  });

  ctx.lifecycle.add(() => {
    disposed = true;
    for (const state of attempts.values()) {
      if (state.timer) clearTimeout(state.timer);
      if (state.fallbackTimer) clearTimeout(state.fallbackTimer);
    }
    for (const key of [...connections.keys()]) closeConnection(key);
    attempts.clear();
    seen.clear();
    pending.clear();
    for (const off of listeners) {
      try {
        off?.();
      } catch {
        // ignore
      }
    }
    try {
      rpcDisposer?.();
    } catch {
      // ignore
    }
  });

  log('plugin activated', { config: publicConfig(configNow()) });
}