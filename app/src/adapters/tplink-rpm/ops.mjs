// TP-Link 旧版 Web 界面 (Rpm): 每个规范操作对应的原厂表单提交方式。
// 每一条都严格对应原厂页面里一个表单 (路径 / 方法 / 编码 / 字段名 / 取值), 不提供任意路径转发。
//
// 提交方式照搬"浏览器提交这个表单"时的行为:
//   GET  + 查询串     原厂 <form> 没写 method。浏览器默认用 GET, 所有字段 (含 token) 都在查询串里 ——
//                     这类表单很多写了 enctype=multipart/form-data, 但 enctype 只对 POST 有效, 浏览器照样按查询串提交
//   POST + 表单编码    原厂 <form method=post>
//   (POST + multipart 只用在还原配置和固件上传上, 见 client.mjs / index.mjs)
// 之所以逐条照搬: 嵌入式服务端的 CGI 只按它预期的方式取参数。用别的方式发, 轻则参数丢失, 重则直接断开连接
// (实测: 用 POST 请求配置备份, 交换机直接把连接断了)。
//
// 每个操作的路径 / 方法 / 字段都对照原厂页面逐个核对过 (用 tools/forms.py 列出每个表单的提交方式和字段), 见 docs/protocol.md。
// 模拟交换机 (scripts/mock-switch.mjs) 只接受这里列的提交方式, test/mock.test.mjs 会把全部操作逐个打到它上面。

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

/** 原厂 <form> 没写 method → 浏览器用 GET 提交, 字段在查询串里。 */
const getForm = (path, fields) => ({ path, method: 'GET', send: 'query', fields });
/** 原厂 <form method=post> → 字段在请求体里 (application/x-www-form-urlencoded)。 */
const postForm = (path, fields) => ({ path, method: 'POST', send: 'form', fields });

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
  'port.quick': (p) => getForm('main_info_port_status_set.cgi', [[`port_sel_${p.port}`, p.speed], ['token', TID]]),
  'port.settings': (p) => getForm('port_setting.cgi', [...multi('portid', p.ports), ['state', p.state], ['speed', p.speed], ['flowcontrol', p.flow], ['apply', APPLY], ['token', TID]]),
  'port.stats.clear': () => getForm('port_statistics_set.cgi', [['clear', '清空'], ['token', TID]]),
  'system.description': (p) => getForm('system_name_set.cgi', [['sysName', p.description], ['token', TID]]),
  // 原厂表单里只有这三个字段 (重启按钮和"保存配置"复选框在 <form> 之外, 不会被提交); save_op 是复选框的 checked: "true" / "false"
  'system.reboot': (p) => postForm('reboot.cgi', [['reboot_op', 'reboot'], ['save_op', String(p.save)], ['token', TID]]),
  'system.reset': () => postForm('reset.cgi', [['reset_op', 'factory'], ['token', TID]]),
  'config.save': () => postForm('savingconfig.cgi', [['action_op', 'save'], ['token', TID]]),
  // 与浏览器一致: 禁用状态的输入框不会被提交 (启用 DHCP 时 IP / 掩码 / 网关被禁用; 自动获取 DNS 时 DNS 地址被禁用)
  'ip.setting': (p, ctx) => {
    const dnsManual = !p.dhcp || !p.dnsAuto;
    return getForm('ip_setting.cgi', [
      ...(ctx.vlanEditable ? [['manage_vlan', p.manageVlan]] : []),
      ['dhcpSetting', p.dhcp ? 'enable' : 'disable'],
      ...(p.dhcp ? [] : [['ip_address', p.ip], ['ip_netmask', p.netmask], ['ip_gateway', p.gateway]]),
      ['dns_enable', dnsManual ? 'disable' : 'enable'],
      ...(dnsManual ? [['dns_addr', p.dns]] : []),
      ['token', TID],
    ]);
  },
  'ip.fix': (p) => getForm('fix_ip_setting.cgi', [['fixIpSetting', p.enabled ? 'enable' : 'disable'], ['token', TID]]),
  // 密码字段的值 = securityEncode(明文) (固件的 encryptType = 0 时用的是 hex_md5)
  'user.account': (p, ctx, enc) => getForm('usr_account_set.cgi', [
    ['txt_username', p.username],
    ['txt_oldpwd', enc(p.oldPassword)],
    ['txt_userpwd', enc(p.newPassword)],
    ['txt_confirmpwd', enc(p.confirmPassword)],
    ['token', TID],
  ]),
  'cloud.setting': (p) => postForm('cloud.cgi', [['cloud_op', 'mngt_switch'], ['status', p.enabled ? 1 : 0], ['token', TID], ['cloud_type', p.type === 'nms' ? 1 : 0]]),
  'cloud.nms': (p) => postForm('tumscloud.cgi', [['tums_server', p.server], ['tums_port', p.port], ['token', TID]]),
  'lag.set': (p) => getForm('port_trunk_set.cgi', [['groupId', p.group], ...multi('portid', p.ports), ['setapply', APPLY], ['token', TID]]),
  'lag.delete': (p) => getForm('port_trunk_display.cgi', [...multi('chk_trunk', p.groups), ['setDelete', '删除'], ['token', TID]]),
  'isolation.set': (p) => getForm('port_isolation_set.cgi', [...multi('groupId', p.ports), ...multi('portid', p.from), ['setapply', APPLY], ['token', TID]]),
  'mac.search': (p) => getForm('mac_address_search.cgi', [['txt_macAddress_search', normalizeMac(p.mac)], ['txt_vid_search', p.vid ?? ''], ['token', TID]]),
  // 镜像关闭时"监控端口"下拉框是禁用的, 不会被提交
  'mirror.enable': (p) => getForm('mirror_enabled_set.cgi', [['state', p.enabled ? 1 : 0], ...(p.enabled ? [['mirroringport', p.port]] : []), ['mirrorenable', APPLY], ['token', TID]]),
  'mirror.ports': (p) => getForm('mirrored_port_set.cgi', [...multi('mirroredport', p.ports), ['ingressState', p.ingress], ['egressState', p.egress], ['mirrored_submit', APPLY], ['token', TID]]),
  'loop.set': (p) => getForm('loop_prevention_set.cgi', [['lpEn', p.enabled ? 1 : 0], ['apply', APPLY], ['token', TID]]),
  'cable.run': (p) => getForm('cable_diag_get.cgi', [...p.ports.map((n) => [`chk_${n}`, n]), ['Apply', APPLY], ['token', TID]]),
  'vlan.mtu.enable': (p) => getForm('mtuVlanSet.cgi', [['mtu_en', p.enabled ? 1 : 0], ['mtu_mode', APPLY], ['token', TID]]),
  'vlan.mtu.uplink': (p) => getForm('mtuVlanSet.cgi', [['uplinkPort', p.port], ['mtu_uplink', APPLY], ['token', TID]]),
  'vlan.port.enable': (p) => getForm('pvlanSet.cgi', [['pvlan_en', p.enabled ? 1 : 0], ['pvlan_mode', APPLY], ['token', TID]]),
  'vlan.port.set': (p) => getForm('pvlanSet.cgi', [['vid', p.vid], ...multi('selPorts', p.ports), ['pvlan_add', APPLY], ['token', TID]]),
  'vlan.port.delete': (p) => getForm('pvlanSet.cgi', [...multi('selVlans', p.vids), ['pvlan_del', '删除'], ['token', TID]]),
  'vlan.q.enable': (p) => getForm('qvlanSet.cgi', [['qvlan_en', p.enabled ? 1 : 0], ['qvlan_mode', APPLY], ['token', TID]]),
  'vlan.q.set': (p, ctx) => {
    const tag = new Set(p.tagged ?? []);
    const untag = new Set(p.untagged ?? []);
    const perPort = Array.from({ length: ctx.portCount }, (_, i) => [`selType_${i + 1}`, tag.has(i + 1) ? 1 : untag.has(i + 1) ? 0 : 2]); // 0=Untagged 1=Tagged 2=非成员
    return getForm('qvlanSet.cgi', [['vid', p.vid], ['vname', p.name ?? ''], ...perPort, ['qvlan_add', '添加/编辑'], ['token', TID]]);
  },
  'vlan.q.delete': (p) => getForm('qvlanSet.cgi', [...multi('selVlans', p.vids), ['qvlan_del', '删除'], ['token', TID]]),
  // 原厂页面用 location.href 提交 (不是表单), 所以它一直是 GET
  'vlan.pvid.set': (p) => getForm('vlanPvidSet.cgi', [['pbm', portMask(p.ports)], ['pvid', p.pvid], ['token', TID]]),
  // QoS 四个表单是原厂页面里少数写了 method=post 的
  'qos.mode': (p) => postForm('qos_mode_set.cgi', [['rd_qosmode', p.mode], ['qosmode', APPLY], ['token', TID]]),
  // port_queue 的取值是 0-3 (原厂下拉框的选项值), 对应界面上的 1(最低)-4(最高)
  'qos.priority': (p) => postForm('qos_port_priority_set.cgi', [...p.ports.map((n) => [`sel_${n}`, 1]), ['port_queue', p.queue], ['apply', APPLY], ['token', TID]]),
  'qos.bandwidth': (p) => postForm('qos_bandwidth_set.cgi', [...p.ports.map((n) => [`sel_${n}`, 1]), ['igrRate', p.ingress], ['egrRate', p.egress], ['applay', APPLY], ['token', TID]]),
  // 风暴抑制关闭时, 速率和报文类型两个输入框是禁用的, 不会被提交
  'qos.storm': (p) => postForm('qos_storm_set.cgi', [...p.ports.map((n) => [`sel_${n}`, 1]), ['state', p.enabled ? 1 : 0], ...(p.enabled ? [['rate', p.rate], ...multi('stormType', p.types)] : []), ['applay', APPLY], ['token', TID]]),
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
