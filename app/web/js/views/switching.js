// 二层交换: 链路聚合 / 端口隔离 / MAC 搜索。

import { h } from '../dom.js';
import { card, button, banner, portChips, select, table, notes, input, actions, field, emptyState } from '../ui.js';
import { isolatedPairs, portRanges } from '../labels.js';
import { dataPage } from './shared.js';

export const lag = {
  id: 'sw.lag',
  render: (ctx) => dataPage(ctx, {
    title: '链路聚合',
    desc: '把多个端口绑成一个汇聚组（LAG），汇聚成一条带宽更高、可互为备份的链路。',
    keys: ['lag'],
    build: (d, t) => {
      const g = d.lag;
      const emptyGroup = g.groups.find((x) => !x.members.length)?.id ?? 1;
      const group = select(g.groups.map((x) => [x.id, `汇聚组 ${x.id}`]), emptyGroup, { 'aria-label': '汇聚组' });
      const members = portChips({ count: g.portCount, value: g.groups[emptyGroup - 1].members });
      group.addEventListener('change', () => members.set(g.groups[Number(group.value) - 1].members));
      const rangeText = (id) => {
        const r = g.ranges[id];
        return r ? `${r[0]}-${r[1]}` : '不限';
      };
      return [
        card({
          title: '配置汇聚组', icon: 'swap',
          body: h('div', { class: 'stack' },
            h('div', { class: 'form-grid' }, field('汇聚组', group), field('成员端口', members, `每个汇聚组 2-${g.portsPerLag} 个端口；端口必须连到同一台对端设备。`)),
            actions(button('应用', {
              variant: 'primary', icon: 'check',
              onClick: async () => {
                const id = Number(group.value);
                const res = await t.apply('lag.set', { group: id, ports: members.value }, {
                  confirm: g.groups[id - 1].members.length ? { title: `修改汇聚组 ${id}？`, message: '成员变化会导致该汇聚组的链路短暂中断。', confirmText: '应用' } : undefined,
                  success: `汇聚组 ${id} 已配置`,
                });
                if (res) members.set(d.lag.groups[id - 1]?.members ?? []);
              },
            }))),
        }),
        card({
          title: '当前汇聚组', icon: 'list',
          body: g.groups.some((x) => x.members.length)
            ? table(
              [{ title: '汇聚组' }, { title: '成员端口' }, { title: '可选端口范围' }, { title: '', cls: 'center' }],
              g.groups.filter((x) => x.members.length).map((x) => [
                `汇聚 ${x.id}`,
                h('span', { class: 'mono strong' }, portRanges(x.members)),
                rangeText(x.id),
                h('div', { class: 'row' }, h('button', { class: 'btn sm danger', type: 'button', onclick: () => t.apply('lag.delete', { groups: [x.id] }, { confirm: { title: `删除汇聚组 ${x.id}？`, message: '成员端口将恢复为独立端口，链路会短暂中断。', confirmText: '删除' }, success: `汇聚组 ${x.id} 已删除` }) }, '删除')),
              ]))
            : emptyState('还没有配置任何汇聚组。'),
        }),
        notes([`最多创建 ${g.maxLag} 个汇聚组。`, `每个汇聚组最多有 ${g.portsPerLag} 个成员端口。`, '监控端口不能被加入到汇聚组。']),
      ];
    },
  }),
};

export const isolation = {
  id: 'sw.isolation',
  render: (ctx) => dataPage(ctx, {
    title: '端口隔离',
    desc: '让某些端口之间互相不通（例如不让访客端口访问其它内网端口），但都能通过上联口上网。',
    keys: ['isolation', 'vlan8021q'],
    build: (d, t) => {
      const iso = d.isolation;
      const ports = portChips({ count: iso.portCount, lagOf: (p) => iso.rules[p - 1]?.lag ?? 0 });
      const from = portChips({
        count: iso.portCount, lagOf: (p) => iso.rules[p - 1]?.lag ?? 0,
        extras: iso.lags.map((n) => ({ value: `l${n}`, label: `LAG ${n}` })),
      });
      const pairs = isolatedPairs(iso.rules, iso.portCount);
      return [
        !d.vlan8021q.enabled ? banner('warn', '端口隔离只能在启用 802.1Q VLAN 时配置。请先到「802.1Q VLAN」页面启用。') : null,
        card({
          title: '添加隔离规则', icon: 'shield',
          body: h('div', { class: 'stack' },
            h('div', { class: 'stack' },
              field('要隔离的端口', ports),
              field('与上面这些端口隔离的端口 / 汇聚', from, '两组端口之间将互相隔离。')),
            actions(button('应用', {
              variant: 'primary', icon: 'check',
              onClick: async () => {
                const res = await t.apply('isolation.set', { ports: ports.value, from: from.value }, { success: '端口隔离规则已应用' });
                if (res) {
                  ports.set([]);
                  from.set([]);
                }
              },
            }))),
        }),
        card({
          title: '当前规则', icon: 'list',
          body: pairs.length
            ? h('div', { class: 'stack' }, table([{ title: '互相隔离的端口' }], pairs.map(([a, b]) => [`端口 ${a} ⇄ 端口 ${b}`])))
            : emptyState('目前没有任何端口被隔离，所有端口可以互相访问。'),
        }),
        notes(['端口隔离功能只能在 802.1Q VLAN 下配置。', '若配置的 802.1Q VLAN 和端口隔离有冲突，802.1Q VLAN 优先级高于端口隔离。']),
      ];
    },
  }),
};

export const mac = {
  id: 'sw.mac',
  render: (ctx) => {
    const mac = input({ placeholder: '00:11:22:33:44:55', maxlength: 18, cls: 'mono w-md', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'MAC 地址' });
    const vid = input({ placeholder: '可留空', inputmode: 'numeric', cls: 'w-sm', 'aria-label': 'VLAN ID' });
    const result = h('div', { class: 'stack' }, emptyState('输入 MAC 地址后点“查询”。'));
    const run = async () => {
      const res = await ctx.call(() => ctx.api.macSearch({ mac: mac.value.trim(), vid: vid.value.trim() === '' ? '' : Number(vid.value) }));
      if (!res) return;
      const rows = res.data?.results ?? [];
      result.replaceChildren(card({
        title: '查询结果', icon: 'search',
        body: rows.length
          ? table([{ title: 'MAC 地址' }, { title: 'VLAN' }, { title: '所在端口' }], rows.map((r) => [h('span', { class: 'mono' }, r.mac), res.data.qvlan ? r.vid : '—', `端口 ${r.port}`]))
          : emptyState('没有找到这个 MAC 地址。设备可能已下线，或 MAC 地址有误。'),
      }));
    };
    return h('div', { class: 'stack' },
      h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'MAC 搜索'), h('div', { class: 'desc' }, '查询某个 MAC 地址是从交换机的哪个端口学到的。'))),
      card({
        title: '查询', icon: 'search',
        body: h('div', { class: 'stack' },
          h('div', { class: 'form-grid' },
            field('MAC 地址', mac, '支持 aa:bb:cc:dd:ee:ff、aabbccddeeff、aa-bb-cc-dd-ee-ff'),
            field('VLAN ID', vid, '0-4094')),
          actions(button('查询', { variant: 'primary', icon: 'search', onClick: run }))),
      }),
      result);
  },
};
