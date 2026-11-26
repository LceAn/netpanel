// 端到端: 真实的适配器 + 进程内的模拟交换机 + 真实监听的面板 + 临时数据目录, 不用任何假的部件。
// 走一遍: 初始化 → 登录 → 绑定设备 → 后台轮询 → 读页面 → 写操作 → 指标接口 → 设备掉线与恢复。

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { APP_ROOT } from '../src/core/config.mjs';
import { createPanel, openPanel } from '../src/http/server.mjs';
import { createMockSwitch } from '../scripts/mock-switch.mjs';

const ADMIN = { username: 'admin', password: 'panel-password' };
const CSRF = { 'X-Requested-With': 'netpanel' };
const MAC = '02:00:5E:01:02:03'; // 合成夹具里的虚构地址

let mock;
let dir;
let parts;
let panel;
let base;
let cookie;
let deviceId;
let metricsToken;

before(async () => {
  mock = await createMockSwitch({ profile: 'lab' }).listen(0);
  dir = mkdtempSync(join(tmpdir(), 'netpanel-e2e-'));
  parts = openPanel({ appRoot: APP_ROOT, env: { PANEL_DATA_DIR: dir }, log: () => {} });
  panel = createPanel({ manager: parts.manager, auth: parts.auth, settings: parts.settings, firmware: parts.firmware, log: () => {} });
  await panel.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${panel.server.address().port}`;
  await parts.manager.start();
});
after(async () => {
  await parts.close();
  await panel.close();
  await mock.close();
  rmSync(dir, { recursive: true, force: true });
});

const call = async (method, path, { body, headers = {}, auth = true, raw = false } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(method === 'GET' ? {} : CSRF),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(auth && cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  cookie = res.headers.get('set-cookie')?.split(';')[0] ?? cookie;
  const text = await res.text();
  let json = null;
  if (!raw) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: res.status, json, text, headers: res.headers };
};
const metrics = (token) => call('GET', '/metrics', { auth: false, raw: true, headers: token ? { Authorization: `Bearer ${token}` } : {} });

/** 等到条件成立 (最多 8 秒); 不成立返回最后一次的值。 */
async function until(read, ok, ms = 8000) {
  const end = Date.now() + ms;
  let value;
  while (Date.now() < end) {
    value = await read();
    if (ok(value)) return value;
    await new Promise((r) => setTimeout(r, 200));
  }
  return value;
}

test('初始化向导: 未登录时只告诉面板要不要初始化; 跨站的初始化请求被拒绝', async () => {
  const status = await call('GET', '/api/status', { auth: false });
  assert.deepEqual(status.json, { setupRequired: true, authed: false, user: null });
  assert.equal((await call('GET', '/api/devices', { auth: false })).status, 401);
  const crossSite = await fetch(`${base}/api/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ADMIN) });
  assert.equal(crossSite.status, 403, '没有自定义请求头的请求 (表单 / 跨站) 不能改动面板');

  const setup = await call('POST', '/api/setup', { body: ADMIN, auth: false });
  assert.equal(setup.status, 200);
  assert.equal(setup.json.user, 'admin');
  assert.ok(cookie.startsWith('netpanel_session='), '初始化后直接登录');
  assert.deepEqual((await call('GET', '/api/status')).json, { setupRequired: false, authed: true, user: 'admin' });
  assert.equal((await call('POST', '/api/setup', { body: ADMIN })).status, 409, '不能初始化两次');
});

test('登录: 密码不对 401; 正确后发会话 Cookie; 退出后失效', async () => {
  const saved = cookie;
  const bad = await call('POST', '/api/login', { body: { username: 'admin', password: 'nope' }, auth: false });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.code, 'BAD_CREDENTIALS');
  assert.equal((await call('POST', '/api/login', { body: ADMIN, auth: false })).status, 200);
  assert.ok(cookie.startsWith('netpanel_session='));
  assert.equal((await fetch(`${base}/api/status`, { headers: { Cookie: cookie } })).headers.get('set-cookie'), null, '普通请求不续发 Cookie');
  await call('POST', '/api/logout', { headers: { Cookie: saved } });
  const stale = await fetch(`${base}/api/status`, { headers: { Cookie: saved } });
  assert.equal((await stale.json()).authed, false, '退出的会话立即失效');
  assert.equal((await call('POST', '/api/login', { body: ADMIN, auth: false })).status, 200, '重新登录, 后面的测试继续用');
});

test('绑定设备: 设备密码不对只影响这台设备 (502), 面板登录态不受影响; 正确时识别出型号', async () => {
  const bad = await call('POST', '/api/devices', { body: { name: '客厅', url: mock.url, username: 'admin', password: 'wrong-password', tags: ['家里'] } });
  assert.equal(bad.status, 502);
  assert.match(bad.json.error, /用户名或密码错误/);
  assert.equal((await call('GET', '/api/status')).json.authed, true, '设备凭据错误不能把人踢出面板');
  assert.equal((await call('POST', '/api/devices', { body: { name: '客厅', url: 'not-a-url', username: 'admin', password: 'x' } })).status, 400);

  const added = await call('POST', '/api/devices', { body: { name: '客厅', url: mock.url, username: 'admin', password: 'admin', tags: ['家里'], notes: '机柜 A' } });
  assert.equal(added.status, 200);
  deviceId = added.json.id;
  assert.match(deviceId, /^d_[0-9a-f]{10}$/);
  assert.equal(added.json.model, 'TL-SG2008D');
  assert.equal(added.json.portCount, 8);
  assert.equal(added.json.mac, MAC);
  assert.equal(added.json.health, 'unknown');
  assert.equal(added.json.hasSecret, true);
  assert.equal(added.json.password, undefined, '设备密码不回传给浏览器');
  assert.equal((await call('POST', '/api/devices', { body: { name: '客厅', url: mock.url, username: 'admin', password: 'admin' } })).status, 409, '名称不能重复');
});

test('后台轮询: 不用任何浏览器打开页面, 面板自己把设备轮询成在线', async () => {
  assert.equal((await call('POST', '/api/settings', { body: { pollIntervalSec: 5, statsIntervalSec: 10 } })).status, 200, '把轮询间隔调到最小, 测试不用等 15 秒');
  const dash = await until(
    () => call('GET', '/api/dashboard').then((r) => r.json),
    (d) => d.devices[0]?.history.length >= 2,
    15000,
  );
  const d = dash.devices[0];
  assert.equal(d.health, 'online');
  assert.equal(d.portsUp, 8, 'lab 配置里所有口都有链路');
  assert.ok(d.rxKbps > 0 && d.txKbps > 0);
  assert.ok(d.history.length >= 2);
  assert.equal(d.cloud.connected, true);
  assert.equal(dash.totals.online, 1);
  assert.equal(dash.totals.ports, 8);
  assert.equal((await call('GET', '/api/devices')).json.devices.length, 1);
});

test('读设备: 概览走缓存, 功能页实时读取并归一化', async () => {
  const overview = await call('GET', `/api/devices/${deviceId}/overview`);
  assert.equal(overview.json.cached, true, '默认读后台轮询的缓存');
  assert.equal(overview.json.data.ports.length, 8);
  const live = await call('GET', `/api/devices/${deviceId}/overview?live=1`);
  assert.equal(live.json.cached, false);

  const pages = await call('GET', `/api/devices/${deviceId}/pages?keys=vlan8021q,lag,qosBandwidth,loop`);
  assert.equal(pages.status, 200);
  assert.deepEqual(pages.json.vlan8021q.vlans.map((v) => v.id), [1, 10, 20, 30]);
  assert.deepEqual(pages.json.lag.groups.find((g) => g.id === 1).members, [7, 8]);
  assert.equal(pages.json.qosBandwidth.ports[5].ingress, 2048);
  const unsupported = await call('GET', `/api/devices/${deviceId}/pages?keys=nope`);
  assert.equal(unsupported.json.code, 'UNSUPPORTED', '不支持的模型键');
  assert.equal((await call('GET', '/api/devices/d_0000000000/overview')).status, 404);
  assert.equal((await call('GET', '/api/devices/../../etc/passwd/overview')).status, 404);

  const search = await call('POST', `/api/devices/${deviceId}/mac-search`, { body: { mac: 'aa:bb:cc:dd:ee:ff', vid: '' } });
  assert.deepEqual(search.json.data, { qvlan: true, results: [{ mac: 'AA:BB:CC:DD:EE:FF', vid: 10, port: 3 }] });
});

test('写操作: 校验不通过的请求到不了交换机; 合法的写操作按原厂表单编码发出', async () => {
  const before = mock.writes.length;
  const unconfirmed = await call('POST', `/api/devices/${deviceId}/op`, { body: { op: 'system.reboot', params: { save: true } } });
  assert.equal(unconfirmed.status, 400);
  assert.match(unconfirmed.json.error, /该操作需要明确确认/);
  const invalid = await call('POST', `/api/devices/${deviceId}/op`, { body: { op: 'vlan.q.set', params: { vid: 5000, name: '', tagged: [], untagged: [1] } } });
  assert.equal(invalid.status, 400);
  assert.deepEqual(invalid.json.details, ['VLAN ID 取值范围为 1-4094']);
  assert.equal((await call('POST', `/api/devices/${deviceId}/op`, { body: { op: 'not.an.op', params: {} } })).status, 404);
  assert.equal(mock.writes.length, before, '以上请求都不能到达交换机');

  const ok = await call('POST', `/api/devices/${deviceId}/op`, { body: { op: 'loop.set', params: { enabled: false } } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.fresh.loop.enabled, false, '返回里带回回读的结果');
  const write = mock.writes.find((w) => w.path === 'loop_prevention_set.cgi');
  assert.equal(write.fields.find(([k]) => k === 'lpEn')?.[1], '0');
  assert.equal((await call('GET', `/api/devices/${deviceId}/pages?keys=loop`)).json.loop.enabled, false);
});

test('指标接口: 需要 Bearer 令牌; 令牌不随设置下发; 输出 Prometheus 文本格式', async () => {
  const none = await metrics();
  assert.equal(none.status, 401);
  assert.equal(none.headers.get('www-authenticate'), 'Bearer realm="netpanel"');
  assert.equal((await metrics('wrong-token')).status, 401);
  assert.equal((await call('POST', '/metrics', { auth: false })).status, 405);

  const settings = await call('GET', '/api/settings');
  assert.equal(settings.json.settings.pollIntervalSec, 5, '前面测试里改过的设置已持久化');
  assert.equal(settings.json.settings.metricsToken, undefined, '令牌只能从专用接口取');
  metricsToken = (await call('GET', '/api/settings/metrics-token')).json.metricsToken;
  assert.match(metricsToken, /^[A-Za-z0-9_-]{32}$/);
  assert.equal((await call('GET', '/api/settings/metrics-token', { auth: false })).status, 401);

  const res = await metrics(metricsToken);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/plain; version=0\.0\.4/);
  const id = `device="${deviceId}",name="客厅"`;
  assert.match(res.text, new RegExp(`^switch_up\\{${id}\\} 1$`, 'm'));
  assert.match(res.text, new RegExp(`^switch_port_up\\{${id},port="1"\\} 1$`, 'm'));
  assert.match(res.text, new RegExp(`^switch_port_speed_bytes\\{${id},port="1"\\} 125000000$`, 'm'), '1000M 链路 = 125 MB/s');
  assert.match(res.text, new RegExp(`^switch_info\\{[^}]*model="TL-SG2008D"[^}]*\\} 1$`, 'm'));
  assert.match(res.text, /^netpanel_up 1$/m);
  assert.match(res.text, /^switch_port_rx_packets_total\{/m, '端口统计也在缓存里');
  const head = await fetch(`${base}/metrics`, { method: 'HEAD', headers: { Authorization: `Bearer ${metricsToken}` } });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('设备掉线: 偶发一次失败不算离线, 连续失败才标成离线; 指标里 switch_up 变 0, 不再输出端口', async () => {
  const port = mock.server.address().port;
  await mock.close();
  await parts.manager.refresh(deviceId);
  assert.equal(parts.manager.describe(deviceId).health, 'online', '之前在线的设备偶发一次连不上不算离线');
  await parts.manager.refresh(deviceId);
  assert.equal(parts.manager.describe(deviceId).health, 'offline');

  const dash = await call('GET', '/api/dashboard');
  assert.equal(dash.json.totals.offline, 1);
  assert.equal(dash.json.devices[0].lastOk > 0, true);
  const text = (await metrics(metricsToken)).text;
  assert.match(text, new RegExp(`^switch_up\\{device="${deviceId}",name="客厅"\\} 0$`, 'm'));
  assert.doesNotMatch(text, /^switch_port_up\{/m);

  // 交换机回来之后自动恢复
  await mock.listen(port);
  await parts.manager.refresh(deviceId);
  assert.equal(parts.manager.describe(deviceId).health, 'online');
  assert.match((await metrics(metricsToken)).text, /^switch_port_up\{/m);
});

test('停用 / 修改 / 删除设备', async () => {
  assert.equal((await call('PATCH', `/api/devices/${deviceId}`, { body: { enabled: false } })).json.health, 'disabled');
  assert.equal((await call('GET', `/api/devices/${deviceId}/pages?keys=loop`)).status, 409, '停用后不再访问设备');
  assert.equal((await call('GET', '/api/dashboard')).json.totals.disabled, 1);
  const renamed = await call('PATCH', `/api/devices/${deviceId}`, { body: { enabled: true, name: '客厅交换机', tags: ['家里', '客厅'], pollIntervalSec: 20 } });
  assert.equal(renamed.json.name, '客厅交换机');
  assert.equal(renamed.json.pollIntervalSec, 20);
  assert.equal(renamed.json.health, 'unknown', '重新启用后等下一次轮询');
  assert.equal((await call('PATCH', `/api/devices/${deviceId}`, { body: { pollIntervalSec: 1 } })).status, 400);
  const again = await call('POST', `/api/devices/${deviceId}/test`, { body: {} });
  assert.equal(again.json.identified.mac, MAC);
  assert.equal((await call('DELETE', `/api/devices/${deviceId}`)).status, 200);
  assert.equal((await call('GET', `/api/devices/${deviceId}`)).status, 404);
  assert.equal((await call('GET', '/api/dashboard')).json.totals.total, 0);
});
