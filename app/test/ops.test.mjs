// 写操作白名单: 校验逻辑与组包格式。全部离线, 不会碰真实交换机。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateOp, OPS } from '../src/core/ops.mjs';
import { buildOp, supportsOp, TID, BUILD } from '../src/adapters/tplink-rpm/ops.mjs';
import { PAGES, uptimeSeconds } from '../src/adapters/tplink-rpm/pages.mjs';
import { securityEncode } from '../src/adapters/tplink-rpm/client.mjs';
import { parseVars } from '../src/core/jslite.mjs';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
// 合成夹具: 只含设备页面首个 <script> 里的数据声明, 身份信息 (MAC / IP / 用户名) 都是虚构的
const FIXTURES = join(HERE, 'fixtures', 'rpm'); // HERE 以路径分隔符结尾

const ctx = (key) => {
  const page = PAGES[key];
  return page.model(parseVars(readFileSync(join(FIXTURES, basename(page.path).replace('.', '_') + '.txt'), 'utf8')));
};
const fields = (name, params, ctxData = {}) => buildOp(name, params, ctxData, securityEncode);
const valid = (name, params, ctxData) => assert.deepEqual(validateOp(name, params, ctxData), []);
const invalid = (name, params, ctxData) => validateOp(name, params, ctxData);

test('密码编码与原厂 cryp_new.js 一致 (向量由已对真机验证过的 tools/enc.py 生成)', () => {
  assert.equal(securityEncode('admin'), 'WaQ7xbhc9TefbwK');
  assert.equal(securityEncode('a'), 'WyWcQbhc9TefbwK');
  assert.equal(securityEncode(''), 'tyWcQbhc9TefbwK');
  assert.notEqual(securityEncode('admin'), securityEncode('admins'));
});

test('规范层: 每个操作都有标题和校验, 引用的页面模型都存在', () => {
  for (const [name, op] of Object.entries(OPS)) {
    assert.equal(typeof op.title, 'string', name);
    // 不带参数的操作 (清空统计、保存配置…) 可以没有校验函数
    assert.ok(op.validate === undefined || typeof op.validate === 'function', `${name}: validate 必须是函数`);
    assert.equal(op.build, undefined, `${name}: 具体的编码方式不该出现在规范层`);
    for (const key of [op.ctxPage, ...(op.refresh ?? []), op.result].filter(Boolean)) {
      assert.ok(PAGES[key], `${name} 引用的页面模型 ${key} 不存在`);
    }
  }
  assert.equal(Object.keys(OPS).length, 33);
});

test('RPM 适配器: 能编码全部规范操作, 且不提供白名单以外的操作', () => {
  assert.deepEqual(Object.keys(BUILD).sort(), Object.keys(OPS).sort());
  for (const name of ['__proto__', 'constructor', 'toString', 'nope', 'raw']) assert.equal(supportsOp(name), false);
  assert.throws(() => buildOp('constructor', {}, {}, securityEncode), /未知操作/);
});

// 原厂页面里每个写表单的提交方式 (逐个核对过抓下来的原厂页面, 见 docs/protocol.md)。
// 没写 method 的 <form> 浏览器一律用 GET 提交, 字段在查询串里 —— 哪怕它写了 enctype=multipart/form-data。
// 这张表就是"面板发给交换机的方式必须和浏览器一致"的契约: 2.0.0 之前有 20 个操作被错发成 POST, 在真机上不工作。
const STOCK_GET = new Set([
  'port.quick', 'port.settings', 'port.stats.clear', 'system.description', 'ip.setting', 'ip.fix', 'user.account',
  'lag.set', 'lag.delete', 'isolation.set', 'mac.search', 'mirror.enable', 'mirror.ports', 'loop.set', 'cable.run',
  'vlan.mtu.enable', 'vlan.mtu.uplink', 'vlan.port.enable', 'vlan.port.set', 'vlan.port.delete',
  'vlan.q.enable', 'vlan.q.set', 'vlan.q.delete', 'vlan.pvid.set',
]);
const STOCK_POST_FORM = new Set(['system.reboot', 'system.reset', 'config.save', 'cloud.setting', 'cloud.nms', 'qos.mode', 'qos.priority', 'qos.bandwidth', 'qos.storm']);

test('提交方式与原厂页面一致: 没写 method 的表单都是 GET 查询串, 只有少数表单是 POST', () => {
  const sample = {
    'port.quick': [{ port: 1, speed: 1 }, ctx('overview')], 'port.settings': [{ ports: [1], state: 1, speed: 1, flow: 0 }, ctx('ports')],
    'system.description': [{ description: 'x' }, { cloudManaged: false }], 'ip.setting': [{ manageVlan: 1, dhcp: true, dnsAuto: true }, ctx('ip')],
    'ip.fix': [{ enabled: true }, ctx('fixIp')], 'user.account': [{ username: 'u', oldPassword: 'old-pass-1', newPassword: 'NewPass123!', confirmPassword: 'NewPass123!' }, ctx('user')],
    'cloud.setting': [{ enabled: false, type: 'cloud', confirm: true }, ctx('cloud')], 'cloud.nms': [{ server: 'nms.example.com', port: 60445 }, ctx('cloud')],
    'lag.set': [{ group: 1, ports: [1, 2] }, ctx('lag')], 'lag.delete': [{ groups: [1] }, ctx('lag')], 'isolation.set': [{ ports: [1], from: [2] }, ctx('isolation')],
    'mac.search': [{ mac: 'aa:bb:cc:dd:ee:ff', vid: '' }, {}], 'mirror.enable': [{ enabled: false, port: 1 }, ctx('mirror')], 'mirror.ports': [{ ports: [1], ingress: 1, egress: 0 }, ctx('mirror')],
    'loop.set': [{ enabled: false }, {}], 'cable.run': [{ ports: [1] }, ctx('cable')], 'vlan.mtu.enable': [{ enabled: false, confirm: true }, ctx('vlanMtu')],
    'vlan.mtu.uplink': [{ port: 1 }, ctx('vlanMtu')], 'vlan.port.enable': [{ enabled: false, confirm: true }, ctx('vlanPort')],
    'vlan.port.set': [{ vid: 2, ports: [1] }, ctx('vlanPort')], 'vlan.port.delete': [{ vids: [2] }, ctx('vlanPort')],
    'vlan.q.enable': [{ enabled: true, confirm: true }, ctx('vlan8021q')], 'vlan.q.set': [{ vid: 10, name: 'a', untagged: [1] }, ctx('vlan8021q')],
    'vlan.q.delete': [{ vids: [10] }, ctx('vlan8021q')], 'vlan.pvid.set': [{ pvid: 1, ports: [1] }, ctx('vlanPvid')],
    'system.reboot': [{ save: true, confirm: true }, {}], 'system.reset': [{ confirm: true, confirmText: 'RESET' }, {}], 'config.save': [{}, {}],
    'qos.mode': [{ mode: 0 }, ctx('qosBasic')], 'qos.priority': [{ ports: [1], queue: 0 }, ctx('qosBasic')],
    'qos.bandwidth': [{ ports: [1], ingress: 0, egress: 0 }, ctx('qosBandwidth')], 'qos.storm': [{ ports: [1], enabled: false, rate: 0, types: [] }, ctx('qosStorm')],
    'port.stats.clear': [{}, {}],
  };
  assert.deepEqual([...STOCK_GET, ...STOCK_POST_FORM].sort(), Object.keys(OPS).sort(), '每个操作都要在这张表里');
  for (const name of Object.keys(OPS)) {
    const req = buildOp(name, sample[name][0], sample[name][1], securityEncode);
    const how = STOCK_GET.has(name) ? ['GET', 'query'] : ['POST', 'form'];
    assert.deepEqual([req.method, req.send], how, `${name} 的提交方式与原厂页面不一致`);
    assert.ok(req.fields.some(([k]) => k === 'token'), `${name}: 必须带 token (字段顺序以原厂表单为准)`);
    if (how[0] === 'GET') assert.ok(req.fields.every(([, v]) => typeof v === 'string' || typeof v === 'number' || v === TID), `${name}: 查询串里只能放标量`);
  }
});

test('port.settings: 批量端口配置按原厂表单用 GET 提交, 多端口重复 portid', () => {
  const c = ctx('ports');
  const req = fields('port.settings', { ports: [3, 1], state: 1, speed: 6, flow: 7 }, c);
  assert.deepEqual([req.method, req.send], ['GET', 'query']);
  assert.deepEqual(req.fields, [['portid', 3], ['portid', 1], ['state', 1], ['speed', 6], ['flowcontrol', 7], ['apply', '应用'], ['token', TID]]);
  valid('port.settings', { ports: [1], state: 7, speed: 8, flow: 7 }, c);
  assert.match(invalid('port.settings', { ports: [], state: 1, speed: 6, flow: 7 }, c).join(), /有效端口/);
  assert.match(invalid('port.settings', { ports: [9], state: 1, speed: 6, flow: 7 }, c).join(), /有效端口/);
  assert.match(invalid('port.settings', { ports: [1], state: 2, speed: 6, flow: 7 }, c).join(), /状态/);
  assert.match(invalid('port.settings', { ports: [1], state: 1, speed: 7, flow: 7 }, c).join(), /速率/); // 本机不支持 2.5G
  assert.match(invalid('port.settings', { ports: [1], state: 1, speed: 6, flow: 2 }, c).join(), /流控/);
  assert.match(invalid('port.settings', { ports: ['1 OR 1=1'], state: 1, speed: 6, flow: 7 }, c).join(), /有效端口/);
});

test('port.quick: 首页快速设置走 GET 查询串', () => {
  const c = ctx('overview');
  const req = fields('port.quick', { port: 5, speed: 0 }, c);
  assert.deepEqual([req.method, req.send, req.path], ['GET', 'query', 'main_info_port_status_set.cgi']);
  assert.deepEqual(req.fields, [['port_sel_5', 0], ['token', TID]]);
  assert.match(invalid('port.quick', { port: 5, speed: 9 }, c).join(), /速率/);
});

test('system.description: 云管理开启时禁止修改; 字符集受限', () => {
  const c = ctx('system'); // 夹具里 cloudManaged = true
  assert.match(invalid('system.description', { description: 'x' }, c).join(), /云管理/);
  valid('system.description', { description: '核心交换机-01' }, { cloudManaged: false });
  assert.match(invalid('system.description', { description: '<script>' }, { cloudManaged: false }).join(), /设备描述/);
  assert.match(invalid('system.description', { description: '一二三四五六七八九十一二三四五六七八九十一' }, { cloudManaged: false }).join(), /设备描述/);
});

test('system.reset / system.reboot: 必须明确确认', () => {
  assert.match(invalid('system.reset', {}).join(), /明确确认/);
  assert.match(invalid('system.reset', { confirm: true }).join(), /输入 RESET/);
  valid('system.reset', { confirm: true, confirmText: 'RESET' });
  assert.match(invalid('system.reboot', { save: true }).join(), /明确确认/);
  const req = fields('system.reboot', { save: true, confirm: true });
  // 原厂表单里只有这三个字段; "保存配置"复选框 (saveConf) 和重启按钮都在 <form> 之外, 浏览器不会提交它们
  assert.deepEqual(req.fields, [['reboot_op', 'reboot'], ['save_op', 'true'], ['token', TID]]);
  assert.equal(fields('system.reboot', { save: false, confirm: true }).fields[1][1], 'false');
  assert.deepEqual(fields('system.reset', { confirm: true, confirmText: 'RESET' }).fields, [['reset_op', 'factory'], ['token', TID]]);
  assert.equal(req.expectDisconnect, true);
});

test('ip.setting: 校验与"禁用的输入框不提交"规则', () => {
  const c = ctx('ip');
  const base = { manageVlan: 1, dhcp: false, dnsAuto: false, confirm: true };
  valid('ip.setting', { ...base, ip: '192.168.50.20', netmask: '255.255.255.0', gateway: '192.168.50.1', dns: '192.168.50.1' }, c);
  assert.match(invalid('ip.setting', { ...base, ip: '10.0.0.256', netmask: '255.255.255.0', gateway: '', dns: '192.168.50.1' }, c).join(), /IP 地址/);
  assert.match(invalid('ip.setting', { ...base, ip: '192.168.50.20', netmask: '255.0.255.0', gateway: '', dns: '192.168.50.1' }, c).join(), /子网掩码/);
  assert.match(invalid('ip.setting', { ...base, ip: '192.168.50.20', netmask: '255.255.255.0', gateway: '0.1.1.1', dns: '192.168.50.1' }, c).join(), /网关/);
  assert.match(invalid('ip.setting', { ...base, ip: '192.168.50.20', netmask: '255.255.255.0', gateway: '', dns: '300.1.1.1' }, c).join(), /DNS/);
  // DHCP + 自动 DNS: 不带 IP/掩码/网关/DNS 字段
  const auto = fields('ip.setting', { manageVlan: 1, dhcp: true, dnsAuto: true }, c);
  assert.deepEqual(auto.fields, [['manage_vlan', 1], ['dhcpSetting', 'enable'], ['dns_enable', 'enable'], ['token', TID]]);
  const manual = fields('ip.setting', { ...base, ip: '192.168.50.20', netmask: '255.255.255.0', gateway: '', dns: '192.168.50.1' }, c);
  assert.deepEqual(manual.fields, [['manage_vlan', 1], ['dhcpSetting', 'disable'], ['ip_address', '192.168.50.20'], ['ip_netmask', '255.255.255.0'], ['ip_gateway', ''], ['dns_enable', 'disable'], ['dns_addr', '192.168.50.1'], ['token', TID]]);
});

test('user.account: 三次密码字段都是编码后的值, 确认密码必须一致', () => {
  const c = ctx('user');
  const p = { username: 'adminuser', oldPassword: 'old-pass-1', newPassword: 'NewPass123!', confirmPassword: 'NewPass123!' };
  const req = fields('user.account', p, c);
  const map = Object.fromEntries(req.fields.filter(([, v]) => v !== TID));
  assert.equal(map.txt_oldpwd, securityEncode('old-pass-1'));
  assert.equal(map.txt_userpwd, securityEncode('NewPass123!'));
  assert.equal(map.txt_confirmpwd, map.txt_userpwd);
  assert.notEqual(map.txt_userpwd, 'NewPass123!');
  assert.match(invalid('user.account', { ...p, confirmPassword: 'other' }, c).join(), /不一致/);
  assert.match(invalid('user.account', { ...p, newPassword: 'abcde?f', confirmPassword: 'abcde?f' }, c).join(), /新密码/);
  assert.match(invalid('user.account', { ...p, newPassword: 'ab', confirmPassword: 'ab' }, c).join(), /新密码/);
});

test('lag.set: 成员数量与可选端口范围', () => {
  const c = ctx('lag');
  valid('lag.set', { group: 1, ports: [1, 2] }, c);
  assert.match(invalid('lag.set', { group: 1, ports: [1, 6] }, c).join(), /不可选/);
  assert.match(invalid('lag.set', { group: 1, ports: [1] }, c).join(), /最少/);
  assert.match(invalid('lag.set', { group: 1, ports: [1, 2, 3, 4, 5] }, c).join(), /最多/);
  assert.match(invalid('lag.set', { group: 3, ports: [1, 2] }, c).join(), /汇聚组/);
  assert.deepEqual(fields('lag.set', { group: 2, ports: [5, 6] }, c).fields, [['groupId', 2], ['portid', 5], ['portid', 6], ['setapply', '应用'], ['token', TID]]);
});

test('vlan.q.set: 每个端口一个 selType_N, 取值 0=Untagged 1=Tagged 2=非成员', () => {
  const c = ctx('vlan8021q');
  const req = fields('vlan.q.set', { vid: 10, name: '办公', tagged: [1], untagged: [2, 3] }, c);
  assert.deepEqual(req.fields, [['vid', 10], ['vname', '办公'], ['selType_1', 1], ['selType_2', 0], ['selType_3', 0], ['selType_4', 2], ['selType_5', 2], ['selType_6', 2], ['selType_7', 2], ['selType_8', 2], ['qvlan_add', '添加/编辑'], ['token', TID]]);
  assert.match(invalid('vlan.q.set', { vid: 10, name: '', tagged: [], untagged: [] }, c).join(), /至少选择一个端口/);
  assert.match(invalid('vlan.q.set', { vid: 4095, name: '', tagged: [1], untagged: [] }, c).join(), /1-4094/);
  assert.match(invalid('vlan.q.set', { vid: 10, name: '', tagged: [1], untagged: [1] }, c).join(), /不能同时/);
  assert.match(invalid('vlan.q.set', { vid: 10, name: '名字太长太长太长太长', tagged: [1], untagged: [] }, c).join(), /VLAN 描述/);
  // VLAN 1 必须覆盖所有不属于其它 VLAN 的端口
  assert.match(invalid('vlan.q.set', { vid: 1, name: '', tagged: [], untagged: [1] }, c).join(), /不是任何 VLAN 的成员/);
  valid('vlan.q.set', { vid: 1, name: 'Default', tagged: [], untagged: [1, 2, 3, 4, 5, 6, 7, 8] }, c);
});

test('vlan.q.delete / vlan.port.delete: VLAN 1 不可删除', () => {
  const c = ctx('vlan8021q');
  assert.match(invalid('vlan.q.delete', { vids: [1] }, c).join(), /不可删除/);
  assert.match(invalid('vlan.q.delete', { vids: [99] }, c).join(), /请选择/);
  const pv = ctx('vlanPort');
  assert.match(invalid('vlan.port.delete', { vids: [2] }, pv).join(), /请选择/);
});

test('vlan.pvid.set: 走 GET, 端口列表转成位掩码', () => {
  const c = ctx('vlanPvid');
  const req = fields('vlan.pvid.set', { pvid: 20, ports: [1, 3, 8] }, c);
  assert.deepEqual([req.send, req.path, req.fields], ['query', 'vlanPvidSet.cgi', [['pbm', '133'], ['pvid', 20], ['token', TID]]]);
    // 超过 32 口时位掩码不能溢出 (32 位移位会回绕)
    const wide = fields('vlan.pvid.set', { pvid: 5, ports: [1, 32, 40] }, { enabled: true, portCount: 48 });
    assert.equal(wide.fields[0][1], (2n ** 39n | 2n ** 31n | 1n).toString());
  assert.match(invalid('vlan.pvid.set', { pvid: 0, ports: [1] }, c).join(), /PVID/);
  assert.match(invalid('vlan.pvid.set', { pvid: 2, ports: [] }, c).join(), /至少选择/);
  assert.match(invalid('vlan.pvid.set', { pvid: 2, ports: [1] }, { enabled: false, portCount: 8 }).join(), /先启用/);
});

test('qos.*: 端口选择框 sel_N=1 与范围校验', () => {
  const b = ctx('qosBandwidth');
  const req = fields('qos.bandwidth', { ports: [2, 4], ingress: 1024, egress: 0 }, b);
  assert.deepEqual(req.fields, [['sel_2', 1], ['sel_4', 1], ['igrRate', 1024], ['egrRate', 0], ['applay', '应用'], ['token', TID]]);
  assert.match(invalid('qos.bandwidth', { ports: [2], ingress: 1000001, egress: 0 }, b).join(), /0-1000000/);

  const q = ctx('qosBasic');
  assert.match(invalid('qos.priority', { ports: [2], queue: 0 }, { ...q, mode: 1 }).join(), /基于端口/);
  valid('qos.priority', { ports: [2], queue: 3 }, q);

  const s = ctx('qosStorm');
  const off = fields('qos.storm', { ports: [1], enabled: false }, s);
  assert.deepEqual(off.fields, [['sel_1', 1], ['state', 0], ['applay', '应用'], ['token', TID]]);
  const on = fields('qos.storm', { ports: [1], enabled: true, rate: 512, types: [1, 4] }, s);
  assert.deepEqual(on.fields, [['sel_1', 1], ['state', 1], ['rate', 512], ['stormType', 1], ['stormType', 4], ['applay', '应用'], ['token', TID]]);
  assert.match(invalid('qos.storm', { ports: [1], enabled: true, rate: 512, types: [] }, s).join(), /风暴类型/);
  assert.match(invalid('qos.storm', { ports: [1], enabled: true, rate: 0, types: [2] }, s).join(), /1-1000000/);
});

test('danger 操作缺少 confirm 一律拒绝', () => {
  for (const [name, op] of Object.entries(OPS)) {
    if (!op.danger) continue;
    const errs = invalid(name, { ports: [1], port: 1, speed: 1, enabled: true, group: 1, ports2: [], vids: [2], manageVlan: 1, dhcp: true, dnsAuto: true, mode: 0, queue: 0, ingress: 0, egress: 0, rate: 1, types: [1], vid: 2, name: '', tagged: [1], untagged: [], pvid: 1, save: false, description: 'x', username: 'abcde', oldPassword: 'x', newPassword: 'abcde', confirmPassword: 'abcde', type: 'cloud', ip: '1.1.1.1', netmask: '255.255.255.0', gateway: '', dns: '1.1.1.1' }, ctx(op.ctxPage ?? 'overview'));
    assert.ok(errs.includes('该操作需要明确确认'), `${name} 应要求确认`);
  }
});

test('未知操作 / 原型链上的名字 / 非对象参数都不会漏过校验', () => {
  for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'nope']) {
    assert.match(validateOp(name, {}).join(), /未知操作/, name);
    assert.throws(() => buildOp(name, {}, {}), /未知操作/, name);
  }
  assert.ok(validateOp('port.quick', null, ctx('overview')).length > 0);
  assert.ok(validateOp('port.quick', undefined, ctx('overview')).length > 0);
  assert.ok(validateOp('port.quick', 'string', ctx('overview')).length > 0);
  assert.ok(validateOp('port.quick', { port: 1, speed: 1, extra: { nested: true } }, ctx('overview')).every((e) => typeof e === 'string'));
});

test('组包是校验之后的第二道防线: 非整数值进不了请求', () => {
  const c = ctx('ports');
  assert.throws(() => buildOp('port.settings', { ports: [1], state: 1, speed: 6, flow: 1.5 }, c, securityEncode), /非法值/);
  assert.throws(() => buildOp('port.settings', { ports: [1], state: 1, speed: 6, flow: NaN }, c, securityEncode), /非法值/);
  assert.throws(() => buildOp('system.description', { description: 'a\r\nX-Injected: 1' }, { cloudManaged: false }, securityEncode), /非法值/);
});

test('pages: uptimeSeconds 供前端计时使用', () => {
  assert.equal(uptimeSeconds('1 day - 0 hour - 1 min - 0 sec'), 86460);
});
