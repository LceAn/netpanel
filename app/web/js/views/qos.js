// QoS: 模式与端口优先级 / 带宽控制 / 风暴抑制。
// 三个页面结构相同: 选端口 → 填参数 → 应用。只选中一个端口时, 表单自动带入它当前的值。

import { h } from '../dom.js';
import { card, badge, button, banner, portChips, select, table, notes, toggle, segmented, input, actions, field } from '../ui.js';
import { QOS_MODE, PRIORITY, STORM_TYPES, rate } from '../labels.js';
import { dataPage } from './shared.js';

/** 生成"端口 + 参数 + 应用"表单。pick(port) 取该端口当前值, fill(values) 把值填进表单。 */
function portForm({ chips, controls, apply }) {
  // 只选一个端口时带入它当前的值 (与原厂页面行为一致)
  chips.addEventListener('click', () => {
    const picked = chips.value.length === 1 ? chips.value[0] : null;
    controls.fill(picked);
  });
  return card({
    title: '批量设置', icon: 'settings',
    body: h('div', { class: 'stack' },
      h('div', { class: 'form-grid' }, field('端口', chips), ...controls.nodes),
      actions(button('应用', { variant: 'primary', icon: 'check', onClick: () => apply(chips.value) }))),
  });
}

export const basic = {
  id: 'qos.basic',
  render: (ctx) => dataPage(ctx, {
    title: 'QoS 模式与端口优先级',
    desc: '拥塞时让重要的流量（语音、视频）优先通过。',
    keys: ['qosBasic'],
    build: (d, t) => {
      const q = d.qosBasic;
      let mode = q.mode;
      const selector = segmented(Object.entries(QOS_MODE).map(([v, label]) => [Number(v), label]), mode, (v) => (mode = v));
      const chips = portChips({ count: q.portCount, lagOf: (p) => q.ports[p - 1]?.lag ?? 0 });
      const queue = select(Object.entries(PRIORITY).map(([v, label]) => [Number(v) - 1, label]), 0, { 'aria-label': '优先级队列' });
      const portBased = q.mode === 0;
      return [
        card({
          title: 'QoS 模式', icon: 'gauge',
          body: h('div', { class: 'stack' },
            h('div', { class: 'row' }, selector, h('span', { class: 'spacer' }), button('应用', { variant: 'primary', icon: 'check', onClick: () => t.apply('qos.mode', { mode }, { success: 'QoS 模式已应用' }) })),
            banner('info', h('div', null,
              h('div', null, h('b', null, '基于端口'), '：按下面的端口优先级队列决定先后。'),
              h('div', null, h('b', null, '基于 802.1P'), '：按报文里携带的 802.1P 优先级标签决定先后。'),
              h('div', null, h('b', null, '基于 DSCP'), '：按 IP 报文头里的 DSCP 字段决定先后。')))),
        }),
        portBased ? null : banner('warn', '当前 QoS 模式不是“基于端口”，端口优先级不生效。如需修改，请先把模式切换为“基于端口”。'),
        portForm({
          chips,
          controls: {
            nodes: [field('优先级队列', queue)],
            fill: (p) => void (queue.value = String((q.ports[p - 1]?.priority ?? 1) - 1)),
          },
          apply: (ports) => t.apply('qos.priority', { ports, queue: Number(queue.value) }, { success: '端口优先级已应用' }),
        }),
        card({
          title: '当前端口优先级', icon: 'list',
          body: table([{ title: '端口' }, { title: '优先级队列' }], q.ports.map((p) => [`端口 ${p.id}${p.lag ? ` (LAG${p.lag})` : ''}`, PRIORITY[p.priority] ?? p.priority])),
        }),
        notes(['1（最低）：背景数据，如下载、备份。', '2（正常）：关键业务数据，如电子邮件、网页浏览。', '3（中等）：流媒体数据。', '4（最高）：语音通话、视频会议等低延迟数据。']),
      ];
    },
  }),
};

export const bandwidth = {
  id: 'qos.bandwidth',
  render: (ctx) => dataPage(ctx, {
    title: '带宽控制',
    desc: '给端口设置收发速率上限，防止单个设备占满出口带宽。',
    keys: ['qosBandwidth'],
    build: (d, t) => {
      const q = d.qosBandwidth;
      const chips = portChips({ count: q.portCount, lagOf: (p) => q.ports[p - 1]?.lag ?? 0 });
      const ingress = input({ placeholder: '0', inputmode: 'numeric', cls: 'mono w-md', 'aria-label': '入口限速' });
      const egress = input({ placeholder: '0', inputmode: 'numeric', cls: 'mono w-md', 'aria-label': '出口限速' });
      return [
        portForm({
          chips,
          controls: {
            nodes: [field('入口限速 (Kbps)', ingress, '0-1000000，0 表示不限速'), field('出口限速 (Kbps)', egress, '0-1000000，0 表示不限速')],
            fill: (p) => {
              ingress.value = p ? String(q.ports[p - 1]?.ingress ?? 0) : '';
              egress.value = p ? String(q.ports[p - 1]?.egress ?? 0) : '';
            },
          },
          apply: (ports) => t.apply('qos.bandwidth', { ports, ingress: Number(ingress.value || 0), egress: Number(egress.value || 0) }, { success: '限速设置已应用' }),
        }),
        card({
          title: '当前限速', icon: 'list',
          body: table(
            [{ title: '端口' }, { title: '入口限速', cls: 'num' }, { title: '出口限速', cls: 'num' }],
            q.ports.map((p) => ({ cls: p.ingress || p.egress ? '' : 'is-dim', cells: [`端口 ${p.id}${p.lag ? ` (LAG${p.lag})` : ''}`, p.ingress ? rate(p.ingress) : '不限', p.egress ? rate(p.egress) : '不限'] }))),
        }),
        notes(['限速配置为 0 表示禁用端口限速。']),
      ];
    },
  }),
};

export const storm = {
  id: 'qos.storm',
  render: (ctx) => dataPage(ctx, {
    title: '风暴抑制',
    desc: '限制广播、组播、未知单播报文的速率，防止广播风暴拖垮网络。',
    keys: ['qosStorm'],
    build: (d, t) => {
      const q = d.qosStorm;
      const chips = portChips({ count: q.portCount, lagOf: (p) => q.ports[p - 1]?.lag ?? 0 });
      let enabled = false;
      let types = new Set();
      const limit = input({ placeholder: '1-1000000', inputmode: 'numeric', cls: 'mono w-md', 'aria-label': '抑制速率' });
      const onOff = toggle(false, (v) => {
        enabled = v;
        sync();
      }, { label: '启用风暴抑制' });
      const typeButtons = Object.entries(STORM_TYPES).map(([value, label]) => {
        const b = h('button', { type: 'button', class: 'chip', 'aria-pressed': 'false', disabled: true, onclick: () => {
          const v = Number(value);
          if (types.has(v)) types.delete(v);
          else types.add(v);
          b.setAttribute('aria-pressed', types.has(v));
        } }, label);
        return [Number(value), b];
      });
      const sync = () => {
        limit.disabled = !enabled;
        for (const [, b] of typeButtons) b.disabled = !enabled;
      };
      return [
        portForm({
          chips,
          controls: {
            nodes: [
              field('状态', onOff),
              field('抑制速率 (Kbps)', limit, '1-1000000'),
              field('抑制的报文类型', h('div', { class: 'chips' }, typeButtons.map(([, b]) => b))),
            ],
            fill: (p) => {
              const cur = p ? q.ports[p - 1] : null;
              enabled = !!cur?.enabled;
              onOff.querySelector('input').checked = enabled;
              types = new Set(cur?.types ?? []);
              for (const [v, b] of typeButtons) b.setAttribute('aria-pressed', types.has(v));
              limit.value = cur?.rate && enabled ? String(cur.rate) : '';
              sync();
            },
          },
          apply: (ports) => t.apply('qos.storm', { ports, enabled, rate: Number(limit.value || 0), types: [...types] }, { success: '风暴抑制设置已应用' }),
        }),
        card({
          title: '当前配置', icon: 'list',
          body: table(
            [{ title: '端口' }, { title: '状态' }, { title: '速率', cls: 'num' }, { title: '报文类型' }],
            q.ports.map((p) => [
              `端口 ${p.id}${p.lag ? ` (LAG${p.lag})` : ''}`,
              p.enabled ? badge('启用', 'ok') : badge('禁用'),
              p.enabled ? rate(p.rate) : '—',
              p.enabled ? p.types.map((x) => STORM_TYPES[x]).join('、') : '—',
            ])),
        }),
      ];
    },
  }),
};
