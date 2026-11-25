// 概览: 设备信息、端口实时状态、流量趋势、单端口快捷配置。
// 每 3 秒轮询一次首页接口 (只打交换机一个请求), 数字原地更新, 不重建 DOM。

import { h, kids } from '../dom.js';
import { card, badge, button, jack, sparkline, areaChart, loading, errorState, select, kv } from '../ui.js';
import { SPEED_CFG, SPEED_ACT, linkTone, rate, rateShort, uptime, portRanges, LOOP } from '../labels.js';

const POLL_MS = 3000;
const MAX_POINTS = 120; // 6 分钟
const RX = { key: 'rx', color: '--up', label: '总接收' };
const TX = { key: 'tx', color: '--info', label: '总发送' };

const sparkTone = (p) => (!p.enabled || !p.speedAct ? 'tone-accent' : p.speedAct >= 6 ? 'tone-up' : 'tone-fast');
const ratesOf = (p, fmt) => [h('span', { class: 'dir rx' }, '↓ ', fmt(p.rxKbps)), h('span', { class: 'dir tx' }, '↑ ', fmt(p.txKbps))];

function hero() {
  const title = h('h1', null, '交换机');
  const tags = h('div', { class: 'chips' });
  const connText = h('span');
  const conn = h('span', { class: 'conn' }, h('i', { class: 'dot' }), connText);
  const cell = (label, plain = false) => {
    const value = h('div', { class: `v${plain ? ' plain' : ''}` }, '—');
    return { el: h('div', { class: 'hero-item' }, h('div', { class: 'k' }, label), value), set: (text) => void (value.textContent = text || '—') };
  };
  const c = {
    firmware: cell('固件版本', true), hardware: cell('硬件版本'), mac: cell('MAC 地址'), ip: cell('IP 地址'), mask: cell('子网掩码'),
    gateway: cell('默认网关'), dns: cell('DNS 服务器'), uptime: cell('运行时间'),
  };
  let tagKey = '';
  return {
    el: h('div', { class: 'hero' },
      h('div', { class: 'hero-top' }, title, tags, h('span', { class: 'spacer' }), conn),
      h('div', { class: 'hero-grid' }, Object.values(c).map((x) => x.el))),
    update(data, stale, hardware) {
      const d = data.device;
      title.textContent = d.model || '交换机';
      const key = `${data.cloud.enabled}|${data.cloud.connected}|${d.dhcp}|${data.flags.qvlanEnabled}|${data.flags.loopEnabled}`;
      if (key !== tagKey) {
        tagKey = key;
        tags.replaceChildren(...kids([
          !data.cloud.enabled ? badge('云管理未启用') : data.cloud.connected ? badge('云管理已连接', 'ok', { dot: true }) : badge('云管理未连接', 'warn', { dot: true }),
          badge(d.dhcp ? 'DHCP' : '静态 IP', 'outline'),
          data.flags.qvlanEnabled ? badge('802.1Q VLAN', 'accent') : null,
          data.flags.loopEnabled ? badge('环回保护', 'accent') : null,
        ]));
      }
      c.firmware.set(d.firmware);
      c.hardware.set(hardware);
      c.mac.set(d.mac);
      c.ip.set(d.ip);
      c.mask.set(d.netmask);
      c.gateway.set(d.gateway);
      c.dns.set(d.dns && (d.dnsAuto ? `${d.dns} (自动)` : d.dns));
      conn.className = `conn${stale ? ' stale' : ''}`;
      connText.textContent = stale ? '刷新失败，显示的是上次的数据' : `每 ${POLL_MS / 1000} 秒自动刷新`;
    },
    tick(seconds) {
      c.uptime.set(seconds != null && uptime(seconds).text);
    },
  };
}

function portTile(buffer, onSelect) {
  const j = jack();
  const spark = sparkline();
  const lag = h('span', { class: 'row' });
  const number = h('span');
  const speed = h('div', { class: 'speed' });
  const rates = h('div', { class: 'rates' });
  const el = h('button', { type: 'button', class: 'port-tile', 'aria-pressed': 'false', onclick: onSelect }, j,
    h('div', { class: 'meta' }, h('div', { class: 'name' }, number, lag), speed, rates), spark);
  return {
    el,
    select(on) {
      el.setAttribute('aria-pressed', String(on));
    },
    update(p) {
      j.update(p);
      number.textContent = `端口 ${p.id}`;
      lag.replaceChildren(...kids([p.lag ? badge(`LAG${p.lag}`, 'info') : null]));
      const tone = !p.enabled ? '' : linkTone(p.speedAct);
      let text = p.enabled ? SPEED_ACT[p.speedAct] : '已禁用';
      let cls = tone;
      if (p.enabled && p.loop === 'blocked') {
        text = '环回阻塞';
        cls = 'danger';
      } else if (p.enabled && p.loop === 'normal' && p.speedAct) {
        text += ' · 环回正常';
      }
      speed.textContent = text;
      speed.className = `speed ${cls}`;
      rates.replaceChildren(...kids(ratesOf(p, rateShort)));
      spark.tone(sparkTone(p));
      spark.update(buffer.rx.map((v, i) => v + buffer.tx[i]));
    },
  };
}

const stat = (label, dotColor, value) => h('div', { class: 'stat' },
  h('div', { class: 'label' }, dotColor ? h('i', { class: 'dot', style: { color: dotColor } }) : null, label), h('div', { class: 'value' }, value));

export default {
  id: 'overview',
  async render(ctx) {
    const root = h('div', null, loading(6));
    const state = { data: null, selected: null, stale: false, fetchedAt: 0, uptimeAtFetch: 0, hardware: null };
    const history = new Map(); // 端口 → { rx: [], tx: [] }
    const totals = { rx: [], tx: [] };
    const parts = {}; // 轮询时原地更新的节点

    const push = (data) => {
      let rx = 0;
      let tx = 0;
      for (const p of data.ports) {
        const b = history.get(p.id) ?? { rx: [], tx: [] };
        b.rx.push(p.rxKbps);
        b.tx.push(p.txKbps);
        if (b.rx.length > MAX_POINTS) {
          b.rx.shift();
          b.tx.shift();
        }
        history.set(p.id, b);
        rx += p.rxKbps;
        tx += p.txKbps;
      }
      totals.rx.push(rx);
      totals.tx.push(tx);
      if (totals.rx.length > MAX_POINTS) {
        totals.rx.shift();
        totals.tx.shift();
      }
    };

    const current = () => state.data.ports.find((p) => p.id === state.selected) ?? state.data.ports[0];

    function detailCard(p) {
      const info = h('dl', { class: 'kv' });
      const speed = select(
        Object.entries(SPEED_CFG).filter(([v]) => Number(v) <= (state.data.support2_5G ? 7 : 6)),
        p.speedCfg, { 'aria-label': '速率 / 双工' });
      const apply = button('应用', {
        variant: 'primary', icon: 'check',
        onClick: async () => {
          const value = Number(speed.value);
          const res = await ctx.apply('port.quick', { port: p.id, speed: value }, {
            confirm: value === 0
              ? { title: `禁用端口 ${p.id}？`, message: '关闭端口会立即断开该端口上的链路。如果你正在通过这个端口管理交换机，本面板会随之失联，需要从其它端口重新连接。', confirmText: '禁用' }
              : undefined,
            success: '端口配置已应用',
          });
          if (res) await refresh();
        },
      });
      const el = card({
        title: `端口 ${p.id}`,
        sub: '点击上方端口可切换',
        icon: 'jack',
        body: h('div', { class: 'grid two' },
          info,
          h('div', { class: 'stack' },
            h('div', { class: 'field' }, h('span', { class: 'field-label' }, '速率 / 双工'), speed,
              h('div', { class: 'hint' }, '选择“关闭”即禁用该端口；修改立即生效，链路可能重新协商。')),
            h('div', { class: 'row' }, apply, button('报文统计', { icon: 'activity', onClick: () => ctx.navigate('ports.stats', { port: p.id }) })))),
      });
      return {
        el,
        update(q) {
          info.replaceChildren(...kv([
            ['状态', q.enabled ? '启用' : '禁用'],
            ['实际链路', q.enabled ? SPEED_ACT[q.speedAct] : '—'],
            ['流控', `配置${q.flowCfg ? '开启' : '关闭'} · 实际${q.flowAct ? '开启' : '关闭'}`],
            ...(state.data.flags.showVlan ? [['802.1Q VLAN', q.vlans?.length ? portRanges(q.vlans) : '—']] : []),
            ['环回保护', LOOP[q.loop] ?? '—'],
            ['实时速率', h('span', { class: 'rates' }, ratesOf(q, rate))],
          ]).children);
          if (document.activeElement !== speed) speed.value = String(q.speedCfg);
        },
      };
    }

    // 注意不能叫 select: 会和组件库导入的下拉框 select() 重名
    function selectPort(id) {
      if (!state.data) return;
      state.selected = id;
      for (const [pid, tile] of parts.tiles) tile.select(pid === id);
      parts.detail = detailCard(current());
      parts.detailBox.replaceChildren(parts.detail.el);
      parts.detail.update(current());
    }

    function paint(data) {
      parts.hero = hero();
      parts.stat = { up: h('span'), rx: h('span'), tx: h('span'), lag: h('span') };
      parts.chart = areaChart([RX, TX]);
      parts.tiles = new Map();
      parts.detailBox = h('div');
      root.replaceChildren(
        h('div', { class: 'page-head' },
          h('div', null, h('h1', null, '概览'), h('div', { class: 'desc' }, '设备与端口的实时状态')),
          h('div', { class: 'actions' }, button('原厂页面', { icon: 'external', href: `${ctx.switchUrl}/` }))),
        parts.hero.el,
        h('div', { class: 'stats' },
          stat('在线端口', null, parts.stat.up), stat('总接收', 'var(--up)', parts.stat.rx), stat('总发送', 'var(--info)', parts.stat.tx), stat('链路汇聚', null, parts.stat.lag)),
        card({
          title: '端口面板', icon: 'jack',
          sub: '绿 = 千兆及以上 · 琥珀 = 10/100M · 虚线 = 已禁用 · 红 = 环回阻塞',
          body: h('div', {
            class: 'port-grid',
            // 8 口及以下排成整齐的 4 列 (2 行), 口数多时自动填充
            style: data.ports.length <= 8 ? { 'grid-template-columns': `repeat(${Math.min(4, data.ports.length)}, minmax(0, 1fr))` } : null,
          }, data.ports.map((p) => {
            const tile = portTile(history.get(p.id) ?? { rx: [], tx: [] }, () => selectPort(p.id));
            parts.tiles.set(p.id, tile);
            return tile.el;
          })),
        }),
        card({ title: '流量趋势', icon: 'activity', sub: '全部端口的收发速率合计', body: parts.chart }),
        parts.detailBox,
      );
      parts.stat.lag.textContent = `${new Set(data.ports.filter((p) => p.lag).map((p) => p.lag)).size} / ${data.flags.maxLag}`;
    }

    function patch(data) {
      parts.hero.update(data, state.stale, state.hardware);
      parts.hero.tick(state.uptimeAtFetch + (Date.now() - state.fetchedAt) / 1000); // 运行时间不等下一秒的计时器, 数据一到就更新
      parts.stat.up.textContent = `${data.ports.filter((p) => p.enabled && p.speedAct).length} / ${data.ports.length}`;
      parts.stat.rx.textContent = rate(totals.rx.at(-1) ?? 0);
      parts.stat.tx.textContent = rate(totals.tx.at(-1) ?? 0);
      for (const p of data.ports) parts.tiles.get(p.id)?.update(p);
      parts.chart.update(totals, (Math.max(2, totals.rx.length) - 1) * (POLL_MS / 1000));
      parts.detail?.update(current());
    }

    async function refresh() {
      const res = await ctx.api.overview();
      const first = !state.data;
      state.data = res.data;
      state.stale = false;
      state.fetchedAt = Date.now();
      state.uptimeAtFetch = res.data.device.uptime ?? 0;
      push(res.data);
      ctx.setOverview(res.data);
      if (first) {
        try {
          state.hardware = (await ctx.api.pages('system')).system?.hardware ?? null; // 硬件版本只在系统信息页里有
        } catch {
          state.hardware = null; // 取不到就留空, 不影响其它信息
        }
        paint(res.data);
        selectPort(res.data.ports.find((p) => p.speedAct)?.id ?? 1);
      }
      patch(res.data);
    }

    ctx.every(() => parts.hero?.tick(state.uptimeAtFetch + (Date.now() - state.fetchedAt) / 1000), 1000);
    ctx.poll(async () => {
      try {
        await refresh();
      } catch (err) {
        if (!state.data) {
          root.replaceChildren(errorState(err, ctx.reload));
          return;
        }
        state.stale = true;
        parts.hero.update(state.data, true, state.hardware);
      }
    }, POLL_MS);
    return root;
  },
};
