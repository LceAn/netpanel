// TP-LINK JetStream 交换机较新固件 (3.x) 的读取模型: 把 JSON 接口的数据整理成规范结构。
//
// 实验性: 字段名来自公开的逆向资料; 几处取值编码 (端口状态、速率、双工、运行时间的格式) 是推测的,
// 下面都标了"未验证"。所以这个适配器只提供读取, 不提供任何写操作。

import { num, portsMask } from '../../core/models.mjs';

const str = (v) => (typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v));
/** 这类设备的计数常是带千位逗号的字符串 ("1,234,567"): 去掉逗号再转数字。 */
const n = (v, dflt = 0) => {
  const x = typeof v === 'string' ? Number(v.replace(/[,\s]/g, '')) : Number(v);
  return Number.isFinite(x) ? x : dflt;
};

/** "1/0/3" → 3 (1 号单元、0 号槽位的第 3 个口)。其它单元 / 槽位的端口暂不支持, 返回 null。 */
export function portNumber(name) {
  const m = /^1\/0\/(\d+)$/.exec(str(name));
  return m ? Number(m[1]) : null;
}

/** 端口成员列表 → 端口号: "1/0/1"、"1/0/1,1/0/4" 或 "1/0/1-1/0/4" (区间写法是推测的, 未验证)。 */
export function portMembers(text) {
  const out = [];
  for (const part of str(text).split(',')) {
    const range = /^(\S+)\s*-\s*(\S+)$/.exec(part.trim());
    const from = portNumber(range ? range[1] : part);
    const to = range ? portNumber(range[2]) : from;
    if (from === null || to === null || to < from || to - from > 256) continue;
    for (let p = from; p <= to; p++) out.push(p);
  }
  return out;
}

// 取值编码 (未验证)。规范编码见 src/core/ops.mjs 文件头:
//   配置速率 speedCfg:  0 = 自动, 2 = 10M, 3 = 100M, 4 = 1000M        双工 (duplexCfg / duplexLink): 1 = 全双工, 2 = 半双工
//   实际速率 speedLink: 1 = 10M, 2 = 100M, 3 = 1000M
const SPEED_CFG = { 2: [3, 2], 3: [5, 4], 4: [6, 6] }; // [全双工, 半双工]
const SPEED_LINK = { 1: 3, 2: 5, 3: 6 };

/** 汇聚组标识 ("1"、"LAG1"、"Trunk1"…) → 组号; 不在任何汇聚组返回 0。 */
const lagOf = (value) => Number(/\d+/.exec(str(value))?.[0]) || 0;

/** 端口列表 (port 接口) 里的一行 → 规范的端口配置 + 实际链路。 */
export function portState(row) {
  const id = portNumber(row?.port ?? row?.key);
  if (!id) return null;
  const cfg = SPEED_CFG[num(row.speedCfg, 0)];
  const speedCfg = !cfg ? 1 : row.duplexCfg === 2 ? cfg[1] : cfg[0]; // 0 = 自动
  // 是否有链路以 linkStatus 为准; speedLink 只决定速率。链路正常但速率代码不认识时按配置速率算
  const up = num(row.linkStatus) === 1;
  const speedAct = up ? SPEED_LINK[num(row.speedLink)] ?? speedCfg : 0;
  return {
    id,
    enabled: num(row.state, 1) === 1, // 未验证: 1 = 启用
    speedCfg,
    speedAct,
    flowCfg: num(row.flowControl) === 1 ? 1 : 0,
    flowAct: up && num(row.flowControl) === 1 ? 1 : 0,
    lag: lagOf(row.lag),
  };
}

/** 运行时间。格式没有文档: 支持 "4d3h12m30s" 这类带单位的写法和 "4:3:12:30" (天:时:分:秒); 认不出返回 null。 */
export function parseUptime(text) {
  const s = str(text);
  const colon = /^(\d+):(\d+):(\d+):(\d+)$/.exec(s);
  if (colon) return ((Number(colon[1]) * 24 + Number(colon[2])) * 60 + Number(colon[3])) * 60 + Number(colon[4]);
  let total = 0;
  let found = false;
  for (const [, value, unit] of s.matchAll(/(\d+)\s*([dhms])/gi)) {
    found = true;
    total += Number(value) * ({ d: 86400, h: 3600, m: 60, s: 1 }[unit.toLowerCase()]);
  }
  return found ? total : null;
}

/** 系统摘要 (systemSummaryConfig 接口) → 规范的"系统信息"和设备信息。 */
export function system(summary) {
  const s = summary ?? {};
  return {
    description: str(s.sys_description),
    mac: str(s.mac_address),
    ip: str(s.ip),
    netmask: str(s.netmask),
    gateway: str(s.gateway),
    firmware: str(s.fw_version),
    // dev_name 是设备名称, 出厂时就是产品型号; 管理员改过名字后这里显示的会是改过的名字
    model: str(s.dev_name) || str(s.sys_description),
    hardware: str(s.hw_version),
    cloudManaged: false,
    supportsCloud: false,
  };
}

/** 概览 = 系统摘要 + 端口列表 (+ 最近一次统计算出来的速率)。 */
export function overview({ summary, portRows, rates }) {
  const ports = (Array.isArray(portRows) ? portRows : []).map(portState).filter(Boolean).sort((a, b) => a.id - b.id);
  const info = system(summary);
  const s = summary ?? {};
  return {
    maxPorts: ports.length,
    support2_5G: false,
    flags: { showVlan: false, showLoop: false, showLag: ports.some((p) => p.lag), qvlanEnabled: false, loopEnabled: false, poePorts: 0, maxLag: 0 },
    device: {
      model: info.model,
      description: info.description,
      mac: info.mac,
      ip: info.ip,
      netmask: info.netmask,
      gateway: info.gateway,
      dns: '',
      dhcp: false,
      dnsAuto: false,
      firmware: info.firmware,
      uptime: parseUptime(s.run_time),
      uptimeText: str(s.run_time) || null,
      systemTime: s.sys_time ? str(s.sys_time) : null,
    },
    cloud: { enabled: false, connected: false },
    ports: ports.map((p) => ({ ...p, vlans: null, loop: 'off', rxKbps: rates?.get(p.id)?.rx ?? 0, txKbps: rates?.get(p.id)?.tx ?? 0 })),
  };
}

/**
 * 各端口的流量计数 (trafficMonitorCfgDetailModel 接口, 每个端口一次) → 规范的端口统计。
 * 同时用相邻两次的字节计数差算出速率 (Kbps), 供概览使用; 第一次没有上一次的数, 速率为 0。
 */
export function stats(rows, previous, now = Date.now()) {
  const rates = new Map();
  const ports = rows.map(({ row, data }) => {
    const base = portState(row) ?? { id: portNumber(row?.port ?? row?.key), enabled: true };
    const rxBytes = n(data?.bytesRx);
    const txBytes = n(data?.bytesTx);
    const last = previous?.get(base.id);
    const seconds = last ? (now - last.t) / 1000 : 0;
    const rate = (nowBytes, wasBytes) => (last && seconds > 0 && nowBytes >= wasBytes ? ((nowBytes - wasBytes) * 8) / seconds / 1000 : 0);
    const rx = Math.round(rate(rxBytes, last?.rx));
    const tx = Math.round(rate(txBytes, last?.tx));
    rates.set(base.id, { rx, tx });
    return { id: base.id, enabled: base.enabled, link: base.speedAct ?? 0, txGood: n(data?.pktsTx), txBad: n(data?.errorsTx), rxGood: n(data?.pktsRx), rxBad: n(data?.errorsRx), rx, tx };
  });
  return { data: { maxPorts: ports.length, ports: ports.map(({ rx, tx, ...p }) => p) }, rates };
}

/** 802.1Q VLAN 表 (vlanCfg 接口): member1 = Untagged 成员, member2 = Tagged 成员。 */
export function vlanTable(rows, portCount) {
  const vlans = (Array.isArray(rows) ? rows : [])
    .map((r) => ({ id: n(r?.vlanid), name: str(r?.name), tagged: portMembers(r?.member2), untagged: portMembers(r?.member1) }))
    .filter((v) => v.id >= 1 && v.id <= 4094)
    .sort((a, b) => a.id - b.id);
  return { enabled: true, portCount, maxVlans: 0, vlans };
}

/** PVID 表: 每个端口的 PVID (vlanPortCfg 接口) + 已有的 VLAN 及其成员掩码 (vlanCfg 接口)。 */
export function pvidTable({ pvidRows, vlanRows, portCount }) {
  const table = vlanTable(vlanRows, portCount);
  return {
    enabled: true,
    portCount,
    vlans: table.vlans.map((v) => ({ id: v.id, mask: portsMask([...v.tagged, ...v.untagged]) })),
    ports: (Array.isArray(pvidRows) ? pvidRows : [])
      .map((r) => ({ id: portNumber(r?.key ?? r?.port), pvid: n(r?.pvid, 1), lag: lagOf(r?.lag) }))
      .filter((p) => p.id)
      .sort((a, b) => a.id - b.id),
  };
}
