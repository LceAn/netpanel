// 新固件 JSON 适配器 (实验性): 用进程内的模拟 JetStream 交换机验证登录、读取模型、会话失效后的重试和只读约束。

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, before, test } from 'node:test';
import { APP_ROOT } from '../src/core/config.mjs';
import { normalizeError } from '../src/core/errors.mjs';
import { DeviceManager } from '../src/core/manager.mjs';
import { AdapterRegistry } from '../src/core/adapter.mjs';
import { openDeviceStore } from '../src/core/store/devices.mjs';
import { openSettings } from '../src/core/store/settings.mjs';
import { openVault } from '../src/core/store/vault.mjs';
import { registerAdapters } from '../src/adapters/index.mjs';
import { jsonAdapter } from '../src/adapters/tplink-json/index.mjs';
import { overview, parseUptime, pvidTable, portMembers, portNumber, portState, stats, system, vlanTable } from '../src/adapters/tplink-json/pages.mjs';
import { runCli } from '../src/cli/index.mjs';
import { createMockJsonSwitch } from '../scripts/mock-json-switch.mjs';
import { createMockSwitch } from '../scripts/mock-switch.mjs';

let mock;
let rpm; // 旧版固件的模拟器: 新适配器不应该认出它
const CREDS = { username: 'admin', password: 'admin' };

before(async () => {
  mock = await createMockJsonSwitch({ log: () => {} }).listen(0);
  rpm = await createMockSwitch().listen(0);
});
after(async () => {
  await mock.close();
  await rpm.close();
});

const connect = () => jsonAdapter.create({ url: mock.url, credentials: CREDS });

// ── 读取模型 ──────────────────────────────────────────────────────────

test('端口名与成员列表: "1/0/3"、逗号分隔、区间', () => {
  assert.equal(portNumber('1/0/3'), 3);
  assert.equal(portNumber('1/0/24'), 24);
  assert.equal(portNumber('2/0/1'), null, '其它单元的端口暂不支持');
  assert.equal(portNumber(''), null);
  assert.deepEqual(portMembers('1/0/1'), [1]);
  assert.deepEqual(portMembers('1/0/1,1/0/4'), [1, 4]);
  assert.deepEqual(portMembers('1/0/3-1/0/6'), [3, 4, 5, 6]);
  assert.deepEqual(portMembers(''), []);
  assert.deepEqual(portMembers('1/0/6-1/0/3'), [], '反了的区间忽略');
});

test('端口状态: 配置速率 / 双工 / 链路的取值编码换算成规范编码', () => {
  const row = { port: '1/0/1', state: 1, speedCfg: 0, speedLink: 3, duplexCfg: 1, duplexLink: 1, flowControl: 1, linkStatus: 1, lag: '1' };
  assert.deepEqual(portState(row), { id: 1, enabled: true, speedCfg: 1, speedAct: 6, flowCfg: 1, flowAct: 1, lag: 1 });
  // 链路断开: 实际速率 0, 实际流控 0
  assert.deepEqual(portState({ ...row, linkStatus: 0, lag: '' }), { id: 1, enabled: true, speedCfg: 1, speedAct: 0, flowCfg: 1, flowAct: 0, lag: 0 });
  // 禁用的端口
  assert.equal(portState({ ...row, state: 0 }).enabled, false);
  // 配置成 100M 半双工, 链路 100M
  assert.deepEqual(portState({ ...row, speedCfg: 3, duplexCfg: 2, speedLink: 2 }), { id: 1, enabled: true, speedCfg: 4, speedAct: 5, flowCfg: 1, flowAct: 1, lag: 1 });
  // 配置成 10M 全双工
  assert.equal(portState({ ...row, speedCfg: 2 }).speedCfg, 3);
  // 链路正常但速率代码不认识 → 按配置速率算, 不能当成断开
  assert.equal(portState({ ...row, speedCfg: 4, speedLink: 9 }).speedAct, 6);
  // 计数是字符串也行; 汇聚组标识的各种写法
  assert.equal(portState({ ...row, linkStatus: '1', lag: 'LAG2' }).lag, 2);
  assert.equal(portState({ port: '2/0/1' }), null);
});

test('运行时间: 带单位的写法和 天:时:分:秒 都认, 认不出是 null', () => {
  assert.equal(parseUptime('4d3h12m30s'), 4 * 86400 + 3 * 3600 + 12 * 60 + 30);
  assert.equal(parseUptime('4D 3H'), 4 * 86400 + 3 * 3600);
  assert.equal(parseUptime('4:3:12:30'), 4 * 86400 + 3 * 3600 + 12 * 60 + 30);
  assert.equal(parseUptime(''), null);
  assert.equal(parseUptime(null), null);
  assert.equal(parseUptime('about a week'), null);
});

test('VLAN 表与 PVID 表: member1 = Untagged, member2 = Tagged', () => {
  const vlans = [
    { vlanid: '20', name: 'office', member1: '1/0/3-1/0/5', member2: '1/0/1,1/0/2', key: 20 },
    { vlanid: 30, name: 'servers', member1: '1/0/6', member2: '', key: 30 },
    { vlanid: 0, name: '坏数据', member1: '', member2: '', key: 0 },
  ];
  const table = vlanTable(vlans, 8);
  assert.deepEqual(table.vlans, [
    { id: 20, name: 'office', tagged: [1, 2], untagged: [3, 4, 5] },
    { id: 30, name: 'servers', tagged: [], untagged: [6] },
  ]);
  assert.equal(table.enabled, true);
  assert.equal(table.portCount, 8);

  const pvid = pvidTable({
    pvidRows: [{ key: '1/0/2', pvid: 30, lag: '' }, { key: '1/0/3', pvid: '20', lag: 'LAG1' }, { key: '2/0/1', pvid: 1, lag: '' }],
    vlanRows: vlans,
    portCount: 8,
  });
  assert.deepEqual(pvid.ports, [{ id: 2, pvid: 30, lag: 0 }, { id: 3, pvid: 20, lag: 1 }]);
  assert.deepEqual(pvid.vlans, [{ id: 20, mask: '31' }, { id: 30, mask: '32' }]); // 端口 1-5 → 0b11111 = 31; 端口 6 → 32
});

test('端口统计: 带千位逗号的计数, 用前后两次的字节差算速率', () => {
  const row = { port: '1/0/1', state: 1, speedCfg: 0, speedLink: 3, duplexCfg: 1, linkStatus: 1 };
  const data = { pktsRx: '1,000', bytesRx: '10,000', errorsRx: '12', pktsTx: '2,000', bytesTx: '20,000', errorsTx: '3' };
  const first = stats([{ row, data }], null, 1_000_000);
  assert.deepEqual(first.data.ports, [{ id: 1, enabled: true, link: 6, txGood: 2000, txBad: 3, rxGood: 1000, rxBad: 12 }]);
  assert.equal(first.rates.get(1).rx, 0, '第一次没有上一次的数据, 速率是 0');

  const later = stats([{ row, data: { ...data, bytesRx: '110,000', bytesTx: '520,000' } }], first.rates && new Map([[1, { t: 1_000_000, rx: 10_000, tx: 20_000 }]]), 1_001_000);
  assert.equal(later.rates.get(1).rx, 800, '100 KB in 1 s = 800 Kbps');
  assert.equal(later.rates.get(1).tx, 4000, '500 KB in 1 s = 4000 Kbps');
  // 设备重启后计数变小: 不算出负的速率
  const reset = stats([{ row, data }], new Map([[1, { t: 1_001_000, rx: 110_000, tx: 520_000 }]]), 1_002_000);
  assert.equal(reset.rates.get(1).rx, 0);
});

// ── 客户端与适配器 ────────────────────────────────────────────────────

test('探测: 新版固件回答 JSON 信封 → 认得出; 旧版固件 / 普通网站 / 连不上 → 认不出', async () => {
  assert.equal(await jsonAdapter.probe({ url: mock.url }), true);
  assert.equal(await jsonAdapter.probe({ url: rpm.url }), false, '不能把旧版固件的设备认成新版');
  assert.equal(await jsonAdapter.probe({ url: 'http://127.0.0.1:9' }), false);
  assert.equal(await jsonAdapter.probe({ url: 'not a url' }), false);
  const plain = createServer((req, res) => res.end('<html>hello</html>')).listen(0);
  try {
    assert.equal(await jsonAdapter.probe({ url: `http://127.0.0.1:${plain.address().port}` }), false);
  } finally {
    plain.close();
  }
});

test('登录: 账号密码不对 → BAD_CREDENTIALS, 不会继续发请求', async () => {
  const bad = jsonAdapter.create({ url: mock.url, credentials: { username: 'admin', password: 'wrong' } });
  await assert.rejects(bad.read('system'), (err) => err.code === 'BAD_CREDENTIALS' && err.status === 401);
  assert.equal(mock.requests.length, 0);
  const conn = connect();
  await conn.read('system');
  assert.ok(conn.client.tid);
  await conn.logout();
  assert.equal(conn.client.tid, null);
  assert.equal(mock.sessions.size, 0, '退出后释放设备上的会话');
});

test('会话失效 (设备重启 / 超时): 自动重新登录并重试一次', async () => {
  const conn = connect();
  await conn.read('system');
  const first = conn.client.tid;
  const logins = mock.logins.ok;
  mock.expireSessions();
  const info = await conn.read('system');
  assert.equal(info.data.model, 'TL-MOCK-24');
  assert.notEqual(conn.client.tid, first, '换了新的会话令牌');
  assert.equal(mock.logins.ok, logins + 1, '只重新登录了一次');
  await conn.logout();
});

test('识别设备: 读出型号、固件、硬件版本、MAC 和端口数', async () => {
  const conn = connect();
  try {
    assert.deepEqual(await conn.identify(), {
      model: 'TL-MOCK-24',
      firmware: '3.0.3 Build 20260110 Rel.70001',
      hardware: 'V1',
      mac: '02:00:5E:02:00:01',
      ports: 24,
      description: 'JetStream 24-Port Gigabit Smart Switch (模拟)',
    });
  } finally {
    await conn.logout();
  }
});

test('读取: 概览、系统信息、端口配置、VLAN、PVID 的结构符合规范模型', async () => {
  const conn = connect();
  try {
    const { data: ov } = await conn.read('overview');
    assert.equal(ov.maxPorts, 24);
    assert.equal(ov.device.model, 'TL-MOCK-24');
    assert.equal(ov.device.uptime, 4 * 86400 + 3 * 3600 + 12 * 60 + 30);
    assert.equal(ov.device.uptimeText, '4d3h12m30s');
    assert.deepEqual(ov.cloud, { enabled: false, connected: false });
    assert.equal(ov.flags.showLag, true);
    assert.equal(ov.ports.length, 24);
    assert.deepEqual(ov.ports[0], { id: 1, enabled: true, speedCfg: 1, speedAct: 6, flowCfg: 0, flowAct: 0, lag: 0, vlans: null, loop: 'off', rxKbps: 0, txKbps: 0 });
    assert.equal(ov.ports[2].speedAct, 5, '一百兆的口');
    assert.equal(ov.ports[7].enabled, false);
    assert.deepEqual([ov.ports[22].lag, ov.ports[23].lag], [1, 1]);

    assert.equal((await conn.read('system')).data.hardware, 'V1');
    const ports = (await conn.read('ports')).data.ports;
    assert.equal(ports.length, 24);
    assert.equal(ports[7].enabled, false);

    const vlans = (await conn.read('vlan8021q')).data;
    assert.deepEqual(vlans.vlans.map((v) => [v.id, v.name, v.untagged.length, v.tagged]), [[1, 'default', 12, []], [20, 'office', 10, [1]], [30, 'servers', 2, [1]]]); // 默认 VLAN: 不在其它 VLAN 里的 12 个口
    const pvid = (await conn.read('vlanPvid')).data;
    assert.equal(pvid.ports.length, 24);
    assert.deepEqual([pvid.ports[0].pvid, pvid.ports[5].pvid, pvid.ports[23]], [1, 20, { id: 24, pvid: 30, lag: 1 }]);
    assert.equal(vlans.vlans.length, 3);

    await assert.rejects(conn.read('vlanMtu'), (err) => err.code === 'UNSUPPORTED');
    assert.ok(await conn.ping());
  } finally {
    await conn.logout();
  }
});

test('统计: 每个端口查一次; 第二次之后概览里就有了速率', async () => {
  const conn = connect();
  try {
    const before = mock.requests.length;
    const { data } = await conn.read('stats');
    assert.equal(data.ports.length, 24);
    assert.equal(data.ports[0].rxBad, 12);
    assert.equal(data.ports[0].txBad, 3);
    assert.equal(mock.requests.length - before, 1 + 24, '端口列表 + 每个端口一次');
    // 速率是用前后两次读数的字节差算的: 间隔太短时, 请求本身的耗时会让误差变大, 所以等 3 秒再看
    await new Promise((r) => setTimeout(r, 3000));
    await conn.read('stats');
    const { data: ov } = await conn.read('overview');
    assert.ok(ov.ports[0].rxKbps > 0 && ov.ports[0].txKbps > 0, `端口 1 的速率 ${ov.ports[0].rxKbps}/${ov.ports[0].txKbps}`);
    assert.equal(ov.ports[3].rxKbps, 0, '没有流量的口速率为 0');
    assert.ok(ov.ports[0].rxKbps > 7680 * 0.7 && ov.ports[0].rxKbps < 7680 * 1.3, `模拟器给端口 1 的接收是 960 KB/s ≈ 7680 Kbps, 实际 ${ov.ports[0].rxKbps}`);
  } finally {
    await conn.logout();
  }
});

test('只读: 适配器不声明任何写操作和能力; 响应不是 JSON 时报 BAD_RESPONSE; 连不上报 OFFLINE', async () => {
  assert.deepEqual(jsonAdapter.writes, []);
  assert.deepEqual(jsonAdapter.features, []);
  assert.equal(jsonAdapter.maturity, 'experimental');

  const html = createServer((req, res) => res.end('<html><script>var logonInfo = new Array(5,0,0);</script></html>')).listen(0);
  try {
    const conn = jsonAdapter.create({ url: `http://127.0.0.1:${html.address().port}`, credentials: CREDS });
    await assert.rejects(conn.read('system'), (err) => err.code === 'BAD_RESPONSE' && /JSON/.test(err.message));
  } finally {
    html.close();
  }
  const down = jsonAdapter.create({ url: 'http://127.0.0.1:9', credentials: CREDS });
  await assert.rejects(down.read('system'), (err) => err.code === 'OFFLINE');
  assert.equal(await down.ping().then(() => 'ok', (err) => normalizeError(err).code), 'OFFLINE');
});

// ── 接入面板 ──────────────────────────────────────────────────────────

test('设备管理器: 自动识别出新适配器, 后台轮询概览和统计, 写操作被拒绝', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'netpanel-json-'));
  const registry = registerAdapters(new AdapterRegistry());
  const settings = openSettings(join(dir, 'settings.json'));
  const store = openDeviceStore(join(dir, 'devices.json'), openVault(join(dir, 'secret.key')), { adapterExists: (id) => registry.has(id) });
  const manager = new DeviceManager({ store, adapters: registry, settings, log: () => {} });
  try {
    assert.equal((await registry.detect(mock.url)).id, 'tplink-json');
    assert.equal((await registry.detect(rpm.url)).id, 'tplink-rpm', '两代设备各归各的适配器');
    const device = await manager.add({ name: '机房 JetStream', url: mock.url, ...CREDS });
    assert.equal(device.adapter, 'tplink-json');
    assert.equal(device.adapterMaturity, 'experimental');
    assert.equal(device.portCount, 24);
    assert.deepEqual(Object.keys(device.capabilities).sort(), ['features', 'reads', 'writes']);
    assert.deepEqual(device.capabilities.writes, []);

    await manager.start();
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && manager.describe(device.id).health !== 'online') await new Promise((r) => setTimeout(r, 100));
    const d = manager.describe(device.id);
    assert.equal(d.health, 'online');
    assert.equal(d.portsUp, 24 - 1, '被禁用的端口不算在线');
    await assert.rejects(manager.submit(device.id, 'loop.set', { enabled: false }), (err) => err.code === 'UNSUPPORTED');
    assert.equal(mock.requests.filter((r) => !['version', 'systemSummaryConfig', 'port', 'trafficMonitorCfgDetailModel', 'vlanCfg', 'vlanPortCfg', 'vlanPortDetailCfg'].includes(r.endpoint)).length, 0, '只读过接口, 没有发过任何写请求');
  } finally {
    await manager.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('命令行: --url 自动选到新适配器; 写操作因为是只读适配器而被拒绝', async () => {
  const sink = () => {
    const stream = new PassThrough();
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    return { stream, text: () => Buffer.concat(chunks).toString('utf8') };
  };
  const cli = async (args) => {
    const out = sink();
    const err = sink();
    const stdin = new PassThrough();
    const code = await runCli(args, { env: { NETPANEL_PASSWORD: CREDS.password }, stdin, stdout: out.stream, stderr: err.stream, appRoot: APP_ROOT });
    return { code, out: out.text(), err: err.text() };
  };
  const url = ['--url', mock.url, '--user', CREDS.username];
  const status = await cli([...url, 'status']);
  assert.equal(status.code, 0);
  assert.match(status.out, /TL-MOCK-24/);
  assert.match(status.out, /1000M 全双工/);
  const vlans = await cli([...url, 'vlans']);
  assert.match(vlans.out, /office/);
  const write = await cli([...url, 'port', 'disable', '--ports', '8', '--yes']);
  assert.equal(write.code, 1);
  assert.match(write.err, /不支持操作|不支持/);
  const ops = await cli([...url, 'ops']);
  assert.match(ops.out, /\(空\)/);
  const scratch = mkdtempSync(join(tmpdir(), 'netpanel-cli-')); // adapters 命令要打开面板, 给它一个用完就删的数据目录
  try {
    const adapters = await cli(['--url', mock.url, '--data-dir', scratch, 'adapters']);
    assert.match(adapters.out, /tplink-json\s+TP-LINK JetStream 新版 Web 界面\s+TP-LINK\s+experimental/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
