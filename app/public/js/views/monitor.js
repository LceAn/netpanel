// 监控: 端口镜像 / 线缆检测 / 环回保护。

import { h } from '../dom.js';
import { card, badge, button, banner, portChips, select, table, notes, toggle, segmented, actions, field, emptyState } from '../ui.js';
import { LOOP, CABLE, portRanges } from '../labels.js';
import { dataPage } from './shared.js';

const KEEP = [4, '保持不变'];

const cableBadge = (state) => {
  if (state === 1) return badge('正常', 'ok');
  if (state === 5) return badge(CABLE[state], 'warn');
  if (state >= 2) return badge(CABLE[state], 'danger');
  return badge('—', 'outline');
};

export const mirror = {
  id: 'mon.mirror',
  render: (ctx) => dataPage(ctx, {
    title: '端口镜像',
    desc: '把某些端口的流量复制一份送到“监控端口”，接上抓包设备或分析软件即可旁路监听。',
    keys: ['mirror'],
    build: (d, t) => {
      const m = d.mirror;
      let on = m.enabled;
      const port = select(Array.from({ length: m.maxPorts }, (_, i) => [i + 1, `端口 ${i + 1}`]), m.mirroringPort || 1, { 'aria-label': '监控端口' });
      port.disabled = !on;
      const sources = portChips({ count: m.maxPorts, value: m.ports.filter((p) => p.ingress || p.egress).map((p) => p.id), lagOf: (p) => m.ports[p - 1]?.lag ?? 0 });
      const ingress = segmented([KEEP, [0, '禁用'], [1, '启用']], 4);
      const egress = segmented([KEEP, [0, '禁用'], [1, '启用']], 4);
      return [
        card({
          title: '监控端口（镜像目的口）', icon: 'eye',
          actions: on ? badge('已启用', 'ok', { dot: true }) : badge('未启用'),
          body: h('div', { class: 'stack' },
            h('div', { class: 'form-grid' },
              field('端口镜像', toggle(on, (v) => {
                on = v;
                port.disabled = !v;
              }, { label: '启用端口镜像' })),
              field('监控端口', port, '抓包设备接在这个口上。')),
            actions(button('应用', {
              variant: 'primary', icon: 'check',
              onClick: () => t.apply('mirror.enable', { enabled: on, port: on ? Number(port.value) : 1 }, { success: '监控端口设置已应用' }),
            }))),
        }),
        card({
          title: '被监控端口（镜像源口）', icon: 'activity',
          body: h('div', { class: 'stack' },
            h('div', { class: 'form-grid' },
              field('被监控端口', sources, '已选端口会连同同组的汇聚成员一起选中'),
              field('入口流量', ingress, '复制发往该端口的流量'),
              field('出口流量', egress, '复制从该端口发出的流量')),
            banner('info', '“保持不变”表示不改动所选端口的这一项。'),
            actions(button('应用', {
              variant: 'primary', icon: 'check',
              onClick: async () => {
                const res = await t.apply('mirror.ports', { ports: sources.value, ingress: ingress.value, egress: egress.value }, { success: '被监控端口设置已应用' });
                if (res) sources.set([]);
              },
            }))),
        }),
        card({
          title: '当前配置', icon: 'list',
          body: table(
            [{ title: '端口' }, { title: '角色' }, { title: '入口镜像' }, { title: '出口镜像' }],
            m.ports.map((p) => [
              `端口 ${p.id}`,
              p.id === m.mirroringPort && m.enabled ? badge('监控口', 'accent') : p.ingress || p.egress ? badge('被监控', 'info') : badge('—', 'outline'),
              p.ingress ? badge('开启', 'ok') : '关闭',
              p.egress ? badge('开启', 'ok') : '关闭',
            ])),
        }),
      ];
    },
  }),
};

export const cable = {
  id: 'mon.cable',
  render: (ctx) => dataPage(ctx, {
    title: '线缆检测',
    desc: '检测各端口所连网线的状态和长度，排查开路、短路、接触不良等问题。',
    keys: ['cable'],
    build: (d, t) => {
      const c = d.cable;
      const chips = portChips({ count: c.maxPorts, disabled: (p) => !c.results[p - 1]?.enabled });
      const tested = c.results.filter((r) => r.state !== -1);
      return [
        card({
          title: '开始检测', icon: 'cable',
          body: h('div', { class: 'stack' },
            field('选择端口', chips, '被禁用的端口不能检测'),
            actions(button('开始检测', {
              variant: 'primary', icon: 'cable',
              onClick: async () => {
                const res = await t.apply('cable.run', { ports: chips.value }, {
                  confirm: { title: '开始线缆检测？', message: '检测瞬间被测端口的链路可能闪断，正在通信的端口请谨慎选择。', confirmText: '开始' },
                  success: '线缆检测完成',
                  done: (r) => void (t.data.cable = r.data ?? t.data.cable), // 结果在提交返回的页面里
                });
                if (res) chips.set([]);
              },
            }))),
        }),
        card({
          title: '检测结果', icon: 'list',
          body: tested.length
            ? table(
              [{ title: '端口' }, { title: '结果' }, { title: '线缆长度', cls: 'num' }],
              tested.map((r) => [`端口 ${r.id}`, h('span', { class: 'row' }, cableBadge(r.state), CABLE[r.state]), r.length >= 0 ? `${r.length} m` : '—']))
            : emptyState('还没有检测结果。选择端口后点“开始检测”。'),
        }),
        notes(['被禁用端口不能进行线缆检测。', '仅支持开路以及阻抗失配情况下的距离检测。', '对同一个端口前后两次诊断，请间隔 3 秒以上。', '当电缆对端未连接时，诊断结果比较准确。', '诊断结果可能存在误差，仅供参考。']),
      ];
    },
  }),
};

export const loop = {
  id: 'mon.loop',
  render: (ctx) => dataPage(ctx, {
    title: '环回保护',
    desc: '网络里出现环路时自动阻塞检测到回环的端口，避免整个网络被广播风暴拖垮。',
    keys: ['loop', 'overview'],
    build: (d, t) => {
      let enabled = d.loop.enabled;
      const overview = d.overview;
      const running = overview?.flags?.loopEnabled;
      const blocked = running ? overview.ports.filter((p) => p.loop === 'blocked').map((p) => p.id) : [];
      return [
        card({
          title: '环回保护', icon: 'undo',
          body: h('div', { class: 'stack' },
            h('div', { class: 'row' }, toggle(enabled, (v) => (enabled = v), { label: enabled ? '已启用' : '已禁用' }),
              h('span', { class: 'spacer' }),
              button('应用', { variant: 'primary', icon: 'check', onClick: () => t.apply('loop.set', { enabled }, { success: '环回保护设置已应用' }) })),
            banner('info', '当某个端口检测到回环后，该端口会自动被阻塞。')),
        }),
        running
          ? card({
            title: '各端口状态', icon: 'list',
            body: table([{ title: '端口' }, { title: '环回检测' }],
              overview.ports.map((p) => [
                `端口 ${p.id}`,
                p.loop === 'blocked' ? badge('阻塞', 'danger', { dot: true }) : p.loop === 'normal' ? badge('正常', 'ok') : badge(LOOP[p.loop] ?? '—', 'outline'),
              ])),
          })
          : null,
        blocked.length ? banner('warn', `被阻塞的端口：${portRanges(blocked)}。排除环路后这些端口会自动恢复。`) : null,
      ];
    },
  }),
};
