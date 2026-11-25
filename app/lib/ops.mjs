// 写操作白名单。每一条都严格对应原厂页面里一个表单的提交方式 (路径 / 编码 / 字段名 / 取值),
// 不提供任意路径转发; 参数一律先过 validate 再发给交换机。
//
// send:  'form'      application/x-www-form-urlencoded (原厂 <form> 不带 enctype)
//        'multipart' multipart/form-data               (原厂 <form enctype=multipart/form-data>)
//        'query'     写在 URL 查询串里                  (原厂用 location.href 提交的几个接口)
// 之所以逐条照搬编码: 嵌入式服务端对 Content-Type 的兼容性未知, 保持与浏览器行为一致最稳妥。

import { PAGES } from './pages.mjs';

/** 提交时由客户端替换成本次会话的 g_tid。 */
export const TID = Symbol('token');

const APPLY = '应用';

class Check {
  constructor() {
    this.errors = [];
  }
  that(ok, message) {
    if (!ok) this.errors.push(message);
    return !!ok;
  }
}

const isInt = Number.isInteger;
const oneOf = (v, list) => list.includes(v);

/** 端口列表: 去重排序并校验范围; 不合法返回 null。 */
function portList(value, max) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out = [...new Set(value)];
  return out.every((p) => isInt(p) && p >= 1 && p <= max) ? out.sort((a, b) => a - b) : null;
}

/** 同 portList, 但允许空列表 (表示"这一类没有端口")。 */
const optionalPorts = (value, max) => (Array.isArray(value) && value.length === 0 ? [] : portList(value, max));

const octets = (s) => (typeof s === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(s) ? s.split('.').map(Number) : null);

/** 与原厂 ipVerify 一致: 不能是环回/组播/保留地址。 */
function isAddress(ip) {
  const o = octets(ip);
  return !!o && o.every((x) => x <= 255) && !(o[0] === 127 && o[1] === 0 && o[2] === 0) && !(o[0] >= 224 && o[0] <= 254);
}

/** 与原厂 isIp(x, 0) 一致: 网关首字节 1-223 且不为 127。 */
function isGateway(ip) {
  const o = octets(ip);
  return !!o && o.every((x) => x <= 255) && o[0] >= 1 && o[0] <= 223 && o[0] !== 127;
}

/** 与原厂 isIp(x, 3) 一致: DNS 首字节 1-223 且不为 127, 或全 0。 */
function isDns(ip) {
  const o = octets(ip);
  return !!o && o.every((x) => x <= 255) && (o[0] === 0 ? o.every((x) => x === 0) : (o[0] <= 223 && o[0] !== 127));
}

/** 与原厂 maskVerify 一致: 连续的高位 1, 且不能是全 0 / 全 1。 */
function isMask(ip) {
  const o = octets(ip);
  if (!o || o.some((x) => x > 255)) return false;
  const v = ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
  return v !== 0 && v !== 0xffffffff && ((v | (v - 1)) >>> 0) === 0xffffffff;
}

const DESCR_RE = /^[a-z0-9 \-_\u4e00-\u9fa5]+$/i;
/** 原厂 isDescri 的长度算法: 数字/字母/空格/连字符/下划线算 1, 其它 (中文) 算 3; 空串合法。 */
function visualLen(s) {
  return [...s].reduce((n, ch) => n + (/[a-z0-9 \-_]/i.test(ch) ? 1 : 3), 0);
}
const isDescr = (s, max) => typeof s === 'string' && (s === '' || (DESCR_RE.test(s) && visualLen(s) <= max));

const PRINTABLE = /^[\x21-\x7e]+$/;
const NEW_PWD = /^[\x21-\x3e\x40-\x7e]+$/; // 可见 ASCII, 不含 "?" (原厂 isNewPasswordValid)

function normalizeMac(mac) {
  const hex = String(mac).replace(/[:\- ]/g, '');
  return /^[0-9A-Fa-f]{12}$/.test(hex) ? hex.match(/.{2}/g).join(':').toUpperCase() : null;
}

const multi = (name, values) => values.map((v) => [name, v]);

/** 端口列表 → 位掩码 (第 n 口对应第 n-1 位), 以十进制字符串表示。
 *  用 BigInt 累加: 原厂的 32 位写法在 32 口及以上会溢出。31 口以内两者结果相同; 32 口及以上未在真机上验证。 */
const portMask = (ports) => ports.reduce((m, p) => m | (1n << BigInt(p - 1)), 0n).toString();
const speedMax = (ctx) => (ctx.support2_5G ? 7 : 6);

/** 组包前的第二道防线 (在 validate 之后): 数值必须是整数, 字符串不能带换行、不能过长。 */
function assertInts(fields) {
  for (const [name, value] of fields) {
    if (value === TID) continue;
    if (typeof value === 'number' && Number.isSafeInteger(value)) continue;
    if (typeof value === 'string' && value.length <= 256 && !/[\r\n]/.test(value)) continue;
    throw new Error(`字段 ${name} 含非法值`);
  }
}

const lookup = (name) => (typeof name === 'string' && Object.hasOwn(OPS, name) ? OPS[name] : undefined);

export const OPS = {
  // ── 端口 ────────────────────────────────────────────────────────────
  'port.quick': {
    title: '设置端口状态/速率',
    ctxPage: 'overview',
    refresh: ['overview'],
    validate(p, ctx, c) {
      c.that(isInt(p.port) && p.port >= 1 && p.port <= ctx.maxPorts, '端口不存在');
      c.that(isInt(p.speed) && p.speed >= 0 && p.speed <= speedMax(ctx), '速率取值不合法');
    },
    build: (p) => ({ path: 'main_info_port_status_set.cgi', method: 'GET', send: 'query', fields: [[`port_sel_${p.port}`, p.speed], ['token', TID]] }),
  },
  'port.settings': {
    title: '批量配置端口',
    ctxPage: 'ports',
    refresh: ['ports'],
    validate(p, ctx, c) {
      c.that(portList(p.ports, ctx.maxPorts) !== null, '请至少选择一个有效端口');
      c.that(oneOf(p.state, [7, 0, 1]), '状态取值不合法'); // 7 = 保持不变
      c.that(p.speed === 8 || (isInt(p.speed) && p.speed >= 1 && p.speed <= speedMax(ctx)), '速率/双工取值不合法'); // 8 = 保持不变
      c.that(oneOf(p.flow, [7, 0, 1]), '流控取值不合法'); // 7 = 保持不变
    },
    build: (p) => ({
      path: 'port_setting.cgi', method: 'POST', send: 'multipart',
      fields: [...multi('portid', p.ports), ['state', p.state], ['speed', p.speed], ['flowcontrol', p.flow], ['apply', APPLY], ['token', TID]],
    }),
  },
  'port.stats.clear': {
    title: '清空端口统计',
    build: () => ({ path: 'port_statistics_set.cgi', method: 'POST', send: 'multipart', fields: [['clear', '清空'], ['token', TID]] }),
    refresh: ['stats'],
  },

  // ── 系统 ────────────────────────────────────────────────────────────
  'system.description': {
    title: '修改设备描述',
    ctxPage: 'system',
    refresh: ['system', 'overview'],
    validate(p, ctx, c) {
      c.that(!ctx.cloudManaged, '云管理启用时不允许在设备端修改设备描述，只能通过云端修改');
      c.that(isDescr(p.description, 32), '设备描述最长 32 个字符，只能使用空格、中文、数字、英文字母、连字符和下划线（每个中文占 3 个字符）');
    },
    build: (p) => ({ path: 'system_name_set.cgi', method: 'POST', send: 'form', fields: [['sysName', p.description], ['token', TID]] }),
  },
  'system.reboot': {
    title: '重启交换机',
    danger: true,
    expectDisconnect: true,
    validate(p, ctx, c) {
      c.that(typeof p.save === 'boolean', '请指明重启前是否保存配置');
    },
    build: (p) => ({
      path: 'reboot.cgi', method: 'POST', send: 'form',
      fields: [...(p.save ? [['saveConf', 'on']] : []), ['apply', '重启'], ['reboot_op', 'reboot'], ['save_op', String(p.save)], ['token', TID]],
    }),
  },
  'system.reset': {
    title: '恢复出厂设置',
    danger: true,
    confirmText: 'RESET',
    expectDisconnect: true,
    build: () => ({ path: 'reset.cgi', method: 'POST', send: 'form', fields: [['apply', '复位'], ['reset_op', 'factory'], ['token', TID]] }),
  },
  'config.save': {
    title: '保存配置',
    build: () => ({ path: 'savingconfig.cgi', method: 'POST', send: 'form', fields: [['action_op', 'save'], ['token', TID]] }),
  },

  // ── IP / 账户 / 云管理 ───────────────────────────────────────────────
  'ip.setting': {
    title: '修改 IP 设置',
    danger: true,
    ctxPage: 'ip',
    validate(p, ctx, c) {
      if (ctx.vlanEditable) c.that(isInt(p.manageVlan) && p.manageVlan >= 1 && p.manageVlan <= 4094, '请输入合法的 VLAN ID（1-4094）');
      c.that(typeof p.dhcp === 'boolean' && typeof p.dnsAuto === 'boolean', '参数不完整');
      // 原厂页面在静态 IP 时强制 DNS 为手动
      const dnsManual = !p.dhcp || !p.dnsAuto;
      if (!p.dhcp) {
        c.that(isAddress(p.ip), 'IP 地址无效');
        c.that(isMask(p.netmask), '子网掩码无效（需为连续位，例如 255.255.255.0）');
        c.that(p.gateway === '' || isGateway(p.gateway), '默认网关无效');
      }
      if (dnsManual) c.that(isDns(p.dns), 'DNS 服务器地址无效');
    },
    // 与浏览器一致: 禁用状态的输入框不会被提交
    build: (p, ctx) => {
      const dnsManual = !p.dhcp || !p.dnsAuto;
      return {
        path: 'ip_setting.cgi', method: 'POST', send: 'multipart',
        fields: [
          ...(ctx.vlanEditable ? [['manage_vlan', p.manageVlan]] : []),
          ['dhcpSetting', p.dhcp ? 'enable' : 'disable'],
          ...(p.dhcp ? [] : [['ip_address', p.ip], ['ip_netmask', p.netmask], ['ip_gateway', p.gateway]]),
          ['dns_enable', dnsManual ? 'disable' : 'enable'],
          ...(dnsManual ? [['dns_addr', p.dns]] : []),
          ['token', TID],
        ],
      };
    },
  },
  'ip.fix': {
    title: '切换固定 IP',
    ctxPage: 'fixIp',
    refresh: ['fixIp'],
    validate(p, ctx, c) {
      c.that(typeof p.enabled === 'boolean', '参数不完整');
      void ctx;
    },
    build: (p) => ({ path: 'fix_ip_setting.cgi', method: 'POST', send: 'multipart', fields: [['fixIpSetting', p.enabled ? 'enable' : 'disable'], ['token', TID]] }),
  },
  'user.account': {
    title: '修改管理账户',
    danger: true,
    ctxPage: 'user',
    validate(p, ctx, c) {
      const { userMin, userMax, pwdMin, pwdMax } = ctx.limits;
      c.that(typeof p.username === 'string' && PRINTABLE.test(p.username) && p.username.length >= userMin && p.username.length <= userMax, `用户名需为 ${userMin}-${userMax} 个英文字母、数字或英文特殊字符`);
      c.that(typeof p.oldPassword === 'string' && p.oldPassword.length >= 1 && p.oldPassword.length <= pwdMax, '请输入旧密码');
      c.that(typeof p.newPassword === 'string' && NEW_PWD.test(p.newPassword) && p.newPassword.length >= pwdMin && p.newPassword.length <= pwdMax, `新密码需为 ${pwdMin}-${pwdMax} 个英文字母、数字或英文特殊字符（不包含“?”）`);
      c.that(p.newPassword === p.confirmPassword, '两次输入的密码不一致');
    },
    build: (p, ctx, enc) => ({
      path: 'usr_account_set.cgi', method: 'POST', send: 'multipart',
      fields: [
        ['txt_username', p.username],
        ['txt_oldpwd', enc(p.oldPassword)],
        ['txt_userpwd', enc(p.newPassword)],
        ['txt_confirmpwd', enc(p.confirmPassword)],
        ['token', TID],
      ],
    }),
  },
  'cloud.setting': {
    title: '切换云管理',
    danger: true,
    ctxPage: 'cloud',
    refresh: ['cloud', 'overview', 'system'],
    validate(p, ctx, c) {
      c.that(typeof p.enabled === 'boolean', '参数不完整');
      c.that(oneOf(p.type, ['cloud', 'nms']), '云管理类型不合法');
      void ctx;
    },
    build: (p) => ({
      path: 'cloud.cgi', method: 'POST', send: 'form',
      fields: [['cloud_op', 'mngt_switch'], ['status', p.enabled ? 1 : 0], ['token', TID], ['cloud_type', p.type === 'nms' ? 1 : 0]],
    }),
  },
  'cloud.nms': {
    title: '设置本地 NMS 服务器',
    ctxPage: 'cloud',
    refresh: ['cloud'],
    validate(p, ctx, c) {
      const serverOk = typeof p.server === 'string' && p.server.length >= 3 && p.server.length <= 255 && /^[a-zA-Z0-9][-a-zA-Z0-9]{0,62}(\.[a-zA-Z0-9][-a-zA-Z0-9]{0,62})+\.?$/.test(p.server);
      c.that(serverOk, '请输入正确的服务器地址');
      c.that(isInt(p.port) && p.port >= 1024 && p.port <= 65534, '端口取值范围为 1024-65534');
      void ctx;
    },
    build: (p) => ({ path: 'tumscloud.cgi', method: 'POST', send: 'form', fields: [['tums_server', p.server], ['tums_port', p.port], ['token', TID]] }),
  },

  // ── 二层交换 ────────────────────────────────────────────────────────
  'lag.set': {
    title: '配置链路聚合',
    ctxPage: 'lag',
    refresh: ['lag', 'ports', 'overview'],
    validate(p, ctx, c) {
      c.that(isInt(p.group) && p.group >= 1 && p.group <= ctx.maxLag, '汇聚组不存在');
      const ports = portList(p.ports, ctx.portCount);
      c.that(ports !== null, '请选择成员端口');
      if (!ports) return;
      c.that(ports.length >= 2, '最少添加 2 个端口');
      c.that(ports.length <= ctx.portsPerLag, `每个汇聚组最多 ${ctx.portsPerLag} 个成员端口`);
      const r = ctx.ranges[p.group];
      if (r) c.that(ports.every((x) => x >= r[0] && x <= r[1]), `端口 ${ports.filter((x) => x < r[0] || x > r[1]).join('、')} 不可选，汇聚 ${p.group} 可用端口为 ${r[0]} 到 ${r[1]}`);
    },
    build: (p) => ({ path: 'port_trunk_set.cgi', method: 'POST', send: 'form', fields: [['groupId', p.group], ...multi('portid', p.ports), ['setapply', APPLY], ['token', TID]] }),
  },
  'lag.delete': {
    title: '删除链路聚合',
    ctxPage: 'lag',
    refresh: ['lag', 'ports', 'overview'],
    validate(p, ctx, c) {
      c.that(Array.isArray(p.groups) && p.groups.length > 0 && p.groups.every((g) => isInt(g) && g >= 1 && g <= ctx.maxLag), '请选择要删除的汇聚组');
    },
    build: (p) => ({ path: 'port_trunk_display.cgi', method: 'POST', send: 'form', fields: [...multi('chk_trunk', p.groups), ['setDelete', '删除'], ['token', TID]] }),
  },
  'isolation.set': {
    title: '配置端口隔离',
    ctxPage: 'isolation',
    refresh: ['isolation'],
    validate(p, ctx, c) {
      c.that(portList(p.ports, ctx.portCount) !== null, '请选择要隔离的端口');
      const ok = Array.isArray(p.from) && p.from.length > 0 && p.from.every((x) => (isInt(x) && x >= 1 && x <= ctx.portCount) || (typeof x === 'string' && ctx.lags.includes(Number(x.slice(1))) && /^l\d+$/.test(x)));
      c.that(ok, '请选择与之隔离的端口');
    },
    build: (p) => ({ path: 'port_isolation_set.cgi', method: 'POST', send: 'form', fields: [...multi('groupId', p.ports), ...multi('portid', p.from), ['setapply', APPLY], ['token', TID]] }),
  },
  'mac.search': {
    title: '搜索 MAC 地址',
    resultModel: PAGES.macSearch.model, // 结果就在提交返回的页面里
    validate(p, ctx, c) {
      c.that(normalizeMac(p.mac) !== null, 'MAC 地址不合法');
      c.that(p.vid === '' || p.vid === null || (isInt(p.vid) && p.vid >= 0 && p.vid <= 4094), 'VLAN ID 取值范围为 0-4094');
      void ctx;
    },
    build: (p) => ({
      path: 'mac_address_search.cgi', method: 'POST', send: 'multipart',
      fields: [['txt_macAddress_search', normalizeMac(p.mac)], ['txt_vid_search', p.vid ?? ''], ['token', TID]],
    }),
  },

  // ── 监控 ────────────────────────────────────────────────────────────
  'mirror.enable': {
    title: '设置端口镜像',
    ctxPage: 'mirror',
    refresh: ['mirror'],
    validate(p, ctx, c) {
      c.that(typeof p.enabled === 'boolean', '参数不完整');
      if (p.enabled) c.that(isInt(p.port) && p.port >= 1 && p.port <= ctx.maxPorts, '请选择监控端口');
    },
    build: (p) => ({
      path: 'mirror_enabled_set.cgi', method: 'POST', send: 'form',
      fields: [['state', p.enabled ? 1 : 0], ...(p.enabled ? [['mirroringport', p.port]] : []), ['mirrorenable', APPLY], ['token', TID]],
    }),
  },
  'mirror.ports': {
    title: '设置被监控端口',
    ctxPage: 'mirror',
    refresh: ['mirror'],
    validate(p, ctx, c) {
      const ports = portList(p.ports, ctx.maxPorts);
      c.that(ports !== null, '请选择被监控端口');
      c.that(oneOf(p.ingress, [4, 0, 1]) && oneOf(p.egress, [4, 0, 1]), '参数不完整'); // 4 = 保持不变
      if (ports && ctx.enabled) c.that(!ports.includes(ctx.mirroringPort), '监控端口不能同时作为被监控端口');
    },
    build: (p) => ({
      path: 'mirrored_port_set.cgi', method: 'POST', send: 'multipart',
      fields: [...multi('mirroredport', p.ports), ['ingressState', p.ingress], ['egressState', p.egress], ['mirrored_submit', APPLY], ['token', TID]],
    }),
  },
  'loop.set': {
    title: '设置环回保护',
    refresh: ['loop', 'overview'],
    validate(p, ctx, c) {
      c.that(typeof p.enabled === 'boolean', '参数不完整');
      void ctx;
    },
    build: (p) => ({ path: 'loop_prevention_set.cgi', method: 'POST', send: 'multipart', fields: [['lpEn', p.enabled ? 1 : 0], ['apply', APPLY], ['token', TID]] }),
  },
  'cable.run': {
    title: '线缆检测',
    ctxPage: 'cable',
    resultModel: PAGES.cable.model,
    validate(p, ctx, c) {
      const enabled = new Set(ctx.results.filter((r) => r.enabled).map((r) => r.id));
      c.that(portList(p.ports, ctx.maxPorts) !== null, '请选择要检测的端口');
      c.that(Array.isArray(p.ports) && p.ports.every((x) => enabled.has(x)), '被禁用的端口不能进行线缆检测');
    },
    build: (p) => ({
      path: 'cable_diag_get.cgi', method: 'POST', send: 'multipart',
      fields: [...p.ports.map((n) => [`chk_${n}`, n]), ['Apply', APPLY], ['token', TID]],
    }),
  },

  // ── VLAN ────────────────────────────────────────────────────────────
  'vlan.mtu.enable': {
    title: '启用/禁用 MTU VLAN',
    danger: true,
    ctxPage: 'vlanMtu',
    refresh: ['vlanMtu', 'overview'],
    validate(p, ctx, c) {
      c.that(typeof p.enabled === 'boolean', '参数不完整');
      void ctx;
    },
    build: (p) => ({ path: 'mtuVlanSet.cgi', method: 'POST', send: 'form', fields: [['mtu_en', p.enabled ? 1 : 0], ['mtu_mode', APPLY], ['token', TID]] }),
  },
  'vlan.mtu.uplink': {
    title: '设置 MTU VLAN 上联口',
    ctxPage: 'vlanMtu',
    refresh: ['vlanMtu'],
    validate(p, ctx, c) {
      c.that(ctx.enabled, '设置 uplink 端口前应先启用 MTU VLAN');
      c.that(isInt(p.port) && p.port >= 1 && p.port <= ctx.portCount, '端口不存在');
    },
    build: (p) => ({ path: 'mtuVlanSet.cgi', method: 'POST', send: 'form', fields: [['uplinkPort', p.port], ['mtu_uplink', APPLY], ['token', TID]] }),
  },
  'vlan.port.enable': {
    title: '启用/禁用端口 VLAN',
    danger: true,
    ctxPage: 'vlanPort',
    refresh: ['vlanPort'],
    validate(p, ctx, c) {
      c.that(typeof p.enabled === 'boolean', '参数不完整');
      void ctx;
    },
    build: (p) => ({ path: 'pvlanSet.cgi', method: 'POST', send: 'form', fields: [['pvlan_en', p.enabled ? 1 : 0], ['pvlan_mode', APPLY], ['token', TID]] }),
  },
  'vlan.port.set': {
    title: '设置端口 VLAN 组',
    ctxPage: 'vlanPort',
    refresh: ['vlanPort'],
    validate(p, ctx, c) {
      c.that(ctx.enabled, '设置端口组前应先启用端口 VLAN');
      c.that(isInt(p.vid) && p.vid >= 1 && p.vid <= ctx.maxVid, `VLAN ID 范围 1-${ctx.maxVid}`);
      c.that(portList(p.ports, ctx.portCount) !== null, '请至少选择一个端口');
    },
    build: (p) => ({ path: 'pvlanSet.cgi', method: 'POST', send: 'form', fields: [['vid', p.vid], ...multi('selPorts', p.ports), ['pvlan_add', APPLY], ['token', TID]] }),
  },
  'vlan.port.delete': {
    title: '删除端口 VLAN 组',
    ctxPage: 'vlanPort',
    refresh: ['vlanPort'],
    validate(p, ctx, c) {
      const known = new Set(ctx.vlans.map((x) => x.id));
      c.that(Array.isArray(p.vids) && p.vids.length > 0 && p.vids.every((x) => isInt(x) && x !== 1 && known.has(x)), '请选择要删除的端口 VLAN（VLAN 1 不可删除）');
    },
    build: (p) => ({ path: 'pvlanSet.cgi', method: 'POST', send: 'form', fields: [...multi('selVlans', p.vids), ['pvlan_del', '删除'], ['token', TID]] }),
  },
  'vlan.q.enable': {
    title: '启用/禁用 802.1Q VLAN',
    danger: true,
    ctxPage: 'vlan8021q',
    refresh: ['vlan8021q', 'vlanPvid', 'overview'],
    validate(p, ctx, c) {
      c.that(typeof p.enabled === 'boolean', '参数不完整');
      void ctx;
    },
    build: (p) => ({ path: 'qvlanSet.cgi', method: 'POST', send: 'form', fields: [['qvlan_en', p.enabled ? 1 : 0], ['qvlan_mode', APPLY], ['token', TID]] }),
  },
  'vlan.q.set': {
    title: '添加/编辑 802.1Q VLAN',
    ctxPage: 'vlan8021q',
    refresh: ['vlan8021q', 'overview'],
    validate(p, ctx, c) {
      c.that(ctx.enabled, '添加或修改 802.1Q VLAN 前应先启用 802.1Q VLAN');
      c.that(isInt(p.vid) && p.vid >= 1 && p.vid <= 4094, 'VLAN ID 取值范围为 1-4094');
      c.that(isDescr(p.name ?? '', 12), 'VLAN 描述最长 12 个字符，只能使用空格、中文、数字、英文字母、连字符和下划线（每个中文占 3 个字符）');
      const tagged = optionalPorts(p.tagged ?? [], ctx.portCount);
      const untagged = optionalPorts(p.untagged ?? [], ctx.portCount);
      c.that(tagged !== null && untagged !== null, '端口不合法');
      if (tagged === null || untagged === null || !isInt(p.vid)) return;
      const members = new Set([...tagged, ...untagged]);
      c.that(tagged.length + untagged.length === members.size, '同一端口不能同时设为 Tagged 和 Untagged');
      c.that(ctx.vlans.some((x) => x.id === p.vid) || ctx.vlans.length < ctx.maxVlans, 'VLAN 数量已满');
      if (p.vid !== 1) {
        c.that(members.size > 0, '请至少选择一个端口');
      } else {
        // 与原厂 chkPortAlone 一致: VLAN 1 必须覆盖所有不属于其它 VLAN 的端口
        const elsewhere = new Set(ctx.vlans.filter((x) => x.id !== 1).flatMap((x) => [...x.tagged, ...x.untagged]));
        const orphans = Array.from({ length: ctx.portCount }, (_, i) => i + 1).filter((x) => !elsewhere.has(x) && !members.has(x));
        c.that(orphans.length === 0, `端口 ${orphans.join('、')} 不是任何 VLAN 的成员`);
      }
    },
    build: (p, ctx) => {
      const tag = new Set(p.tagged ?? []);
      const untag = new Set(p.untagged ?? []);
      const perPort = Array.from({ length: ctx.portCount }, (_, i) => [`selType_${i + 1}`, tag.has(i + 1) ? 1 : untag.has(i + 1) ? 0 : 2]); // 0=Untagged 1=Tagged 2=非成员
      return { path: 'qvlanSet.cgi', method: 'POST', send: 'form', fields: [['vid', p.vid], ['vname', p.name ?? ''], ...perPort, ['qvlan_add', '添加/编辑'], ['token', TID]] };
    },
  },
  'vlan.q.delete': {
    title: '删除 802.1Q VLAN',
    ctxPage: 'vlan8021q',
    refresh: ['vlan8021q', 'overview'],
    validate(p, ctx, c) {
      const known = new Set(ctx.vlans.map((x) => x.id));
      c.that(Array.isArray(p.vids) && p.vids.length > 0 && p.vids.every((x) => isInt(x) && x !== 1 && known.has(x)), '请选择要删除的 VLAN（VLAN 1 不可删除）');
    },
    build: (p) => ({ path: 'qvlanSet.cgi', method: 'POST', send: 'form', fields: [...multi('selVlans', p.vids), ['qvlan_del', '删除'], ['token', TID]] }),
  },
  'vlan.pvid.set': {
    title: '设置端口 PVID',
    ctxPage: 'vlanPvid',
    refresh: ['vlanPvid'],
    validate(p, ctx, c) {
      c.that(ctx.enabled, '设置 PVID 前应先启用 802.1Q VLAN');
      c.that(isInt(p.pvid) && p.pvid >= 1 && p.pvid <= 4094, 'PVID 取值范围为 1-4094');
      c.that(portList(p.ports, ctx.portCount) !== null, '请至少选择一个端口');
    },
    build: (p) => ({ path: 'vlanPvidSet.cgi', method: 'GET', send: 'query', fields: [['pbm', portMask(p.ports)], ['pvid', p.pvid], ['token', TID]] }),
  },

  // ── QoS ─────────────────────────────────────────────────────────────
  'qos.mode': {
    title: '设置 QoS 模式',
    ctxPage: 'qosBasic',
    refresh: ['qosBasic'],
    validate(p, ctx, c) {
      c.that(oneOf(p.mode, [0, 1, 2]), 'QoS 模式不合法'); // 0=基于端口 1=基于802.1P 2=基于DSCP
      void ctx;
    },
    build: (p) => ({ path: 'qos_mode_set.cgi', method: 'POST', send: 'form', fields: [['rd_qosmode', p.mode], ['qosmode', APPLY], ['token', TID]] }),
  },
  'qos.priority': {
    title: '设置端口优先级',
    ctxPage: 'qosBasic',
    refresh: ['qosBasic'],
    validate(p, ctx, c) {
      c.that(ctx.mode === 0, '当前 QoS 模式不是“基于端口”，无法设置端口优先级');
      c.that(portList(p.ports, ctx.portCount) !== null, '请至少选择一个端口');
      c.that(isInt(p.queue) && p.queue >= 0 && p.queue <= 3, '优先级队列不合法'); // 0-3 对应 1(最低)-4(最高)
    },
    build: (p) => ({ path: 'qos_port_priority_set.cgi', method: 'POST', send: 'form', fields: [...p.ports.map((n) => [`sel_${n}`, 1]), ['port_queue', p.queue], ['apply', APPLY], ['token', TID]] }),
  },
  'qos.bandwidth': {
    title: '设置端口限速',
    ctxPage: 'qosBandwidth',
    refresh: ['qosBandwidth'],
    validate(p, ctx, c) {
      c.that(portList(p.ports, ctx.portCount) !== null, '请至少选择一个端口');
      const rate = (v) => isInt(v) && v >= 0 && v <= 1000000;
      c.that(rate(p.ingress) && rate(p.egress), '速率取值范围为 0-1000000 Kbps');
    },
    build: (p) => ({ path: 'qos_bandwidth_set.cgi', method: 'POST', send: 'form', fields: [...p.ports.map((n) => [`sel_${n}`, 1]), ['igrRate', p.ingress], ['egrRate', p.egress], ['applay', APPLY], ['token', TID]] }),
  },
  'qos.storm': {
    title: '设置风暴抑制',
    ctxPage: 'qosStorm',
    refresh: ['qosStorm'],
    validate(p, ctx, c) {
      c.that(portList(p.ports, ctx.portCount) !== null, '请至少选择一个端口');
      c.that(typeof p.enabled === 'boolean', '参数不完整');
      if (p.enabled) {
        c.that(isInt(p.rate) && p.rate >= 1 && p.rate <= 1000000, '速率取值范围为 1-1000000 Kbps');
        c.that(Array.isArray(p.types) && p.types.length > 0 && p.types.every((t) => oneOf(t, [1, 2, 4])), '请至少选择一种风暴类型'); // 1=未知单播 2=组播 4=广播
      }
    },
    build: (p) => ({
      path: 'qos_storm_set.cgi', method: 'POST', send: 'form',
      fields: [...p.ports.map((n) => [`sel_${n}`, 1]), ['state', p.enabled ? 1 : 0], ...(p.enabled ? [['rate', p.rate], ...multi('stormType', p.types)] : []), ['applay', APPLY], ['token', TID]],
    }),
  },
};

/** 校验参数, 返回错误信息数组 (空数组表示通过)。 */
export function validateOp(name, params, ctx) {
  const op = lookup(name);
  if (!op) return [`未知操作: ${String(name).slice(0, 40)}`];
  const c = new Check();
  try {
    op.validate?.(params ?? {}, ctx ?? {}, c);
  } catch {
    c.errors.push('参数格式不正确');
  }
  if (op.danger && params?.confirm !== true) c.errors.push('该操作需要明确确认');
  if (op.confirmText && params?.confirmText !== op.confirmText) c.errors.push(`请输入 ${op.confirmText} 以确认`);
  return c.errors;
}

/** 组装请求。调用前必须已经通过 validateOp。 */
export function buildOp(name, params, ctx, enc) {
  const op = lookup(name);
  if (!op) throw new Error(`未知操作: ${String(name).slice(0, 40)}`);
  const req = op.build(params, ctx, enc);
  assertInts(req.fields);
  return { ...req, expectDisconnect: !!op.expectDisconnect };
}
