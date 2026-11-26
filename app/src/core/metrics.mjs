// Prometheus 指标: 把后台轮询的缓存整理成文本格式 (text/plain; version=0.0.4)。
// 只读内存里的数据, 不访问设备 —— 抓取再频繁也不会增加交换机的负担。
//
// 标签: device = 设备 id (稳定, 不随改名变化), name = 设备名称, port = 端口号。
// 连不上 (离线 / 凭据失效 / 出错) 的设备只输出 switch_up 0 和静态信息;
// 它的端口状态是最后一次成功轮询时的旧数据, 不当作当前值导出。

import { linkMbps } from './models.mjs';

const ONLINE = 'online';
const DOWN = ['offline', 'auth', 'error']; // switch_up 0
const BYTES = 1000 / 8; // Kbps → 字节 / 秒

/** 标签值转义: 反斜杠、双引号、换行。 */
const esc = (value) => String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
// 没有标签时不输出花括号 (netpanel_up 1, 而不是 netpanel_up{} 1)
const labels = (obj) => (Object.keys(obj).length ? `{${Object.entries(obj).map(([k, v]) => `${k}="${esc(v)}"`).join(',')}}` : '');
const fmt = (value) => (Number.isFinite(value) ? (Number.isInteger(value) ? String(value) : value.toFixed(3)) : 'NaN');

/**
 * @param {Array<{device: object, ports: object[], stats: object[], overviewAt: number|null, statsAt: number}>} devices  manager.metricsSnapshot()
 * @param {{ now?: number, version?: string }} opts
 * @returns {string}
 */
export function renderMetrics(devices, { now = Date.now(), version = 'unknown' } = {}) {
  const out = [];
  const live = devices.filter((d) => d.device.health === ONLINE);
  const id = (d) => ({ device: d.device.id, name: d.device.name });
  const port = (d, p) => ({ ...id(d), port: String(p.id) });
  const byHealth = (state) => devices.filter((d) => d.device.health === state).length;

  /** 一个指标族: HELP、TYPE 紧跟着它的全部样本 —— 声明和样本在结构上不可能被别的指标隔开。 */
  const group = (type, name, help, rows) => {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [labelObj, value] of rows) out.push(`${name}${labels(labelObj)} ${fmt(value)}`);
  };

  group('gauge', 'netpanel_up', 'NetPanel 面板是否在运行 (恒为 1)。', [[{}, 1]]);
  group('gauge', 'netpanel_build_info', '面板版本。', [[{ version }, 1]]);
  group('gauge', 'netpanel_devices', '按健康状态统计的设备数: online / offline / auth (凭据失效) / error / disabled / unknown。',
    ['online', 'offline', 'auth', 'error', 'disabled', 'unknown'].map((state) => [{ health: state }, byHealth(state)]).filter(([, n]) => n));

  group('gauge', 'switch_up', '设备最近一次轮询是否成功: 1 = 在线, 0 = 离线 / 凭据失效 / 出错。还没轮询过和已停用的设备不输出。',
    devices.filter((d) => d.device.health === ONLINE || DOWN.includes(d.device.health)).map((d) => [id(d), d.device.health === ONLINE ? 1 : 0]));

  group('gauge', 'switch_info', '设备信息 (值恒为 1)。', devices.map((d) => [{
    ...id(d),
    adapter: d.device.adapter,
    vendor: d.device.vendor ?? '',
    model: d.device.model ?? '',
    firmware: d.device.firmware ?? '',
    hardware: d.device.identified?.hardware ?? '',
  }, 1]));

  group('gauge', 'switch_last_poll_timestamp_seconds', '最近一次成功轮询的时间 (Unix 秒); 从未成功过则不输出。',
    devices.filter((d) => d.overviewAt).map((d) => [id(d), Math.floor(d.overviewAt / 1000)]));

  group('gauge', 'switch_uptime_seconds', '设备开机以来的秒数。', live.filter((d) => d.device.uptime != null).map((d) => [id(d), d.device.uptime]));
  group('gauge', 'switch_ports_up', '有链路的端口数。', live.map((d) => [id(d), d.device.portsUp]));
  group('gauge', 'switch_rx_rate_bytes', '全部端口接收速率合计, 字节 / 秒。', live.map((d) => [id(d), d.device.rxKbps * BYTES]));
  group('gauge', 'switch_tx_rate_bytes', '全部端口发送速率合计, 字节 / 秒。', live.map((d) => [id(d), d.device.txKbps * BYTES]));
  group('gauge', 'switch_cloud_enabled', '是否启用了云管理 (TP-LINK 商用网络云平台 / NMS)。', live.map((d) => [id(d), d.device.cloud?.enabled ? 1 : 0]));
  group('gauge', 'switch_cloud_connected', '云管理是否已连接。', live.map((d) => [id(d), d.device.cloud?.connected ? 1 : 0]));

  const allPorts = live.flatMap((d) => d.ports.map((p) => [d, p]));
  const gauge = (name, help, value) => group('gauge', name, help, allPorts.map(([d, p]) => [port(d, p), value(p)]));
  gauge('switch_port_enabled', '端口是否启用。', (p) => (p.enabled ? 1 : 0));
  gauge('switch_port_up', '端口是否有链路。', (p) => (p.speedAct ? 1 : 0));
  gauge('switch_port_speed_bytes', '端口实际链路速率, 字节 / 秒 (没有链路时为 0)。', (p) => linkMbps(p.speedAct) * 1e6 / 8);
  gauge('switch_port_lag', '端口所在的汇聚组编号 (0 = 不在任何汇聚组)。', (p) => p.lag ?? 0);
  gauge('switch_port_rx_rate_bytes', '端口接收速率, 字节 / 秒。', (p) => (p.rxKbps ?? 0) * BYTES);
  gauge('switch_port_tx_rate_bytes', '端口发送速率, 字节 / 秒。', (p) => (p.txKbps ?? 0) * BYTES);

  const withStats = live.filter((d) => d.stats.length);
  const statRows = (pick) => withStats.flatMap((d) => d.stats.map((s) => [port(d, s), pick(s)]));
  group('counter', 'switch_port_rx_packets_total', '端口累计接收的正常包数 (设备重启后清零)。', statRows((s) => s.rxGood ?? 0));
  group('counter', 'switch_port_tx_packets_total', '端口累计发送的正常包数 (设备重启后清零)。', statRows((s) => s.txGood ?? 0));
  group('counter', 'switch_port_rx_errors_total', '端口累计接收的错误包数 (设备重启后清零)。', statRows((s) => s.rxBad ?? 0));
  group('counter', 'switch_port_tx_errors_total', '端口累计发送的错误包数 (设备重启后清零)。', statRows((s) => s.txBad ?? 0));
  group('gauge', 'switch_port_stats_age_seconds', '端口统计数据距现在多少秒 (统计的轮询间隔比概览长)。',
    withStats.flatMap((d) => d.stats.map((s) => [port(d, s), d.statsAt ? (now - d.statsAt) / 1000 : 0])));

  return `${out.join('\n')}\n`;
}
