// VLAN: 802.1Q VLAN / PVID / 端口 VLAN / MTU VLAN。

import { h } from '../dom.js';
import { card, badge, button, banner, portChips, select, table, notes, kv, segmented, input, actions, field, emptyState } from '../ui.js';
import { portRanges } from '../labels.js';
import { dataPage } from './shared.js';

/** "启用 / 禁用"卡片。这几种 VLAN 模式互斥, 切换会丢失另一种模式的配置, 所以都要明确确认。 */
function modeCard({ title, icon, enabled, summary, apply, enableText, disableText, enableWarn, disableWarn }) {
  return card({
    title, icon,
    actions: enabled ? badge('已启用', 'ok', { dot: true }) : badge('未启用'),
    body: h('div', { class: 'stack' },
      summary,
      h('div', { class: 'row' },
        button(enableText, {
          variant: 'primary', icon: 'check', disabled: enabled,
          onClick: () => apply(true, { title: `${enableText}？`, confirmText: '启用', details: enableWarn }),
        }),
        button(disableText, {
          variant: 'danger', icon: 'x', disabled: !enabled,
          onClick: () => apply(false, { title: `${disableText}？`, confirmText: '禁用', details: disableWarn }),
        }))),
  });
}

const MEMBER = [[0, 'Untagged'], [1, 'Tagged'], [2, '非成员']];

export const q = {
  id: 'vlan.8021q',
  render: (ctx) => dataPage(ctx, {
    title: '802.1Q VLAN',
    desc: '按端口划分 VLAN：Untagged 端口相当于“接入模式”，Tagged 端口相当于“干道模式”（常用于级联或连接 AP、虚拟机）。',
    keys: ['vlan8021q'],
    build: (d, t) => {
      const v = d.vlan8021q;
      const vid = input({ placeholder: '1-4094', inputmode: 'numeric', cls: 'w-md', 'aria-label': 'VLAN ID' });
      const name = input({ maxlength: 12, 'aria-label': 'VLAN 描述', autocomplete: 'off' });
      const member = new Map(); // 端口 → 0 Untagged / 1 Tagged / 2 非成员
      const rows = new Map();
      const reset = () => {
        vid.value = '';
        name.value = '';
        for (const p of rows.keys()) rows.get(p).set(2);
        vid.focus();
      };
      const load = (vlan) => {
        vid.value = String(vlan.id);
        name.value = vlan.name;
        for (const p of rows.keys()) rows.get(p).set(vlan.tagged.includes(p) ? 1 : vlan.untagged.includes(p) ? 0 : 2);
        vid.focus();
      };
      const portTable = table([{ title: '端口' }, { title: '成员类型' }],
        Array.from({ length: v.portCount }, (_, i) => {
          const p = i + 1;
          const seg = segmented(MEMBER, 2, (val) => member.set(p, val));
          member.set(p, 2);
          rows.set(p, seg);
          return [`端口 ${p}`, seg];
        }));

      return [
        modeCard({
          title: '802.1Q VLAN', icon: 'layers', enabled: v.enabled,
          summary: kv([['VLAN 数量', `${v.vlans.length} / ${v.maxVlans}`]]),
          enableText: '启用 802.1Q VLAN', disableText: '禁用 802.1Q VLAN',
          enableWarn: ['启用后，端口 VLAN 和 MTU VLAN 会被自动禁止，它们的配置也会丢失。'],
          disableWarn: ['802.1Q VLAN 将被禁用，已配置的 VLAN 会全部丢失。', '禁用后所有端口的 PVID 会被恢复到 1。'],
          apply: (enabled, confirm) => t.apply('vlan.q.enable', { enabled }, { confirm, success: '802.1Q VLAN 设置已应用' }),
        }),
        card({
          title: '添加 / 编辑 VLAN', icon: 'settings',
          actions: h('div', { class: 'row' },
            button('全部设为非成员', { size: 'sm', variant: 'ghost', onClick: () => { for (const p of rows.keys()) rows.get(p).set(2); } }),
            button('清空表单', { size: 'sm', variant: 'ghost', onClick: reset })),
          body: h('div', { class: 'stack' },
            !v.enabled ? banner('warn', '请先启用 802.1Q VLAN。') : null,
            h('div', { class: 'form-grid' }, field('VLAN ID', vid, '1-4094；填已存在的 ID 即为编辑'), field('VLAN 描述', name, '最长 12 个字符，每个中文占 3 个字符，可留空')),
            portTable,
            banner('info', '每个端口在同一 VLAN 里只能是 Untagged、Tagged 或非成员之一。VLAN 1 必须包含所有不属于其它 VLAN 的端口。'),
            actions(button('添加 / 编辑', {
              variant: 'primary', icon: 'check', disabled: !v.enabled,
              onClick: async () => {
                const id = Number(vid.value);
                const tagged = [];
                const untagged = [];
                for (const [p, val] of member) {
                  if (val === 1) tagged.push(p);
                  else if (val === 0) untagged.push(p);
                }
                const exists = v.vlans.some((x) => x.id === id);
                const res = await t.apply('vlan.q.set', { vid: id, name: name.value, tagged, untagged }, {
                  confirm: exists ? { title: `修改 VLAN ${id}？`, message: '成员变化会立即影响相关端口的连通性。', confirmText: '保存' } : undefined,
                  success: `VLAN ${id} 已保存`,
                });
                if (res) reset();
              },
            }))),
        }),
        card({
          title: 'VLAN 列表', icon: 'list',
          body: v.vlans.length
            ? table(
              [{ title: 'VLAN ID' }, { title: '描述' }, { title: 'Untagged 端口' }, { title: 'Tagged 端口' }, { title: '', cls: 'nowrap' }],
              v.vlans.map((x) => [
                h('span', { class: 'mono strong' }, x.id),
                x.name || h('span', { class: 'muted' }, '—'),
                h('span', { class: 'mono' }, x.untagged.length ? portRanges(x.untagged) : '—'),
                h('span', { class: 'mono' }, x.tagged.length ? portRanges(x.tagged) : '—'),
                h('div', { class: 'row' },
                  button('编辑', { size: 'sm', disabled: !v.enabled, onClick: () => load(x) }),
                  x.id === 1 ? null : button('删除', {
                    size: 'sm', variant: 'danger',
                    onClick: () => t.apply('vlan.q.delete', { vids: [x.id] }, { confirm: { title: `删除 VLAN ${x.id}？`, message: '该 VLAN 的成员端口会立即离开这个 VLAN。', confirmText: '删除' }, success: `VLAN ${x.id} 已删除` }),
                  })),
              ]))
            : emptyState('还没有 VLAN。'),
        }),
      ];
    },
  }),
};

export const pvid = {
  id: 'vlan.pvid',
  render: (ctx) => dataPage(ctx, {
    title: '802.1Q PVID 设置',
    desc: 'PVID 是端口的默认 VLAN：端口收到的未打标签的报文会被归到这个 VLAN。',
    keys: ['vlanPvid'],
    build: (d, t) => {
      const p = d.vlanPvid;
      const chips = portChips({ count: p.portCount, lagOf: (x) => p.ports[x - 1]?.lag ?? 0 });
      const pvid = input({ placeholder: '1-4094', inputmode: 'numeric', cls: 'w-md', 'aria-label': 'PVID' });
      const hint = h('div', { class: 'hint' });
      const warn = () => {
        const id = Number(pvid.value);
        const vlan = p.vlans.find((x) => x.id === id);
        if (!vlan || !chips.value.length) return void (hint.textContent = '');
        const outside = chips.value.filter((x) => Math.floor(vlan.mask / 2 ** (x - 1)) % 2 === 0);
        hint.textContent = outside.length ? `注意：端口 ${portRanges(outside)} 不是 VLAN ${id} 的成员，设为 PVID 后可能不通。` : '';
      };
      pvid.addEventListener('input', warn);
      return [
        !p.enabled ? banner('warn', '请先到「802.1Q VLAN」页面启用 802.1Q VLAN，再设置 PVID。') : null,
        card({
          title: '设置 PVID', icon: 'settings',
          body: h('div', { class: 'stack' },
            h('div', { class: 'form-grid' }, field('端口', chips), field('PVID', pvid, '1-4094'), h('div', null, hint)),
            actions(button('应用', {
              variant: 'primary', icon: 'check', disabled: !p.enabled,
              onClick: async () => {
                const res = await t.apply('vlan.pvid.set', { pvid: Number(pvid.value), ports: chips.value }, { success: 'PVID 已应用' });
                if (res) chips.set([]);
              },
            }))),
        }),
        card({
          title: '当前 PVID', icon: 'list',
          body: table([{ title: '端口' }, { title: 'PVID', cls: 'num' }], p.ports.map((x) => [`端口 ${x.id}${x.lag ? ` (LAG${x.lag})` : ''}`, x.pvid])),
        }),
        notes(['缺省情况下所有端口的 PVID 都是 1。', '当 802.1Q VLAN 被禁用后，所有端口的 PVID 会被恢复到 1。']),
      ];
    },
  }),
};

export const port = {
  id: 'vlan.port',
  render: (ctx) => dataPage(ctx, {
    title: '端口 VLAN',
    desc: '最简单的隔离方式：把端口分组，组内互通、组间隔离。无需理解 Tag 即可使用。',
    keys: ['vlanPort'],
    build: (d, t) => {
      const v = d.vlanPort;
      const vid = input({ placeholder: `1-${v.maxVid}`, inputmode: 'numeric', cls: 'w-sm', 'aria-label': '端口 VLAN ID' });
      const chips = portChips({ count: v.portCount });
      return [
        modeCard({
          title: '端口 VLAN', icon: 'layers', enabled: v.enabled,
          summary: kv([['已配置分组', `${v.vlans.length} / ${v.maxVid}`]]),
          enableText: '启用端口 VLAN', disableText: '禁用端口 VLAN',
          enableWarn: ['启用后，802.1Q VLAN 和 MTU VLAN 会被自动禁止，它们的配置也会丢失。'],
          disableWarn: ['端口 VLAN 将被禁止，已配置的分组会全部丢失。'],
          apply: (enabled, confirm) => t.apply('vlan.port.enable', { enabled }, { confirm, success: '端口 VLAN 设置已应用' }),
        }),
        card({
          title: '添加分组', icon: 'settings',
          body: h('div', { class: 'stack' },
            h('div', { class: 'form-grid' }, field('分组 ID', vid, `1-${v.maxVid}；填已存在的 ID 即为修改该组的成员`), field('成员端口', chips, '同一个端口只能属于一个分组')),
            actions(button('应用', {
              variant: 'primary', icon: 'check', disabled: !v.enabled,
              onClick: async () => {
                const res = await t.apply('vlan.port.set', { vid: Number(vid.value), ports: chips.value }, { success: '分组已保存' });
                if (res) {
                  vid.value = '';
                  chips.set([]);
                }
              },
            }))),
        }),
        card({
          title: '当前分组', icon: 'list',
          body: v.vlans.length
            ? table([{ title: '分组 ID' }, { title: '成员端口' }, { title: '', cls: 'nowrap' }],
              v.vlans.map((x) => [
                h('span', { class: 'mono strong' }, x.id),
                h('span', { class: 'mono' }, portRanges(x.members)),
                button('编辑', {
                  size: 'sm', disabled: !v.enabled,
                  onClick: () => {
                    vid.value = String(x.id);
                    chips.set(x.members);
                    vid.focus();
                  },
                }),
              ]))
            : emptyState('还没有分组。'),
        }),
      ];
    },
  }),
};

export const mtu = {
  id: 'vlan.mtu',
  render: (ctx) => dataPage(ctx, {
    title: 'MTU VLAN',
    desc: '一种简化的隔离模式：指定一个上联口，其余端口都能通过上联口上网，但彼此之间互相隔离。',
    keys: ['vlanMtu'],
    build: (d, t) => {
      const v = d.vlanMtu;
      const uplink = select(Array.from({ length: v.portCount }, (_, i) => [i + 1, `端口 ${i + 1}`]), v.uplinkPort, { 'aria-label': '上联端口' });
      return [
        modeCard({
          title: 'MTU VLAN', icon: 'layers', enabled: v.enabled,
          summary: kv([['当前上联端口', v.enabled ? `端口 ${v.uplinkPort}` : '—']]),
          enableText: '启用 MTU VLAN', disableText: '禁用 MTU VLAN',
          enableWarn: ['启用后，端口 VLAN 和 802.1Q VLAN 会被自动禁止，它们的配置也会丢失。'],
          disableWarn: ['MTU VLAN 将被禁用，相关配置将会丢失。'],
          apply: (enabled, confirm) => t.apply('vlan.mtu.enable', { enabled }, { confirm, success: 'MTU VLAN 设置已应用' }),
        }),
        card({
          title: '上联端口', icon: 'swap',
          body: h('div', { class: 'stack' },
            !v.enabled ? banner('warn', '请先启用 MTU VLAN。') : null,
            h('div', { class: 'form-grid' }, field('上联端口', uplink, '接路由器 / 上级网络的端口')),
            actions(button('应用', {
              variant: 'primary', icon: 'check', disabled: !v.enabled,
              onClick: () => t.apply('vlan.mtu.uplink', { port: Number(uplink.value) }, { success: '上联端口已应用' }),
            }))),
        }),
      ];
    },
  }),
};
