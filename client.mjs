const CSS = `
.ekc { padding: 20px 24px 32px; font-size: 14px; line-height: 1.6; color: inherit; }
.ekc h2 { margin: 0 0 4px; font-size: 18px; font-weight: 600; }
.ekc .ekc-sub { margin: 0 0 18px; opacity: .65; }
.ekc .ekc-cards { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 18px; }
.ekc .ekc-card { flex: 1 1 180px; min-width: 160px; padding: 12px 14px; border: 1px solid rgba(128,128,128,.25); border-radius: 10px; }
.ekc .ekc-card b { display: block; font-size: 18px; font-weight: 600; margin-top: 2px; }
.ekc .ekc-card span { font-size: 12px; opacity: .65; }
.ekc .ekc-toolbar { display: flex; align-items: center; gap: 12px; margin: 0 0 10px; }
.ekc .ekc-btn { padding: 5px 14px; border-radius: 7px; border: 1px solid rgba(128,128,128,.35); background: transparent; color: inherit; cursor: pointer; font-size: 13px; }
.ekc .ekc-btn:hover { background: rgba(128,128,128,.12); }
.ekc .ekc-btn:disabled { opacity: .5; cursor: default; }
.ekc .ekc-muted { opacity: .6; font-size: 12px; }
.ekc .ekc-error { margin: 10px 0; padding: 10px 12px; border-radius: 8px; background: rgba(220,38,38,.1); color: #dc2626; font-size: 13px; }
.ekc .ekc-table-wrap { overflow: auto; border: 1px solid rgba(128,128,128,.25); border-radius: 10px; }
.ekc table { width: 100%; border-collapse: collapse; font-size: 13px; }
.ekc th, .ekc td { padding: 8px 10px; text-align: left; border-bottom: 1px solid rgba(128,128,128,.18); white-space: nowrap; }
.ekc th { font-weight: 600; background: rgba(128,128,128,.08); position: sticky; top: 0; }
.ekc tr:last-child td { border-bottom: none; }
.ekc td.ekc-reason { max-width: 460px; white-space: normal; }
.ekc .ekc-tag { display: inline-block; padding: 0 7px; border-radius: 999px; font-size: 12px; background: rgba(128,128,128,.14); }
.ekc .ekc-tag.ok { background: rgba(22,163,74,.15); color: #16a34a; }
.ekc .ekc-tag.warn { background: rgba(217,119,6,.16); color: #d97706; }
.ekc .ekc-tag.bad { background: rgba(220,38,38,.14); color: #dc2626; }
.ekc .ekc-empty { padding: 28px; text-align: center; opacity: .6; }
.ekc .ekc-section { margin-top: 22px; }
.ekc .ekc-section h3 { font-size: 15px; margin: 0 0 8px; }
.ekc code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; }
`;

function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatTime(timestamp) {
  if (!timestamp) return '-';
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function actionLabel(action) {
  return {
    continue: '继续',
    'continue-with': '切换模型',
    stop: '停止',
    skip: '跳过',
    cap: '达上限',
  }[action] ?? action ?? '-';
}

function statusTag(status) {
  const label = {
    scheduled: '已排队',
    sending: '发送中',
    sent: '已发送',
    error: '失败',
  }[status] ?? status ?? '-';
  const cls = status === 'sent' ? 'ok' : status === 'error' ? 'bad' : status === 'scheduled' ? 'warn' : '';
  return { label, cls };
}

export function mount(element, ctx) {
  element.textContent = '';
  const style = document.createElement('style');
  style.textContent = CSS;
  const root = h('div', 'ekc');
  element.append(style, root);

  const title = h('h2', null, '自动继续');
  const sub = h('p', 'ekc-sub', '会话失败、输出被截断，或任务计划结束但仍有未完成步骤时，按规则向同一会话发送续跑提示。配置在插件中心的本插件配置中修改。');
  root.append(title, sub);

  const cards = h('div', 'ekc-cards');
  const stateCard = h('div', 'ekc-card');
  const attemptCard = h('div', 'ekc-card');
  const ruleCard = h('div', 'ekc-card');
  stateCard.append(h('span', null, '运行状态'), h('b', null, '读取中'));
  attemptCard.append(h('span', null, '待续跑会话'), h('b', null, '0'));
  ruleCard.append(h('span', null, '规则'), h('b', null, '失败 / 计划未完成续跑'));
  cards.append(stateCard, attemptCard, ruleCard);
  root.append(cards);

  const toolbar = h('div', 'ekc-toolbar');
  const refreshButton = h('button', 'ekc-btn', '刷新');
  refreshButton.type = 'button';
  const updated = h('span', 'ekc-muted', '');
  toolbar.append(refreshButton, updated);
  root.append(toolbar);

  const errorBox = h('div', 'ekc-error');
  errorBox.hidden = true;
  root.append(errorBox);

  const wrap = h('div', 'ekc-table-wrap');
  root.append(wrap);

  const sessionSection = h('div', 'ekc-section');
  sessionSection.append(h('h3', null, '当前计数'));
  const sessionWrap = h('div', 'ekc-table-wrap');
  sessionSection.append(sessionWrap);
  root.append(sessionSection);

  let timer = null;
  let disposed = false;

  function renderConfig(config) {
    const enabled = config?.enabled !== false;
    stateCard.replaceChildren(h('span', null, '运行状态'), h('b', null, enabled ? '运行中' : '已禁用'));
    stateCard.querySelector('b').style.color = enabled ? '#16a34a' : '#dc2626';
    const parts = [];
    parts.push(`提示“${config?.prompt ?? '继续'}”`);
    parts.push(`${config?.maxAttempts ?? 5} 次上限`);
    parts.push(`${Math.round((config?.cooldownMs ?? 0) / 1000)}s 冷却`);
    parts.push(`${Math.round((config?.backoffBaseMs ?? 0) / 1000)}–${Math.round((config?.backoffMaxMs ?? 0) / 1000)}s 退避`);
    ruleCard.replaceChildren(h('span', null, '规则'), h('b', null, enabled ? parts[0] : '已禁用'));
    if (enabled) {
      const detail = h('span', null, parts.slice(1).join(' · '));
      detail.style.display = 'block';
      detail.style.marginTop = '4px';
      ruleCard.append(detail);
    }
    if (config?.fallbackProvider && config?.fallbackModel) {
      const fallback = h('span', null, `上下文溢出 → ${config.fallbackProvider}/${config.fallbackModel}`);
      fallback.style.display = 'block';
      fallback.style.marginTop = '4px';
      ruleCard.append(fallback);
    }
  }

  function renderSessions(sessions) {
    sessionWrap.replaceChildren();
    const list = Array.isArray(sessions) ? sessions : [];
    if (!list.length) {
      sessionWrap.append(h('div', 'ekc-empty', '暂无进行中的计数。'));
      attemptCard.querySelector('b').textContent = '0';
      return;
    }
    attemptCard.querySelector('b').textContent = String(list.length);
    const table = h('table');
    const head = h('tr');
    for (const label of ['会话', '已续跑', '状态', '最近触发']) head.append(h('th', null, label));
    table.append(h('thead'), h('tbody'));
    table.querySelector('thead').append(head);
    const body = table.querySelector('tbody');
    for (const item of list) {
      const row = h('tr');
      const sid = h('td', null, String(item.session_id ?? '').slice(0, 18));
      sid.title = String(item.session_id ?? '');
      row.append(sid);
      row.append(h('td', null, String(item.count ?? 0)));
      row.append(h('td', null, item.pending ? '等待中' : '空闲'));
      row.append(h('td', null, item.last_at ? formatTime(item.last_at) : '-'));
      body.append(row);
    }
    sessionWrap.append(table);
  }

  function renderEntries(entries) {
    wrap.replaceChildren();
    const list = Array.isArray(entries) ? entries : [];
    if (!list.length) {
      wrap.append(h('div', 'ekc-empty', '暂无记录。等待一次失败的会话运行。'));
      return;
    }
    const table = h('table');
    const thead = h('thead');
    const head = h('tr');
    for (const label of ['时间', '会话', '判定', '动作', '次数', '状态', '说明']) head.append(h('th', null, label));
    thead.append(head);
    const body = h('tbody');
    for (const item of [...list].reverse()) {
      const row = h('tr');
      row.append(h('td', null, formatTime(item.at)));
      const sid = h('td', null, String(item.session_id ?? '-').slice(0, 14));
      sid.title = String(item.session_id ?? '');
      row.append(sid);
      row.append(h('td', null, item.kind ?? item.event ?? '-'));
      row.append(h('td', null, actionLabel(item.action)));
      row.append(h('td', null, item.attempt === undefined ? '-' : String(item.attempt)));
      const status = statusTag(item.status);
      const tagCell = h('td');
      const tag = h('span', `ekc-tag ${status.cls}`.trim(), status.label);
      tagCell.append(tag);
      row.append(tagCell);
      const reason = h('td', 'ekc-reason', item.detail || item.reason || '');
      reason.title = item.reason || '';
      row.append(reason);
      body.append(row);
    }
    table.append(thead, body);
    wrap.append(table);
  }

  async function refresh() {
    if (disposed) return;
    refreshButton.disabled = true;
    errorBox.hidden = true;
    try {
      const result = await ctx.rpc.call('activity', { limit: 100 });
      renderConfig(result?.config);
      renderEntries(result?.entries);
      renderSessions(result?.sessions);
      updated.textContent = `更新于 ${formatTime(Date.now())}`;
    } catch (error) {
      errorBox.hidden = false;
      errorBox.textContent = `读取失败：${error?.message ?? error}`;
    } finally {
      refreshButton.disabled = false;
    }
  }

  refreshButton.addEventListener('click', refresh);
  timer = setInterval(refresh, 10000);
  refresh();

  return () => {
    disposed = true;
    if (timer) clearInterval(timer);
  };
}