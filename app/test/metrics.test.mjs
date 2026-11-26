// Prometheus 指标: 格式正确 (每个指标 HELP、TYPE、样本连续成组, 数值格式合法)、数值换算、标签转义、离线设备只输出静态信息。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderMetrics } from '../src/core/metrics.mjs';
import { linkMbps } from '../src/core/models.mjs';

const device = (over = {}) => ({
  id: 'd_0123456789',
  name: '客厅',
  adapter: 'tplink-rpm',
  vendor: 'TP-LINK',
  model: 'TL-SG2008D',
  firmware: '1.8.1',
  identified: { hardware: '3.0' },
  health: 'online',
  uptime: 965852,
  portsUp: 2,
  rxKbps: 1000,
  txKbps: 8000,
  cloud: { enabled: true, connected: false },
  ...over,
});
const snap = (dev, ports = [], stats = [], extra = {}) => ({ device: dev, ports, stats, overviewAt: 1_700_000_000_000, statsAt: 1_700_000_000_000, ...extra });
const NOW = { now: 1_700_000_000_000 };
const PORTS = [
  { id: 1, enabled: true, speedAct: 6, lag: 0, rxKbps: 800, txKbps: 7000 },
  { id: 2, enabled: true, speedAct: 5, lag: 1, rxKbps: 200, txKbps: 1000 },
  { id: 3, enabled: false, speedAct: 0, lag: 0, rxKbps: 0, txKbps: 0 },
];
const STATS = [
  { id: 1, rxGood: 10, txGood: 20, rxBad: 1, txBad: 2 },
  { id: 2, rxGood: 30, txGood: 40, rxBad: 3, txBad: 4 },
];

/**
 * 把文本解析成 Map<指标名, { help, type, samples }>, 顺便严格校验格式: 每一行都合法;
 * 每个指标都是 "HELP、TYPE、若干样本" 连续成组, 组与组之间不穿插别的指标 (Prometheus 文本格式的要求)。
 */
function parse(text) {
  const families = new Map();
  const lines = text.split('\n');
  assert.equal(lines.at(-1), '', '以换行结尾');
  assert.ok(!text.endsWith('\n\n'), '结尾不多一个空行');
  let current = null; // 正在读哪个指标的组
  for (const line of lines.slice(0, -1)) {
    assert.doesNotMatch(line, /\{\} /, '没有标签时不应该出现空的花括号');
    if (line.startsWith('#')) {
      const m = /^# (HELP|TYPE) ([a-zA-Z_:][a-zA-Z0-9_:]*) (.+)$/.exec(line);
      assert.ok(m, `注释行格式不对: ${line}`);
      if (m[1] === 'HELP') {
        assert.equal(families.has(m[2]), false, `${m[2]} 声明了两次`);
        current = { name: m[2], help: m[3], samples: [] };
        families.set(m[2], current);
      } else {
        assert.equal(m[2], current?.name, `TYPE ${m[2]} 前面不是它的 HELP`);
        assert.match(m[3], /^(gauge|counter)$/, `${m[2]} 的 TYPE 不合法: ${m[3]}`);
        current.type = m[3];
      }
      continue;
    }
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{((?:[^"{}]|"(?:[^"\\]|\\.)*")*)\})? (NaN|\+?Inf|-Inf|[+-]?(?:\d+(?:\.\d+)?(?:[eE][+-]?\d+)?))$/.exec(line);
    assert.ok(m, `样本行格式不对: ${line}`);
    assert.ok(current?.type, `样本 ${m[1]} 出现在任何声明之前`);
    assert.equal(m[1], current.name, `样本 ${m[1]} 插在了 ${current.name} 的组里`);
    const unescape = (v) => v.replace(/\\(["\\n])/g, (_, c) => (c === 'n' ? '\n' : c)); // 与渲染时的转义相反
    const labels = Object.fromEntries([...(m[3] ?? '').matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)].map((x) => [x[1], unescape(x[2])]));
    current.samples.push({ labels, value: m[4] });
  }
  return families;
}

test('格式: 每个指标都是 HELP、TYPE、样本连续成组; 数值格式合法; 无标签时不带花括号', () => {
  const families = parse(renderMetrics([snap(device(), PORTS, STATS)], NOW));
  assert.deepEqual([...families.keys()].slice(0, 4), ['netpanel_up', 'netpanel_build_info', 'netpanel_devices', 'switch_up']);
  for (const [name, f] of families) assert.match(f.type, /^(gauge|counter)$/, `${name} 缺少 TYPE`);
  assert.equal(families.get('switch_port_rx_packets_total').type, 'counter');
  assert.equal(families.get('switch_up').type, 'gauge');
  assert.match(renderMetrics([]), /^netpanel_up 1$/m);
});

test('在线设备: 设备级与端口级指标的数值和换算 (Kbps → 字节 / 秒, 链路速率 → 字节 / 秒)', () => {
  const families = parse(renderMetrics([snap(device(), PORTS, STATS)], NOW));
  const one = (name) => {
    const s = families.get(name).samples;
    assert.equal(s.length, 1, name);
    return s[0];
  };
  const id = { device: 'd_0123456789', name: '客厅' };
  assert.deepEqual(one('switch_up'), { labels: id, value: '1' });
  assert.equal(one('switch_info').value, '1');
  assert.equal(one('switch_info').labels.model, 'TL-SG2008D');
  assert.equal(one('switch_info').labels.firmware, '1.8.1');
  assert.equal(one('switch_info').labels.hardware, '3.0');
  assert.equal(one('switch_uptime_seconds').value, '965852');
  assert.equal(one('switch_last_poll_timestamp_seconds').value, '1700000000');
  assert.equal(one('switch_ports_up').value, '2');
  assert.equal(one('switch_rx_rate_bytes').value, '125000'); // 1000 Kbps
  assert.equal(one('switch_tx_rate_bytes').value, '1000000'); // 8000 Kbps
  assert.equal(one('switch_cloud_enabled').value, '1');
  assert.equal(one('switch_cloud_connected').value, '0');

  const port = (name, p) => families.get(name).samples.find((s) => s.labels.port === String(p));
  assert.equal(port('switch_port_enabled', 3).value, '0');
  assert.equal(port('switch_port_up', 1).value, '1');
  assert.equal(port('switch_port_up', 3).value, '0');
  assert.equal(port('switch_port_speed_bytes', 1).value, '125000000'); // 1000M
  assert.equal(port('switch_port_speed_bytes', 2).value, '12500000'); // 100M
  assert.equal(port('switch_port_lag', 2).value, '1');
  assert.equal(port('switch_port_rx_rate_bytes', 1).value, '100000'); // 800 Kbps
  assert.equal(port('switch_port_tx_rate_bytes', 1).value, '875000'); // 7000 Kbps
  assert.equal(port('switch_port_rx_packets_total', 2).value, '30');
  assert.equal(port('switch_port_tx_packets_total', 2).value, '40');
  assert.equal(port('switch_port_rx_errors_total', 2).value, '3');
  assert.equal(port('switch_port_tx_errors_total', 2).value, '4');
  assert.equal(port('switch_port_stats_age_seconds', 1).value, '0'); // now 与 statsAt 相同
  assert.equal(families.get('switch_port_rx_packets_total').samples.length, STATS.length, '统计只输出有数据的端口');
  assert.equal(families.get('switch_port_up').samples.length, PORTS.length);

  const aged = parse(renderMetrics([snap(device(), PORTS, STATS, { statsAt: 1_700_000_000_000 - 12_500 })], NOW));
  assert.equal(aged.get('switch_port_stats_age_seconds').samples[0].value, '12.500');
});

test('linkMbps: 实际链路代码 → Mbps', () => {
  assert.equal(linkMbps(6), 1000);
  assert.equal(linkMbps(5), 100);
  assert.equal(linkMbps(7), 2500);
  assert.equal(linkMbps(0), 0);
  assert.equal(linkMbps(undefined), 0);
});

test('离线设备只输出 switch_up 0 和静态信息, 不把旧的端口数据当成当前值', () => {
  const families = parse(renderMetrics([snap(device(), PORTS, STATS), snap(device({ id: 'd_offline000', health: 'offline' }), PORTS, STATS)], NOW));
  assert.deepEqual(families.get('switch_up').samples.map((s) => s.value), ['1', '0']);
  assert.equal(families.get('switch_info').samples.length, 2);
  assert.equal(families.get('switch_port_up').samples.length, PORTS.length, '只有在线设备的端口');
  assert.equal(families.get('switch_uptime_seconds').samples.length, 1);
  assert.equal(families.get('switch_last_poll_timestamp_seconds').samples.length, 2, '最后成功轮询时间仍然有用');
  assert.equal(families.get('netpanel_devices').samples.find((s) => s.labels.health === 'offline').value, '1');
});

test('离线 / 凭据失效 / 出错都是 switch_up 0; 还没轮询过和已停用的设备不输出 switch_up', () => {
  const families = parse(renderMetrics(['offline', 'auth', 'error', 'unknown', 'disabled'].map((health) => snap(device({ id: `d_${health}0000000`.slice(0, 12), health })))), NOW);
  assert.deepEqual(families.get('switch_up').samples.map((s) => s.value), ['0', '0', '0']);
  const counts = Object.fromEntries(families.get('netpanel_devices').samples.map((s) => [s.labels.health, s.value]));
  assert.deepEqual(counts, { offline: '1', auth: '1', error: '1', disabled: '1', unknown: '1' });
});

test('标签值转义: 引号、反斜杠、换行', () => {
  const families = parse(renderMetrics([snap(device({ name: 'a"b\\c\nd', model: 'M"1' }))], NOW));
  assert.equal(families.get('switch_info').samples[0].labels.name, 'a"b\\c\nd');
  assert.equal(families.get('switch_info').samples[0].labels.model, 'M"1');
});

test('缺失的数据: 没有运行时间 / 没轮询成功过 / 数值不是有限数', () => {
  const families = parse(renderMetrics([snap(device({ uptime: null, rxKbps: NaN }), [{ id: 1, enabled: true, speedAct: 6 }], [], { overviewAt: null })], NOW));
  assert.equal(families.get('switch_uptime_seconds').samples.length, 0);
  assert.equal(families.get('switch_last_poll_timestamp_seconds').samples.length, 0);
  assert.equal(families.get('switch_rx_rate_bytes').samples[0].value, 'NaN');
  assert.equal(families.get('switch_port_rx_rate_bytes').samples[0].value, '0', '端口缺少速率字段时按 0');
  assert.equal(families.get('switch_port_rx_packets_total').samples.length, 0, '还没有统计数据时不输出计数器');
});

test('面板自身的指标', () => {
  const families = parse(renderMetrics([], { version: '1.2.3' }));
  assert.equal(families.get('netpanel_up').samples[0].value, '1');
  assert.equal(families.get('netpanel_build_info').samples[0].labels.version, '1.2.3');
  assert.equal(families.get('netpanel_devices').samples.length, 0, '没有设备时没有样本, 但声明仍然在 (指标名保持稳定)');
});
