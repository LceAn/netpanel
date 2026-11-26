// TP-Link 旧版 Web 界面 (Rpm): 每个规范操作对应的原厂表单提交方式。
// 每一条都严格对应原厂页面里一个表单 (路径 / 编码 / 字段名 / 取值), 不提供任意路径转发。
//
// send:  'form'      application/x-www-form-urlencoded (原厂 <form> 不带 enctype)
//        'multipart' multipart/form-data               (原厂 <form enctype=multipart/form-data>)
//        'query'     写在 URL 查询串里                  (原厂用 location.href 提交的几个接口)
// 之所以逐条照搬编码: 嵌入式服务端对 Content-Type 的兼容性未知, 保持与浏览器行为一致最稳妥。

import { OPS, normalizeMac } from '../../core/ops.mjs';
import { portsMask } from '../../core/models.mjs';
import { SwitchError } from '../../core/errors.mjs';

/** 提交时由客户端替换成本次会话的 g_tid。 */
export const TID = Symbol('token');

const APPLY = '应用';
const multi = (name, values) => values.map((v) => [name, v]);
/** 端口列表 → 位掩码 (第 n 口对应第 n-1 位), 以十进制字符串表示。
 *  原厂用 32 位写法, 在 32 口及以上会溢出; 这里不受限。31 口以内两者结果相同; 32 口及以上未在真机上验证。 */
const portMask = portsMask;

/** 组包前的第二道防线 (在 validate 之后): 数值必须是整数, 字符串不能带换行、不能过长。 */
function assertInts(fields) {
  for (const [name, value] of fields) {
    if (value === TID) continue;
    if (typeof value === 'number' && Number.isSafeInteger(value)) continue;
    if (typeof value === 'string' && value.length <= 256 && !/[\r\n]/.test(value)) continue;
    throw new Error(`字段 ${name} 含非法值`);
  }
}

export const BUILD = {
  'port.quick': (p) => ({ path: 'main_info_port_status_set.cgi', method: 'GET', send: 'query', fields: [[`port_sel_${p.port}`, p.speed], ['token', TID]] }),
  'port.settings': (p) => ({
    path: 'port_setting.cgi', method: 'POST', send: 'multipart',
    fields: [...multi('portid', p.ports), ['state', p.state], ['speed', p.speed], ['flowcontrol', p.flow], ['apply', APPLY], ['token', TID]],
  }),
  'port.stats.clear': () => ({ path: 'port_statistics_set.cgi', method: 'POST', send: 'multipart', fields: [['clear', '清空'], ['token', TID]] }),
  'system.description': (p) => ({ path: 'system_name_set.cgi', method: 'POST', send: 'form', fields: [['sysName', p.description], ['token', TID]] }),
  'system.reboot': (p) => ({
    path: 'reboot.cgi', method: 'POST', send: 'form',
    fields: [...(p.save ? [['saveConf', 'on']] : []), ['apply', '重启'], ['reboot_op', 'reboot'], ['save_op', String(p.save)], ['token', TID]],
  }),
  'system.reset': () => ({ path: 'reset.cgi', method: 'POST', send: 'form', fields: [['apply', '复位'], ['reset_op', 'factory'], ['token', TID]] }),
  'config.save': () => ({ path: 'savingconfig.cgi', method: 'POST', send: 'form', fields: [['action_op', 'save'], ['token', TID]] }),
  // 与浏览器一致: 禁用状态的输入框不会被提交
  'ip.setting': (p, ctx) => {
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
  'ip.fix': (p) => ({ path: 'fix_ip_setting.cgi', method: 'POST', send: 'multipart', fields: [['fixIpSetting', p.enabled ? 'enable' : 'disable'], ['token', TID]] }),
  'user.account': (p, ctx, enc) => ({
    path: 'usr_account_set.cgi', method: 'POST', send: 'multipart',
    fields: [
      ['txt_username', p.username],
      ['txt_oldpwd', enc(p.oldPassword)],
      ['txt_userpwd', enc(p.newPassword)],
      ['txt_confirmpwd', enc(p.confirmPassword)],
      ['token', TID],
    ],
  }),
  'cloud.setting': (p) => ({
    path: 'cloud.cgi', method: 'POST', send: 'form',
    fields: [['cloud_op', 'mngt_switch'], ['status', p.enabled ? 1 : 0], ['token', TID], ['cloud_type', p.type === 'nms' ? 1 : 0]],
  }),
  'cloud.nms': (p) => ({ path: 'tumscloud.cgi', method: 'POST', send: 'form', fields: [['tums_server', p.server], ['tums_port', p.port], ['token', TID]] }),
  'lag.set': (p) => ({ path: 'port_trunk_set.cgi', method: 'POST', send: 'form', fields: [['groupId', p.group], ...multi('portid', p.ports), ['setapply', APPLY], ['token', TID]] }),
  'lag.delete': (p) => ({ path: 'port_trunk_display.cgi', method: 'POST', send: 'form', fields: [...multi('chk_trunk', p.groups), ['setDelete', '删除'], ['token', TID]] }),
  'isolation.set': (p) => ({ path: 'port_isolation_set.cgi', method: 'POST', send: 'form', fields: [...multi('groupId', p.ports), ...multi('portid', p.from), ['setapply', APPLY], ['token', TID]] }),
  'mac.search': (p) => ({
    path: 'mac_address_search.cgi', method: 'POST', send: 'multipart',
    fields: [['txt_macAddress_search', normalizeMac(p.mac)], ['txt_vid_search', p.vid ?? ''], ['token', TID]],
  }),
  'mirror.enable': (p) => ({
    path: 'mirror_enabled_set.cgi', method: 'POST', send: 'form',
    fields: [['state', p.enabled ? 1 : 0], ...(p.enabled ? [['mirroringport', p.port]] : []), ['mirrorenable', APPLY], ['token', TID]],
  }),
  'mirror.ports': (p) => ({
    path: 'mirrored_port_set.cgi', method: 'POST', send: 'multipart',
    fields: [...multi('mirroredport', p.ports), ['ingressState', p.ingress], ['egressState', p.egress], ['mirrored_submit', APPLY], ['token', TID]],
  }),
  'loop.set': (p) => ({ path: 'loop_prevention_set.cgi', method: 'POST', send: 'multipart', fields: [['lpEn', p.enabled ? 1 : 0], ['apply', APPLY], ['token', TID]] }),
  'cable.run': (p) => ({
    path: 'cable_diag_get.cgi', method: 'POST', send: 'multipart',
    fields: [...p.ports.map((n) => [`chk_${n}`, n]), ['Apply', APPLY], ['token', TID]],
  }),
  'vlan.mtu.enable': (p) => ({ path: 'mtuVlanSet.cgi', method: 'POST', send: 'form', fields: [['mtu_en', p.enabled ? 1 : 0], ['mtu_mode', APPLY], ['token', TID]] }),
  'vlan.mtu.uplink': (p) => ({ path: 'mtuVlanSet.cgi', method: 'POST', send: 'form', fields: [['uplinkPort', p.port], ['mtu_uplink', APPLY], ['token', TID]] }),
  'vlan.port.enable': (p) => ({ path: 'pvlanSet.cgi', method: 'POST', send: 'form', fields: [['pvlan_en', p.enabled ? 1 : 0], ['pvlan_mode', APPLY], ['token', TID]] }),
  'vlan.port.set': (p) => ({ path: 'pvlanSet.cgi', method: 'POST', send: 'form', fields: [['vid', p.vid], ...multi('selPorts', p.ports), ['pvlan_add', APPLY], ['token', TID]] }),
  'vlan.port.delete': (p) => ({ path: 'pvlanSet.cgi', method: 'POST', send: 'form', fields: [...multi('selVlans', p.vids), ['pvlan_del', '删除'], ['token', TID]] }),
  'vlan.q.enable': (p) => ({ path: 'qvlanSet.cgi', method: 'POST', send: 'form', fields: [['qvlan_en', p.enabled ? 1 : 0], ['qvlan_mode', APPLY], ['token', TID]] }),
  'vlan.q.set': (p, ctx) => {
    const tag = new Set(p.tagged ?? []);
    const untag = new Set(p.untagged ?? []);
    const perPort = Array.from({ length: ctx.portCount }, (_, i) => [`selType_${i + 1}`, tag.has(i + 1) ? 1 : untag.has(i + 1) ? 0 : 2]); // 0=Untagged 1=Tagged 2=非成员
    return { path: 'qvlanSet.cgi', method: 'POST', send: 'form', fields: [['vid', p.vid], ['vname', p.name ?? ''], ...perPort, ['qvlan_add', '添加/编辑'], ['token', TID]] };
  },
  'vlan.q.delete': (p) => ({ path: 'qvlanSet.cgi', method: 'POST', send: 'form', fields: [...multi('selVlans', p.vids), ['qvlan_del', '删除'], ['token', TID]] }),
  'vlan.pvid.set': (p) => ({ path: 'vlanPvidSet.cgi', method: 'GET', send: 'query', fields: [['pbm', portMask(p.ports)], ['pvid', p.pvid], ['token', TID]] }),
  'qos.mode': (p) => ({ path: 'qos_mode_set.cgi', method: 'POST', send: 'form', fields: [['rd_qosmode', p.mode], ['qosmode', APPLY], ['token', TID]] }),
  'qos.priority': (p) => ({ path: 'qos_port_priority_set.cgi', method: 'POST', send: 'form', fields: [...p.ports.map((n) => [`sel_${n}`, 1]), ['port_queue', p.queue], ['apply', APPLY], ['token', TID]] }),
  'qos.bandwidth': (p) => ({ path: 'qos_bandwidth_set.cgi', method: 'POST', send: 'form', fields: [...p.ports.map((n) => [`sel_${n}`, 1]), ['igrRate', p.ingress], ['egrRate', p.egress], ['applay', APPLY], ['token', TID]] }),
  'qos.storm': (p) => ({
    path: 'qos_storm_set.cgi', method: 'POST', send: 'form',
    fields: [...p.ports.map((n) => [`sel_${n}`, 1]), ['state', p.enabled ? 1 : 0], ...(p.enabled ? [['rate', p.rate], ...multi('stormType', p.types)] : []), ['applay', APPLY], ['token', TID]],
  }),
};

/** 本适配器能编码哪些操作。 */
export const supportsOp = (name) => typeof name === 'string' && Object.hasOwn(BUILD, name);

/** 组装请求。调用前必须已经通过 validateOp。 */
export function buildOp(name, params, ctx, enc) {
  const op = OPS[name];
  if (!op || !supportsOp(name)) throw new SwitchError(`未知操作: ${String(name).slice(0, 40)}`, 'BAD_PARAM');
  const req = BUILD[name](params, ctx, enc);
  assertInts(req.fields);
  return { ...req, expectDisconnect: !!op.expectDisconnect };
}
