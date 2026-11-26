// 全部设备总览: 每台设备一张卡片 (在线状态、端口小图、流量与趋势、运行时间), 点进去是这台设备的页面。
// 数据来自面板后台轮询的缓存, 每 5 秒刷新一次 —— 不直接打设备。

import { h, kids, repaintKeepingFocus, toastError } from '../dom.js';
import { badge, button, card, emptyState, errorState, input, jack, pageHead, segmented, sparkline } from '../ui.js';
import { ago, rate, uptimeShort } from '../labels.js';

const POLL_MS = 5000;
const VIEW_KEY = 'netpanel.dashboard.view';
const MAX_MINI_PORTS = 48;

const HEALTH_TEXT = {
  online: () => null,
  offline: (d) => `离线 · 最后在线 ${ago(d.lastOk)}`,
  auth: (d) => '账号或密码不对 · 请更新设备密码',
  error: (d) => `出错 · ${d.lastError ?? '未知原因'}`,
  disabled: () => '已停用轮询',
  unknown: () => '等待第一次轮询…',
};

const HEALTH_BADGE = { online: ['在线', 'ok'], offline: ['离线', 'danger'], auth: ['凭据失效', 'warn'], error: ['出错', 'danger'], disabled: ['已停用', ''], unknown: ['连接中', ''] };

const healthKind = (d) => (d.enabled === false || d.health === 'disabled' ? 'disabled' : d.health || 'unknown');

/** 端口小图: 每个口一个小网口, 配色与单台设备的端口面板一致。 */
function miniPorts(d) {
  const states = d.portStates ?? [];
  const box = h('div', { class: 'd-ports' });
  for (const p of states.slice(0, MAX_MINI_PORTS)) {
    const j = jack();
    j.update({ enabled: p.enabled, speedAct: p.speedAct });
    box.append(j);
  }
  if (states.length > MAX_MINI_PORTS) box.append(h('span', { class: 'muted small' }, `+${states.length - MAX_MINI_PORTS}`));
  if (!states.length) box.append(h('span', { class: 'muted small' }, d.portCount ? `${d.portCount} 个端口` : '端口数未知'));
  return box;
}

/** 收 / 发两条迷你趋势线叠在一起 (绿 = 收, 蓝 = 发)。 */
function trend(history) {
  const box = h('div', { class: 'd-trend' });
  if (!history || history.length < 2) {
    box.append(h('span', { class: 'muted small' }, '正在收集趋势…'));
    return box;
  }
  const rx = sparkline('tone-up');
  const tx = sparkline('tone-info');
  rx.update(history.map((s) => s.rx));
  tx.update(history.map((s) => s.tx));
  box.append(rx, tx);
  return box;
}

function deviceCard(d, { onOpen, onEdit }) {
  const kind = healthKind(d);
  const [, tone] = HEALTH_BADGE[kind];
  const note = HEALTH_TEXT[kind](d);
  const exp = d.adapterMaturity === 'experimental';
  const press = (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) { e.preventDefault(); onOpen(); } }; // 卡片是 role=link, 回车要能进去 (里面的按钮自己处理回车)
  return h('article', { class: `device-card is-${kind}`, onclick: onOpen, onkeydown: press, tabindex: '0', role: 'link', 'aria-label': `打开 ${d.name}`, 'data-fk': `open:${d.id}` },
    h('div', { class: 'd-head' },
      badge(HEALTH_BADGE[kind][0], tone, { dot: kind !== 'disabled' }),
      h('h3', { class: 'd-name' }, d.name),
      exp ? badge('实验性适配器', 'warn', { title: '这个适配器还没有在真机上验证过' }) : null,
      h('span', { class: 'spacer' }),
      kind === 'auth' || kind === 'offline' ? button('处理', { size: 'sm', icon: 'settings', onClick: onEdit, stop: true, fk: `edit:${d.id}` }) : null),
    h('div', { class: 'd-sub' }, d.model ?? '未知型号', ' · ', h('span', { class: 'mono' }, d.url.replace(/^https?:\/\//, '')), d.firmware ? h('span', { class: 'muted' }, ` · ${d.firmware}`) : null),
    miniPorts(d),
    h('div', { class: 'd-rates' },
      h('span', { class: 'dir rx' }, '↓ ', rate(d.rxKbps)), h('span', { class: 'dir tx' }, '↑ ', rate(d.txKbps)),
      h('span', { class: 'spacer' }),
      h('span', { class: 'muted' }, `${d.portsUp}/${d.portCount ?? '?'} 口在线`)),
    trend(d.history),
    h('div', { class: 'd-meta' },
      note ? h('span', { class: `d-note ${kind}` }, note) : h('span', { class: 'muted' }, `运行 ${uptimeShort(d.uptime)}`),
      d.cloud?.enabled ? h('span', { class: 'muted' }, d.cloud.connected ? '· 云管理已连接' : '· 云管理未连接') : null,
      (d.tags ?? []).length ? h('span', { class: 'd-tags' }, ...kids(d.tags.map((t) => h('span', { class: 'chip-tag' }, t)))) : null));
}

function deviceRow(d, { onOpen, onEdit }) {
  const kind = healthKind(d);
  return h('tr', { class: `is-${kind}`, onclick: onOpen },
    h('td', null, badge(HEALTH_BADGE[kind][0], HEALTH_BADGE[kind][1], { dot: kind !== 'disabled' })),
    h('td', null, h('div', { class: 'strong' }, d.name), h('div', { class: 'muted small' }, d.model ?? '未知型号', d.adapterMaturity === 'experimental' ? ' · 实验性适配器' : '')),
    h('td', { class: 'mono' }, d.url.replace(/^https?:\/\//, '')),
    h('td', { class: 'num' }, `${d.portsUp}/${d.portCount ?? '?'}`),
    h('td', { class: 'num' }, h('span', { class: 'dir rx' }, '↓ '), rate(d.rxKbps), h('br'), h('span', { class: 'dir tx' }, '↑ '), rate(d.txKbps)),
    h('td', null, kind === 'online' ? uptimeShort(d.uptime) : h('span', { class: 'muted' }, HEALTH_TEXT[kind](d))),
    h('td', null, ...(d.tags ?? []).map((t) => h('span', { class: 'chip-tag' }, t))),
    h('td', null, h('div', { class: 'row' }, button('进入', { size: 'sm', onClick: onOpen, stop: true, fk: `open:${d.id}` }), button('编辑', { size: 'sm', variant: 'ghost', onClick: onEdit, stop: true, fk: `edit:${d.id}` }))));
}

export default {
  async render(ctx) {
    const state = { q: '', filter: 'all', tag: null, view: localStorage.getItem(VIEW_KEY) ?? 'cards' };
    const root = h('div', { class: 'stack' });
    const toolbar = h('div', { class: 'toolbar' });
    const body = h('div');
    const foot = h('div', { class: 'muted small' });
    root.append(pageHead('全部设备', '面板里绑定的所有交换机。数据来自后台轮询，不直接访问设备。', button('添加设备', { variant: 'primary', icon: 'cable', onClick: () => ctx.navigate('deviceForm') })), toolbar, body, foot);

    const matches = (d) => {
      const kind = healthKind(d);
      if (state.filter === 'online' && kind !== 'online') return false;
      if (state.filter === 'offline' && kind !== 'offline') return false;
      if (state.filter === 'problem' && kind !== 'auth' && kind !== 'error') return false;
      if (state.filter === 'disabled' && kind !== 'disabled') return false;
      if (state.tag && !(d.tags ?? []).includes(state.tag)) return false;
      if (state.q) {
        const hay = [d.name, d.model, d.url, d.mac, ...(d.tags ?? [])].join(' ').toLowerCase();
        if (!hay.includes(state.q.toLowerCase())) return false;
      }
      return true;
    };

    const actions = (d) => ({
      onOpen: () => ctx.navigate('device', { deviceId: d.id }),
      onEdit: () => ctx.navigate('deviceForm', { deviceId: d.id }),
    });

    // 工具栏里的输入框只建一次: 如果每次重绘都换一个新的, 用户打到第二个字时焦点就没了, 轮询刷新时也会打断输入。
    const FILTERS = [['all', '全部'], ['online', '在线'], ['offline', '离线'], ['problem', '异常'], ['disabled', '已停用']];
    const LABELS = Object.fromEntries(FILTERS);
    const search = input({ type: 'search', placeholder: '搜索名称、型号、地址、标签', value: state.q, 'aria-label': '搜索设备', cls: 'search' });
    search.addEventListener('input', () => { state.q = search.value.trim(); paint(); });
    const chips = new Map(FILTERS.map(([id, label]) => [id, h('button', { type: 'button', class: 'chip', onclick: () => { state.filter = id; paint(); } }, label)]));
    const tagBox = h('div', { class: 'chips' });
    let tagList = null; // 标签栏里当前画着的标签列表, 变了才重画 (否则会把正在点的按钮换掉)
    const viewSeg = segmented([['cards', '卡片'], ['table', '表格']], state.view, (v) => { state.view = v; localStorage.setItem(VIEW_KEY, v); paint(); });
    viewSeg.setAttribute('aria-label', '显示方式');
    toolbar.replaceChildren(search, h('div', { class: 'chips' }, ...chips.values()), tagBox, h('span', { class: 'spacer' }), viewSeg);

    const paintToolbar = (dash) => {
      const tags = [...new Set(dash.devices.flatMap((d) => d.tags ?? []))].sort();
      if (state.tag && !tags.includes(state.tag)) state.tag = null;
      const count = (f) => dash.devices.filter((d) => healthKind(d) === f || (f === 'problem' && ['auth', 'error'].includes(healthKind(d)))).length;
      for (const [id, chip] of chips) {
        chip.textContent = `${LABELS[id]} ${id === 'all' ? dash.devices.length : count(id)}`;
        chip.setAttribute('aria-pressed', String(state.filter === id));
      }
      if (tags.join('\u0000') !== tagList) {
        tagList = tags.join('\u0000');
        tagBox.replaceChildren(...kids(tags.map((t) => h('button', { type: 'button', class: 'chip tag', 'aria-pressed': String(state.tag === t), onclick: () => { state.tag = state.tag === t ? null : t; paint(); } }, t))));
      } else {
        for (const b of tagBox.children) b.setAttribute('aria-pressed', String(b.textContent === state.tag));
      }
      viewSeg.set(state.view);
    };

    let lastDash = null;
    const paint = (dash = lastDash) => {
      if (!dash) return;
      paintToolbar(dash);
      const list = dash.devices.filter(matches);
      if (!dash.devices.length) {
        body.replaceChildren(card({ title: '还没有绑定设备', icon: 'cable', body: h('div', { class: 'stack' },
          h('p', { class: 'muted' }, '添加第一台交换机：填上地址和它的管理账号，面板会自动识别型号。'),
          button('添加设备', { variant: 'primary', icon: 'cable', onClick: () => ctx.navigate('deviceForm') })) }));
        return;
      }
      const items = list.map((d) => (state.view === 'cards' ? deviceCard(d, actions(d)) : deviceRow(d, actions(d))));
      // 原生 replaceChildren 会把 null 变成文字 "null", 所以统一经过 kids() 过滤
      repaintKeepingFocus(body, () => body.replaceChildren(...kids([
        h('div', { class: 'stats' },
          stat('设备', null, String(dash.totals.total)), stat('在线', 'var(--up)', String(dash.totals.online)),
          stat('异常', 'var(--danger)', String(dash.totals.offline + dash.totals.auth + dash.totals.error)),
          stat('在线端口', 'var(--info)', `${dash.totals.portsUp} / ${dash.totals.ports}`),
          stat('总接收', 'var(--up)', rate(dash.totals.rxKbps)), stat('总发送', 'var(--info)', rate(dash.totals.txKbps))),
        state.view === 'cards'
          ? h('div', { class: 'device-grid' }, ...items)
          : h('div', { class: 'card', style: { padding: '0' } }, h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
            h('thead', null, h('tr', null, ...['状态', '设备', '地址', '端口', '流量', '运行时间', '标签', ''].map((t) => h('th', null, t)))),
            h('tbody', null, ...items)))),
        !list.length ? emptyState('没有符合条件的设备。') : null,
      ])));
      foot.textContent = `共 ${dash.devices.length} 台设备${list.length !== dash.devices.length ? `，当前显示 ${list.length} 台` : ''} · 每 ${POLL_MS / 1000} 秒自动刷新`;
      lastDash = dash; // 整个内容区都画完了才算"有东西可保留"; 中途抛错不能把它当成已渲染
    };

    // 已经画出过内容之后再出错 (设备断开、接口 500): 保留上一屏, 只在第一次提示, 不要每 5 秒弹一次。
    let warned = false;
    ctx.poll(async () => {
      try {
        paint(await ctx.api.dashboard());
        warned = false;
      } catch (err) {
        if (!lastDash) body.replaceChildren(errorState(err, ctx.reload));
        else if (!warned) {
          warned = true;
          toastError(err);
        }
      }
    }, POLL_MS);
    return root;
  },
};

const stat = (label, dotColor, value) => h('div', { class: 'stat' },
  h('div', { class: 'label' }, dotColor ? h('i', { class: 'dot', style: { color: dotColor } }) : null, label), h('div', { class: 'value' }, value));
