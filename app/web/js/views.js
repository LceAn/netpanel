// 页面注册表、路由与侧边栏导航结构。
//
// 地址 (hash) 分两类:
//   全局页面   #/                  全部设备总览
//              #/devices           设备管理
//              #/devices/new       添加设备
//              #/devices/<id>/edit 修改设备
//              #/settings          面板设置
//   设备页面   #/d/<设备id>/<页面>  某台设备的功能页 (概览、端口配置、VLAN …)

import overview from './views/overview.js';
import { config, stats } from './views/ports.js';
import { info, ip, user, cloud } from './views/system.js';
import { tools, firmware } from './views/tools.js';
import { lag, isolation, mac } from './views/switching.js';
import { mirror, cable, loop } from './views/monitor.js';
import { q, pvid, port, mtu } from './views/vlan.js';
import { basic, bandwidth, storm } from './views/qos.js';
import dashboard from './views/dashboard.js';
import devices, { deviceForm } from './views/devices.js';
import settings from './views/settings.js';

/** 侧边栏: 某台设备的功能页分组。[页面 id, 菜单文字, 图标] */
export const NAV = [
  { label: null, items: [['overview', '概览', 'grid']] },
  {
    label: '系统',
    items: [
      ['system.info', '系统信息', 'cpu'], ['system.ip', 'IP 设置', 'settings'], ['system.user', '设备账户', 'user'],
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

/** 设备功能页。 */
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

/**
 * 各功能页对设备能力的要求 (与适配器声明的能力对应):
 *   reads       必须能读的模型        writes      必须支持的操作
 *   writesAny   至少支持其中一个操作   features    必须具备的能力
 * 设备 (适配器) 不满足的页面不出现在导航里, 直接访问会提示不支持。
 */
const NEEDS = {
  overview: { reads: ['overview'] },
  'system.info': { reads: ['system'] },
  'system.ip': { reads: ['ip'] },
  'system.user': { reads: ['user'], writesAny: ['user.account'] },
  'system.cloud': { reads: ['cloud'] },
  'system.tools': { writesAny: ['config.save', 'system.reboot', 'system.reset'], featuresAny: ['backup', 'restore'] },
  'system.firmware': { reads: ['firmware'] },
  'ports.config': { reads: ['ports'], writesAny: ['port.settings'] },
  'ports.stats': { reads: ['stats'] },
  'sw.lag': { reads: ['lag'] },
  'sw.isolation': { reads: ['isolation'] },
  'sw.mac': { writes: ['mac.search'] },
  'mon.mirror': { reads: ['mirror'] },
  'mon.cable': { reads: ['cable'], writesAny: ['cable.run'] },
  'mon.loop': { reads: ['loop'] },
  'vlan.8021q': { reads: ['vlan8021q'] },
  'vlan.pvid': { reads: ['vlanPvid'], writesAny: ['vlan.pvid.set'] },
  'vlan.port': { reads: ['vlanPort'] },
  'vlan.mtu': { reads: ['vlanMtu'] },
  'qos.basic': { reads: ['qosBasic'] },
  'qos.bandwidth': { reads: ['qosBandwidth'] },
  'qos.storm': { reads: ['qosStorm'] },
};

/** 这台设备 (的能力) 是否支持某个功能页。 */
export function pageAvailable(id, capabilities = {}) {
  const needs = NEEDS[id];
  if (!needs) return true;
  const has = (list, key) => Array.isArray(list) && list.includes(key);
  if ((needs.reads ?? []).some((key) => !has(capabilities.reads, key))) return false;
  // 只读适配器 (没有任何写操作): 能读到数据的页面都可以看, 表单会被锁住; 纯操作页 (没有 reads) 仍然要求写能力
  if ((needs.reads ?? []).length && Array.isArray(capabilities.writes) && capabilities.writes.length === 0) return true;
  if ((needs.writes ?? []).some((key) => !has(capabilities.writes, key))) return false;
  if ((needs.features ?? []).some((key) => !has(capabilities.features, key))) return false;
  if (needs.writesAny && !needs.writesAny.some((key) => has(capabilities.writes, key))) return false;
  if (needs.featuresAny && !needs.featuresAny.some((key) => has(capabilities.features, key))) return false;
  return true;
}

/** 某台设备的侧边栏分组 (只含它支持的页面; 整组都不支持的分组不显示)。 */
export function navFor(capabilities) {
  return NAV.map((group) => ({ ...group, items: group.items.filter(([id]) => pageAvailable(id, capabilities)) })).filter((group) => group.items.length > 0);
}

// ── 全局页面 ──────────────────────────────────────────────────────────

export const GLOBAL_VIEWS = { dashboard, devices, deviceForm, settings };

/** 渲染一个页面。视图有两种写法: 带 render 方法的对象, 或者直接就是一个函数 (设备列表、设备表单)。 */
export function renderView(view, ctx, params) {
  return typeof view === 'function' ? view(ctx, params) : view.render(ctx, params);
}

const GLOBAL_TITLES = { dashboard: '全部设备', devices: '设备管理', deviceForm: '设备', settings: '面板设置' };

// ── 地址 ──────────────────────────────────────────────────────────────

/** 设备功能页的地址: #/d/<设备id>/<页面>。 */
export function hashOf(page, deviceId, params) {
  const query = params && Object.keys(params).length ? `?${new URLSearchParams(params)}` : '';
  return `#/d/${deviceId}/${page.replace(/\./g, '/')}${query}`;
}

/**
 * 地址 → { view, title, deviceId?, page?, params }
 *   view: 'dashboard' | 'devices' | 'deviceForm' | 'settings' | 'device'
 */
export function parseHash(hash) {
  const [path, query = ''] = String(hash).replace(/^#\/?/, '').split('?');
  const params = Object.fromEntries(new URLSearchParams(query));
  const seg = path.split('/').filter(Boolean);

  if (seg.length === 0) return { view: 'dashboard', title: GLOBAL_TITLES.dashboard, params };
  if (seg[0] === 'settings') return { view: 'settings', title: GLOBAL_TITLES.settings, params };
  if (seg[0] === 'devices') {
    if (seg[1] === 'new') return { view: 'deviceForm', title: '添加设备', params };
    if (seg[1] && seg[2] === 'edit') return { view: 'deviceForm', title: '修改设备', deviceId: seg[1], params };
    return { view: 'devices', title: GLOBAL_TITLES.devices, params };
  }
  if (seg[0] === 'd' && seg[1]) {
    // #/d/<设备id>/<页面路径>: 页面路径里的 / 对应页面 id 里的 . (ports/stats → ports.stats); 不认识的页面回到概览
    const wanted = seg.length > 2 ? seg.slice(2).join('.') : 'overview';
    const page = Object.hasOwn(VIEWS, wanted) ? wanted : 'overview';
    return { view: 'device', title: TITLES[page], deviceId: seg[1], page, params };
  }
  return { view: 'dashboard', title: GLOBAL_TITLES.dashboard, params };
}

export { GLOBAL_TITLES };
