// 端口配置 (批量设置状态 / 速率双工 / 流控) 与端口统计 (计数 + 单口报文明细)。

import { h } from '../dom.js';
import { card, badge, button, portChips, select, table, notes, loading, errorState, actions, field } from '../ui.js';
import { SPEED_CFG, SPEED_ACT, ONOFF, linkTone, packets, full, PKT_TYPES } from '../labels.js';
import { dataPage } from './shared.js';

const SPEED_OPTIONS = Object.entries(SPEED_CFG).filter(([v]) => Number(v) >= 1).map(([v, label]) => [Number(v), label]);
const ONOFF_OPTIONS = Object.entries(ONOFF).map(([v, label]) => [Number(v), label]);

const portCell = (p) => h('span', { class: 'nowrap' }, `端口 ${p.id}`, p.lag ? badge(`LAG${p.lag}`, 'info') : null);

const stateBadge = (p) => (p.enabled ? badge('启用', 'ok') : badge('禁用'));

const speedCell = (code) => h('span', { class: `speed ${linkTone(code)}` }, SPEED_ACT[code] ?? '—');

export const config = {
  id: 'ports.config',
  render: (ctx) => dataPage(ctx, {
    title: '端口配置',
    desc: '批量设置端口的状态、速率/双工与流控。',
    keys: ['ports'],
    build: (d, t) => {
      const ports = d.ports.ports;
      const chips = portChips({ count: d.ports.maxPorts, lagOf: (p) => ports[p - 1]?.lag });
      const state = select([[7, '保持不变'], [1, '启用'], [0, '禁用']], 7, { 'aria-label': '状态' });
      // 可选速率以设备能力为准: 这代固件的批量配置页本身不提供 2.5G, 不能让界面选一个后端会拒绝的值
      const speed = select([[8, '保持不变'], ...SPEED_OPTIONS.filter(([v]) => v <= (d.ports.support2_5G ? 7 : 6))], 8, { 'aria-label': '速率 / 双工' });
      const flow = select([[7, '保持不变'], ...ONOFF_OPTIONS], 7, { 'aria-label': '流控' });
      return [
        card({
          title: '批量配置', icon: 'settings',
          body: h('div', { class: 'stack' },
            h('div', { class: 'form-grid' }, field('端口', chips, '同属一个汇聚组的端口会一起选中'), field('状态', state), field('速率 / 双工', speed), field('流控', flow)),
            actions(button('应用', {
              variant: 'primary', icon: 'check',
              onClick: async () => {
                const res = await t.apply('port.settings',
                  { ports: chips.value, state: Number(state.value), speed: Number(speed.value), flow: Number(flow.value) },
                  { success: '端口配置已应用' });
                if (res) chips.set([]);
              },
            }))),
        }),
        card({
          title: '当前配置', icon: 'list',
          body: table(
            [{ title: '端口' }, { title: '状态' }, { title: '速率 / 双工 · 配置' }, { title: '速率 / 双工 · 实际' }, { title: '流控 · 配置' }, { title: '流控 · 实际' }],
            ports.map((p) => [portCell(p), stateBadge(p), SPEED_CFG[p.speedCfg] ?? '—', speedCell(p.speedAct), ONOFF[p.flowCfg], ONOFF[p.flowAct]])),
        }),
        notes(['当端口速率/双工设置为“自动”或 1000M 全双工及以上速率时，流控功能可以开启。', '开启流控后，只有链路实际协商为全双工时流控才生效。']),
      ];
    },
  }),
};

/** 单端口报文明细: 每 3 秒刷新, 用相邻两次的计数差算出每秒报文数。 */
function detailPanel(ctx) {
  const selectBox = h('span');
  const body = h('div', { class: 'stack' }, loading(3));
  const state = { port: null, count: 0, prev: null, prevAt: 0, busy: false };
  const el = card({ title: '报文明细', icon: 'activity', body: h('div', { class: 'stack' }, selectBox, body) });

  const load = async () => {
    if (!state.port || state.busy) return;
    state.busy = true;
    try {
      const data = await ctx.api.stats(state.port);
      const now = Date.now();
      const dt = state.prev ? Math.max(0.5, (now - state.prevAt) / 1000) : 0;
      const pps = (cur, i) => (dt ? `${full(Math.max(0, Math.round((cur[i] - state.prev[i]) / dt)))} /s` : '—');
      const rows = PKT_TYPES.map((label, i) => [h('span', i < 4 ? null : { class: 'muted' }, label),
        h('span', { class: 'num' }, full(data.rx[i])), h('span', { class: 'num muted' }, pps(data.rx, i)),
        h('span', { class: 'num' }, full(data.tx[i])), h('span', { class: 'num muted' }, pps(data.tx, i))]);
      body.replaceChildren(
        table([{ title: '报文类型' }, { title: '接收', cls: 'num' }, { title: '接收速率', cls: 'num' }, { title: '发送', cls: 'num' }, { title: '发送速率', cls: 'num' }], rows),
        h('div', { class: 'muted small' }, '前 4 行为正常报文，后 5 行为异常报文；每 3 秒刷新。'));
      state.prev = [data.rx, data.tx];
      state.prevAt = now;
    } catch (err) {
      if (err.status === 401) throw err; // 登录态失效交给外壳处理
      body.replaceChildren(errorState(err, load));
    } finally {
      state.busy = false;
    }
  };

  ctx.poll(load, 3000);

  const ensureSelector = (count) => {
    if (count === state.count) return;
    state.count = count;
    const sel = select(Array.from({ length: count }, (_, i) => [i + 1, `端口 ${i + 1}`]), state.port ?? 1, { 'aria-label': '选择端口' });
    sel.addEventListener('change', () => {
      state.port = Number(sel.value);
      state.prev = null; // 换了端口, 速率差值要重新累积
      void load();
    });
    selectBox.replaceChildren(h('div', { class: 'field' }, h('span', { class: 'field-label' }, '选择端口'), sel));
  };

  return {
    el,
    /** 选口规则: 链接里指定了就用它; 否则保持当前选择; 没选过或越界时落到第一个有链路的端口。选好立即加载。 */
    pick(preferred, firstLinked, count) {
      ensureSelector(count);
      if (preferred && preferred >= 1 && preferred <= count) state.port = preferred;
      else if (!state.port || state.port > count) state.port = firstLinked ?? 1;
      void load();
    },
  };
}

export const stats = {
  id: 'ports.stats',
  render: (ctx, params) => {
    let requested = Number(params?.port) || null;
    const detail = detailPanel(ctx);
    return dataPage(ctx, {
      title: '端口统计',
      desc: '各端口的收发包计数，以及单个端口的报文明细。',
      keys: ['stats'],
      head: (t) => [
        button('刷新', { icon: 'refresh', onClick: t.reload }),
        button('清空统计', {
          icon: 'undo',
          onClick: async () => {
            await t.apply('port.stats.clear', {}, { confirm: { title: '清空所有端口的统计计数？', confirmText: '清空' }, success: '统计已清空' });
          },
        }),
      ],
      build: (d) => {
        const ports = d.stats.ports;
        detail.pick(requested, ports.find((p) => p.link)?.id, d.stats.maxPorts);
        requested = null; // 只在第一次进入时采用链接参数
        return [
          card({
            title: '端口计数', icon: 'list',
            body: table(
              [{ title: '端口' }, { title: '链路' }, { title: '正常发包', cls: 'num' }, { title: '失败发包', cls: 'num' }, { title: '正常收包', cls: 'num' }, { title: '失败收包', cls: 'num' }],
              ports.map((p) => ({ cls: p.link ? '' : 'is-dim', cells: [portCell(p), speedCell(p.link), packets(p.txGood), packets(p.txBad), packets(p.rxGood), packets(p.rxBad)] }))),
          }),
          detail.el,
        ];
      },
    });
  },
};
