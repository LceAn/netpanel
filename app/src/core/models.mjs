// 规范化读模型: 与具体固件无关的部分。
//
// 每种设备的适配器都要把自己的原始数据整理成这里列出的结构; 前端、命令行、指标导出只认这些结构,
// 不接触设备原始数据。这里只定义"有哪些模型键"和整理数据时共用的纯函数;
// "怎么从设备原始数据得到这些结构"由各适配器自己实现 (见 src/adapters/*)。

/** 数值容错: 设备给的不是有限数字时用默认值 (空字符串也当缺省)。 */
export const num = (v, dflt = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : dflt);

/** 取数组首项 (设备有时给数组、有时给单个值)。 */
export const first = (v) => (Array.isArray(v) ? v[0] : v);

/** 1..n */
export const range = (n) => Array.from({ length: Math.max(0, n | 0) }, (_, i) => i + 1);

/** 生成 count 个元素, 回调拿到的是 0 起始下标 (和 range 区分开, 避免拿 1 起始的序号当数组下标)。 */
export const take = (count, fn) => Array.from({ length: Math.max(0, count | 0) }, (_, i) => fn(i));

export const at = (arr, i) => (Array.isArray(arr) ? arr[i] : undefined);

/** 位掩码里第 port 位 (从 1 数起) 是否置位。按数值除法算, 不受 32 位限制。 */
export function bit(mask, port) {
  return Math.floor(num(mask) / 2 ** (port - 1)) % 2 === 1;
}

/** 位掩码 → 置位的端口列表。 */
export function maskPorts(mask, count) {
  return range(count).filter((p) => bit(mask, p));
}

/** 端口列表 → 位掩码 (第 n 口对应第 n-1 位), 以十进制字符串表示, 不受 32 位限制。 */
export function portsMask(ports) {
  return ports.reduce((m, p) => m | (1n << BigInt(p - 1)), 0n).toString();
}

/** 实际链路速率代码 → Mbps。配置代码 (speedCfg) 是: 0=关闭 1=自动 2..7 同下。 */
export const LINK_MBPS = Object.freeze({ 2: 10, 3: 10, 4: 100, 5: 100, 6: 1000, 7: 2500 });
export const linkMbps = (speedAct) => LINK_MBPS[num(speedAct)] ?? 0;

/** 原厂风格的运行时间文本 "11 day - 4 hour - 17 min - 32 sec" → 秒数; 认不出返回 null。 */
export function uptimeSeconds(text) {
  const m = /(\d+)\s*day\s*-\s*(\d+)\s*hour\s*-\s*(\d+)\s*min\s*-\s*(\d+)\s*sec/i.exec(String(text ?? ''));
  if (!m) return null;
  const [d, h, mi, s] = m.slice(1).map(Number);
  return ((d * 24 + h) * 60 + mi) * 60 + s;
}

/**
 * 规范化模型的键。适配器声明自己能产出其中哪些, 界面据此决定显示哪些页面。
 * 每个键对应一种固定的数据结构, 字段含义见 docs/architecture.md。
 */
export const MODELS = {
  overview: { title: '概览', poll: true },
  ports: { title: '端口配置' },
  stats: { title: '端口统计', poll: true },
  system: { title: '系统信息' },
  ip: { title: 'IP 设置' },
  fixIp: { title: '固定 IP' },
  user: { title: '设备账户' },
  cloud: { title: '云管理' },
  lag: { title: '链路聚合' },
  isolation: { title: '端口隔离' },
  mirror: { title: '端口镜像' },
  loop: { title: '环回保护' },
  cable: { title: '线缆检测' },
  vlanMtu: { title: 'MTU VLAN' },
  vlanPort: { title: '端口 VLAN' },
  vlan8021q: { title: '802.1Q VLAN' },
  vlanPvid: { title: 'PVID' },
  qosBasic: { title: 'QoS 模式' },
  qosBandwidth: { title: '带宽控制' },
  qosStorm: { title: '风暴抑制' },
  firmware: { title: '固件' },
  /** 只作为写操作的结果模型出现 (MAC 搜索), 不是可以单独读取的页面。 */
  macSearch: { title: 'MAC 搜索结果', resultOnly: true },
};

export const MODEL_KEYS = Object.keys(MODELS);

export const isModelKey = (key) => Object.hasOwn(MODELS, key);
