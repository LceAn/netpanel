// 模拟交换机 (scripts/mock-switch.mjs) 是照真机的反应做的 (实测记录见 docs/protocol.md)。这里验证两件事:
//  1. 契约: 适配器发出的每个写请求, 模拟器都按原厂表单的方式收下, 设备回答 "操作成功";
//  2. 模拟器本身: 提交方式不对时直接断开连接 —— 2.0.0 及之前的做法 (没写 method 的表单也用 POST 发) 在这里失败, 在真机上同样失败。
// 全部走 DeviceManager (与界面、命令行相同的路径), 用的都是不改变配置的参数。

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { APP_ROOT } from '../src/core/config.mjs';
import { OPS } from '../src/core/ops.mjs';
import { openPanel } from '../src/http/server.mjs';
import { TID } from '../src/adapters/tplink-rpm/ops.mjs';
import { createMockSwitch } from '../scripts/mock-switch.mjs';

let mock;
let dir;
let parts;
let id;

before(async () => {
  mock = await createMockSwitch({ profile: 'lab' }).listen(0);
  dir = mkdtempSync(join(tmpdir(), 'netpanel-mock-'));
  parts = openPanel({ appRoot: APP_ROOT, env: { PANEL_DATA_DIR: dir }, log: () => {} });
  id = (await parts.manager.add({ name: 'lab', url: mock.url, username: 'admin', password: 'admin' })).id;
});
after(async () => {
  await parts.close();
  await mock.close();
  rmSync(dir, { recursive: true, force: true });
});

const read = (key) => parts.manager.read(id, key, { live: true }).then((r) => r.data);
const port = (n) => read('overview').then((o) => o.ports.find((p) => p.id === n));
/** 端口 5: lab 配置里不在汇聚组中, 拿它做"原样再提交一遍"。 */
const P = 5;
const pick = (ports) => ports.find((p) => p.id === P);
/** "1,2,6" / "1-8" → 端口列表。 */
const expand = (text) => String(text).split(',').flatMap((part) => {
  const m = /^(\d+)-(\d+)$/.exec(part);
  return m ? Array.from({ length: Number(m[2]) - Number(m[1]) + 1 }, (_, i) => Number(m[1]) + i) : [Number(part)];
});

/**
 * 每个操作的"不改变配置"的参数, 以及它应该用的提交方式:
 *   get   GET, 参数在查询串里 (原厂 <form> 没写 method)      form  POST 表单编码的请求体 (原厂 <form method=post>)
 * 表里的顺序就是执行顺序: 需要先启用 / 先建出来才能测的操作排在后面。
 */
const CASES = {
  'port.quick': async () => ({ submit: 'get', params: { port: 8, speed: (await port(8)).speedCfg } }),
  'port.settings': () => ({ submit: 'get', params: { ports: [P], state: 7, speed: 8, flow: 7 } }), // 7 / 8 = 保持不变
  'port.stats.clear': () => ({ submit: 'get', params: {} }),
  'system.description': async () => ({ submit: 'get', params: { description: (await read('system')).description } }),
  'ip.setting': async () => {
    const { manageVlan, dhcp, ip, netmask, gateway, dns, dnsAuto } = await read('ip');
    return { submit: 'get', params: { manageVlan, dhcp, ip, netmask, gateway, dns, dnsAuto, confirm: true } };
  },
  'ip.fix': async () => ({ submit: 'get', params: { enabled: (await read('fixIp')).enabled } }),
  'user.account': async () => ({ submit: 'get', params: { username: (await read('user')).username, oldPassword: 'admin', newPassword: 'admin', confirmPassword: 'admin', confirm: true } }),
  'isolation.set': async () => ({ submit: 'get', params: { ports: [6], from: expand((await read('isolation')).rules.find((r) => r.port === 6).forward) } }),
  'mac.search': () => ({ submit: 'get', params: { mac: 'aa:bb:cc:dd:ee:ff', vid: '' } }),
  'mirror.enable': async () => {
    const m = await read('mirror');
    return { submit: 'get', params: { enabled: m.enabled, ...(m.enabled ? { port: m.mirroringPort } : {}) } };
  },
  'mirror.ports': () => ({ submit: 'get', params: { ports: [3], ingress: 4, egress: 4 } }), // 4 = 保持不变
  'loop.set': async () => ({ submit: 'get', params: { enabled: (await read('loop')).enabled } }),
  'cable.run': () => ({ submit: 'get', params: { ports: [8] } }),
  'vlan.mtu.enable': () => ({ submit: 'get', params: { enabled: true, confirm: true } }),
  'vlan.mtu.uplink': async () => ({ submit: 'get', params: { port: (await read('vlanMtu')).uplinkPort } }),
  'vlan.port.enable': () => ({ submit: 'get', params: { enabled: true, confirm: true } }),
  'vlan.port.set': () => ({ submit: 'get', params: { vid: 2, ports: [P] } }),
  'vlan.port.delete': () => ({ submit: 'get', params: { vids: [2] } }),
  'vlan.q.enable': async () => ({ submit: 'get', params: { enabled: true, confirm: true } }),
  'vlan.q.set': () => ({ submit: 'get', params: { vid: 4094, name: 'np-test', tagged: [], untagged: [P] } }),
  'vlan.q.delete': () => ({ submit: 'get', params: { vids: [4094] } }),
  'vlan.pvid.set': async () => ({ submit: 'get', params: { pvid: pick((await read('vlanPvid')).ports).pvid, ports: [P] } }),
  'config.save': () => ({ submit: 'form', params: {} }),
  'cloud.setting': async () => {
    const c = await read('cloud');
    return { submit: 'form', params: { enabled: c.enabled, type: c.type, confirm: true } };
  },
  'cloud.nms': async () => ({ submit: 'form', params: await read('cloud').then((c) => ({ server: c.nms.server || 'nms.example.com', port: c.nms.port })) }),
  'qos.mode': async () => ({ submit: 'form', params: { mode: (await read('qosBasic')).mode } }),
  'qos.priority': async () => ({ submit: 'form', params: { ports: [P], queue: pick((await read('qosBasic')).ports).priority - 1 } }), // 表单值 0-3 = 页面值 1-4
  'qos.bandwidth': async () => ({ submit: 'form', params: { ports: [P], ingress: pick((await read('qosBandwidth')).ports).ingress, egress: pick((await read('qosBandwidth')).ports).egress } }),
  'qos.storm': async () => {
    const p = pick((await read('qosStorm')).ports);
    return { submit: 'form', params: { ports: [P], enabled: p.enabled, ...(p.enabled ? { rate: p.rate, types: p.types } : {}) } };
  },
  'lag.set': () => ({ submit: 'get', params: { group: 2, ports: [P, 6] } }), // 汇聚 2 可用端口 5-8
  'lag.delete': () => ({ submit: 'get', params: { groups: [2] } }), // 删掉上一步建的第 2 组
};

test('契约: 每个写操作都按原厂表单的方式提交, 设备回答 "操作成功"', async () => {
  // 云管理开着时不允许改设备描述 (校验会拦下来), 先把模拟器的云管理关掉
  const system = mock.V('SystemInfoRpm');
  const managed = system.mngt_switch;
  system.mngt_switch = 0;
  try {
    const done = [];
    for (const [name, build] of Object.entries(CASES)) {
      const { params, submit } = await build();
      const res = await parts.manager.submit(id, name, params);
      assert.equal(res.tip, '操作成功', name);
      const write = mock.writes.at(-1);
      assert.equal(write.submit, submit, `${name}: 实际是 ${write.method} /${write.path}`);
      done.push(name);
    }
    // 表外的只有重启和复位: 执行之后设备会离线, 它们的请求格式在 ops.test / switch.test 里验证
    assert.deepEqual(Object.keys(OPS).filter((name) => !done.includes(name)), ['system.reboot', 'system.reset']);
    // 收尾: 把为了测试临时启用 / 建出来的东西去掉
    for (const [name, params] of [['vlan.mtu.enable', { enabled: false, confirm: true }], ['vlan.port.enable', { enabled: false, confirm: true }]]) {
      assert.equal((await parts.manager.submit(id, name, params)).tip, '操作成功', `收尾 ${name}`);
    }
    assert.deepEqual((await read('lag')).groups.filter((g) => g.members.length).map((g) => g.members), [[7, 8]], 'lab 配置里的汇聚组原样保留');
    assert.deepEqual((await read('vlan8021q')).vlans.map((v) => v.id), [1, 10, 20, 30], '临时建的 VLAN 已删除');
    assert.equal((await read('vlanPort')).vlans.length, 0);
    assert.equal((await read('vlanMtu')).enabled, false);
  } finally {
    system.mngt_switch = managed;
  }
});

test('提交方式不对 → 交换机直接断开连接 (2.0.0 用 POST 请求备份接口, 在真机上也是这样失败)', async () => {
  const conn = await parts.manager.connectionFor(id);
  await assert.rejects(
    conn.client.sendRaw({ path: 'config_back.cgi', method: 'POST', send: 'form', fields: [['btnBackup', '配置备份'], ['token', TID]] }),
    (err) => err.code === 'UNCERTAIN',
  );
  // 反过来: 该用 POST 表单的接口用 GET 发, 同样被断开
  await assert.rejects(
    conn.client.sendRaw({ path: 'qos_mode_set.cgi', method: 'GET', send: 'query', fields: [['rd_qosmode', 0], ['qosmode', '应用'], ['token', TID]] }),
    (err) => err.code === 'UNCERTAIN',
  );
  // 会话没有被带坏: 正确的请求照常成功
  assert.equal((await conn.client.submit('loop.set', { enabled: true })).tip, '操作成功');
});

test('备份: 响应头与真机一致, 文件名带型号和时间', async () => {
  const conn = await parts.manager.connectionFor(id);
  const raw = await conn.client.sendRaw({ path: 'config_back.cgi', method: 'GET', send: 'query', fields: [['btnBackup', '配置备份'], ['token', TID]] });
  assert.equal(raw.headers['content-type'], 'application/octet-stream; name=config.cfg');
  assert.equal(raw.headers['content-disposition'], 'attachment; filename=config.cfg');
  assert.ok(raw.body.length > 0);

  const file = await parts.manager.backup(id);
  assert.ok(file.body.length > 0);
  assert.match(file.filename, /^TL-SG2008D_\d{8}-\d{6}\.cfg$/);
});

test('固件冲突检测: 真机的返回里同一个标志写了带引号和不带引号两遍, 两种写法都能认', async () => {
  const conn = await parts.manager.connectionFor(id);
  const fw = mock.V('fwupgradephase0');
  assert.equal(await conn.firmware.conflict(), false);
  fw.upgConflict = '1';
  try {
    assert.equal(await conn.firmware.conflict(), true);
  } finally {
    fw.upgConflict = '0';
  }
});

test('MAC 搜索: 没搜到时设备的提示是 "未找到MAC地址", 结果为空 (占位记录不算结果)', async () => {
  const res = await parts.manager.submit(id, 'mac.search', { mac: '00:11:22:33:44:55', vid: '' });
  assert.equal(res.tip, '未找到MAC地址');
  assert.deepEqual(res.data.results, []);
});

test('线缆检测: 返回页就是结果页, 提示是 "操作成功"', async () => {
  const res = await parts.manager.submit(id, 'cable.run', { ports: [8] });
  assert.equal(res.tip, '操作成功');
  assert.equal(res.data.results.find((r) => r.id === 8).state, 1);
});
