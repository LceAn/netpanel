// 固件里的枚举码、单位换算和文案。取值含义均来自原厂页面的 JS。

/** 端口"配置"速率/双工 (spd_cfg)。0 = 关闭。 */
export const SPEED_CFG = { 0: '关闭', 1: '自动', 2: '10M 半双工', 3: '10M 全双工', 4: '100M 半双工', 5: '100M 全双工', 6: '1000M 全双工', 7: '2.5G 全双工' };

/** 端口"实际"速率/双工 (spd_act)。0 = 断开。 */
export const SPEED_ACT = { ...SPEED_CFG, 0: '断开' };

/** 链路指示灯配色: 千兆及以上绿色, 10/100M 琥珀 (与原厂端口图一致)。 */
export function linkTone(speedAct) {
  if (!speedAct) return '';
  return speedAct >= 6 ? 'up-g' : 'up-f';
}

export const ONOFF = { 0: '关闭', 1: '开启' };
export const QOS_MODE = { 0: '基于端口', 1: '基于 802.1P', 2: '基于 DSCP' };
export const PRIORITY = { 1: '1（最低）', 2: '2（正常）', 3: '3（中等）', 4: '4（最高）' };
export const STORM_TYPES = { 1: '未知单播', 2: '组播', 4: '广播' };
export const LOOP = { off: '未启用', down: '—', normal: '正常', blocked: '阻塞' };

/** 线缆检测结果 (cablestate)。 */
export const CABLE = { '-1': '未检测', 0: '无线缆', 1: '正常', 2: '开路', 3: '短路', 4: '开路 & 短路', 5: '阻抗失配', 6: '不支持' };

/** 单端口统计明细的 20 项: 0-3 正常报文, 4-8 异常报文。 */
export const PKT_TYPES = ['单播', '组播', '广播', 'Pause 帧', '小于 64 字节', 'CRC 错误', 'Fragments', 'Jabbers', 'Collisions'];

/** 速率 (Kbps) → 人类可读。 */
export function rate(kbps) {
  if (!kbps) return '0';
  if (kbps < 1000) return `${kbps} Kbps`;
  if (kbps < 1e6) return `${(kbps / 1000).toFixed(kbps < 10000 ? 2 : 1)} Mbps`;
  return `${(kbps / 1e6).toFixed(2)} Gbps`;
}

/** 端口卡片用的紧凑速率: "40K" / "1.2M" / "2.5G" (卡片窄, 放不下完整单位)。 */
export function rateShort(kbps) {
  if (!kbps) return '0';
  if (kbps < 1000) return `${Math.round(kbps)}K`;
  if (kbps < 1e6) return `${+(kbps / 1000).toFixed(kbps < 10000 ? 2 : 1)}M`;
  return `${(kbps / 1e6).toFixed(2)}G`;
}

/** 报文数: 大数用 万/亿, 表格里不撑宽。 */
export function packets(n) {
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)} 亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)} 万`;
  return String(n);
}

export const full = (n) => n.toLocaleString('zh-CN');

/** 秒数 → { d, h, m, s, text }。 */
export function uptime(seconds) {
  const t = Math.max(0, Math.floor(seconds ?? 0));
  const d = Math.floor(t / 86400);
  const h = Math.floor((t % 86400) / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return { d, h, m, s, text: `${d} 天 ${h} 小时 ${m} 分 ${s} 秒` };
}

export const portName = (id, lag) => `端口 ${id}${lag ? ` (LAG${lag})` : ''}`;

/** 端口列表 → "1-4,7" 这样的紧凑写法。 */
export function portRanges(list) {
  const sorted = [...list].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i];
    let end = start;
    while (sorted[i + 1] === end + 1) end = sorted[++i];
    out.push(start === end ? String(start) : `${start}-${end}`);
  }
  return out.join(',') || '—';
}

/** 把原厂的 ipStr / "1-8,10" 形式解析成端口列表。 */
export function parseRanges(text) {
  const out = [];
  for (const part of String(text ?? '').split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) continue;
    for (let p = Number(m[1]); p <= Number(m[2] ?? m[1]); p++) out.push(p);
  }
  return out;
}

/**
 * 从"端口 → 它能转发到的端口"这组规则里, 算出互相隔离的端口对。
 * 隔离按双向理解: 只要有一侧发不到另一侧, 就算互相隔离 (哪怕另一侧的规则里还列着它)。
 * 某一侧没有规则时不提供信息, 以另一侧为准。每对只列一次, 小端口在前。
 */
export function isolatedPairs(rules, portCount) {
  const forwards = new Map(rules.map((rule) => [rule.port ?? rule.id, new Set(parseRanges(rule.forward))]));
  const pairs = [];
  for (let a = 1; a <= portCount; a++) {
    for (let b = a + 1; b <= portCount; b++) {
      const fromA = forwards.get(a);
      const fromB = forwards.get(b);
      if ((fromA && !fromA.has(b)) || (fromB && !fromB.has(a))) pairs.push([a, b]);
    }
  }
  return pairs;
}

export const errText = (err) => (err?.details?.length ? err.details.join('；') : err?.message ?? '未知错误');
