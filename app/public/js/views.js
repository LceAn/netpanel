// 页面注册表与侧边栏导航结构。

import overview from './views/overview.js';
import { config, stats } from './views/ports.js';
import { info, ip, user, cloud } from './views/system.js';
import { tools, firmware } from './views/tools.js';
import { lag, isolation, mac } from './views/switching.js';
import { mirror, cable, loop } from './views/monitor.js';
import { q, pvid, port, mtu } from './views/vlan.js';
import { basic, bandwidth, storm } from './views/qos.js';

/** [页面 id, 菜单文字, 图标] */
export const NAV = [
  { label: null, items: [['overview', '概览', 'grid']] },
  {
    label: '系统',
    items: [
      ['system.info', '系统信息', 'cpu'], ['system.ip', 'IP 设置', 'settings'], ['system.user', '账户设置', 'user'],
      ['system.cloud', '云管理', 'cloud'], ['system.tools', '系统工具', 'save'], ['system.firmware', '固件升级', 'upload'],
    ],
  },
  {
    label: '二层交换',
    items: [['ports.config', '端口配置', 'list'], ['sw.lag', '链路聚合', 'swap'], ['sw.isolation', '端口隔离', 'shield'], ['sw.mac', 'MAC 搜索', 'search']],
  },
  {
    label: '监控',
    items: [['ports.stats', '端口统计', 'activity'], ['mon.mirror', '端口镜像', 'eye'], ['mon.cable', '线缆检测', 'cable'], ['mon.loop', '环回保护', 'undo']],
  },
  {
    label: 'VLAN',
    items: [['vlan.8021q', '802.1Q VLAN', 'layers'], ['vlan.pvid', 'PVID 设置', 'list'], ['vlan.port', '端口 VLAN', 'layers'], ['vlan.mtu', 'MTU VLAN', 'layers']],
  },
  {
    label: 'QoS',
    items: [['qos.basic', 'QoS 模式与优先级', 'gauge'], ['qos.bandwidth', '带宽控制', 'activity'], ['qos.storm', '风暴抑制', 'shield']],
  },
];

export const VIEWS = {
  overview,
  'system.info': info,
  'system.ip': ip,
  'system.user': user,
  'system.cloud': cloud,
  'system.tools': tools,
  'system.firmware': firmware,
  'ports.config': config,
  'ports.stats': stats,
  'sw.lag': lag,
  'sw.isolation': isolation,
  'sw.mac': mac,
  'mon.mirror': mirror,
  'mon.cable': cable,
  'mon.loop': loop,
  'vlan.8021q': q,
  'vlan.pvid': pvid,
  'vlan.port': port,
  'vlan.mtu': mtu,
  'qos.basic': basic,
  'qos.bandwidth': bandwidth,
  'qos.storm': storm,
};

export const TITLES = Object.fromEntries(NAV.flatMap((g) => g.items).map(([id, label]) => [id, label]));

/** 页面 id → 地址栏 hash。overview → #/overview，ports.stats → #/ports/stats */
export const hashOf = (id, params) => `#/${id.replace(/\./g, '/')}${params && Object.keys(params).length ? `?${new URLSearchParams(params)}` : ''}`;

/** 地址栏 hash → { id, params } */
export function parseHash(hash) {
  const [path, query] = String(hash).replace(/^#\/?/, '').split('?');
  const id = path.replace(/\//g, '.') || 'overview';
  return { id: Object.hasOwn(VIEWS, id) ? id : 'overview', params: Object.fromEntries(new URLSearchParams(query ?? '')) };
}
