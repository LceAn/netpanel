// HTTP 接口: 起一个真实监听的面板 (临时端口 + 临时数据目录 + 假适配器), 用真实请求走一遍主要路径。

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createPanel } from '../src/http/server.mjs';
import { PanelAuth } from '../src/http/auth.mjs';
import { DeviceManager } from '../src/core/manager.mjs';
import { FirmwareManager } from '../src/core/device-service.mjs';
import { openDeviceStore } from '../src/core/store/devices.mjs';
import { openVault } from '../src/core/store/vault.mjs';
import { openUserStore } from '../src/core/store/users.mjs';
import { openSettings } from '../src/core/store/settings.mjs';
import { makeWorld } from '../testkit/fake-adapter.mjs';

const ADMIN = { username: 'admin', password: 'panel-password' };
const CSRF = { 'X-Requested-With': 'netpanel' };

async function startPanel() {
  const dir = mkdtempSync(join(tmpdir(), 'netpanel-http-'));
  const world = makeWorld();
  const vault = openVault(join(dir, 'secret.key'));
  const settings = openSettings(join(dir, 'settings.json'));
  const store = openDeviceStore(join(dir, 'devices.json'), vault, { adapterExists: (id) => world.registry.has(id) });
  const manager = new DeviceManager({ store, adapters: world.registry, settings, log: () => {} });
  const firmware = new FirmwareManager();
  const auth = new PanelAuth({ users: openUserStore(join(dir, 'auth.json')) });
  const panel = createPanel({ manager, auth, settings, firmware, log: () => {} });
  await panel.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${panel.server.address().port}`;

  /** 发请求。JSON 响应会解析到 json; set-cookie 的第一条放到 res.cookie。 */
  const call = async (method, path, { body, cookie, headers = {}, raw = false } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(method === 'GET' ? {} : CSRF),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    const text = await res.text();
    let json = null;
    if (!raw) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { status: res.status, json, text, headers: res.headers, cookie: res.headers.get('set-cookie')?.split(';')[0] ?? null };
  };

  return {
    world,
    manager,
    auth,
    settings,
    firmware,
    panel,
    call,
    stop: async () => {
      await manager.stop();
      await panel.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

let P;
let cookie = null; // 已登录面板的 Cookie

before(async () => {
  P = await startPanel();
});

after(async () => {
  await P?.stop();
});

test('未登录: status 只回答"要不要初始化、登没登录"; 其它接口一律 401, 不泄露设备信息', async () => {
  const st = await P.call('GET', '/api/status');
  assert.equal(st.status, 200);
  assert.deepEqual(st.json, { setupRequired: true, authed: false, user: null });
  for (const [method, path] of [['GET', '/api/devices'], ['GET', '/api/dashboard'], ['GET', '/api/devices/d_0123456789'], ['POST', '/api/devices'], ['GET', '/api/settings']]) {
    const res = await P.call(method, path, { body: method === 'POST' ? {} : undefined });
    assert.equal(res.status, 401, `${method} ${path}`);
    assert.equal(res.json.code, 'UNAUTHENTICATED');
    assert.ok(!JSON.stringify(res.json).includes('192.0.2'), '未登录的响应里不能出现设备地址');
  }
});

test('防跨站: 没带自定义请求头、或来源不同源的写请求一律 403', async () => {
  const noHeader = await P.call('POST', '/api/setup', { body: ADMIN, headers: { 'X-Requested-With': '' } });
  assert.equal(noHeader.status, 403);
  const cross = await P.call('POST', '/api/setup', { body: ADMIN, headers: { Origin: 'https://evil.example' } });
  assert.equal(cross.status, 403);
  assert.equal(cross.json.code, 'CSRF');
  const same = await P.call('POST', '/api/status');
  assert.equal(same.status, 405); // 存在这个路径, 但不支持 POST
});

test('初始化: 创建管理员并自动登录; 密码太短被拒; 不能重复初始化', async () => {
  const weak = await P.call('POST', '/api/setup', { body: { username: 'admin', password: 'short' } });
  assert.equal(weak.status, 400);
  assert.equal(weak.json.code, 'BAD_PARAM');
  const bad = await P.call('POST', '/api/setup', { body: { username: 'a b', password: 'panel-password' } });
  assert.equal(bad.status, 400);
  assert.equal(P.auth.setupRequired, true, '失败的初始化不能留下半截账号');

  const res = await P.call('POST', '/api/setup', { body: ADMIN });
  assert.equal(res.status, 200);
  assert.equal(res.json.user, 'admin');
  assert.match(res.cookie, /^netpanel_session=[\w-]+$/);
  const setCookie = res.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);

  const again = await P.call('POST', '/api/setup', { body: ADMIN, cookie: res.cookie });
  assert.equal(again.status, 409);
  assert.equal((await P.call('GET', '/api/status')).json.setupRequired, false);
});

test('登录: 密码错误 401; 正确后拿到 Cookie; 响应带安全头', async () => {
  const bad = await P.call('POST', '/api/login', { body: { username: 'admin', password: 'nope-nope' } });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.code, 'BAD_CREDENTIALS');
  assert.equal(bad.cookie, null);
  const nobody = await P.call('POST', '/api/login', { body: { username: 'who', password: 'panel-password' } });
  assert.equal(nobody.status, 401);

  const res = await P.call('POST', '/api/login', { body: ADMIN });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"), true);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  cookie = res.cookie;
  const st = await P.call('GET', '/api/status', { cookie });
  assert.deepEqual(st.json, { setupRequired: false, authed: true, user: 'admin' });
  const forged = await P.call('GET', '/api/devices', { cookie: 'netpanel_session=forged' });
  assert.equal(forged.status, 401);
});

let deviceId;

test('设备管理: 添加 / 列表 / 详情 / 刷新 / 历史 / 测试连接 / 修改', async () => {
  const d = P.world.makeDevice('http://192.0.2.10', { model: 'FAKE-8' });
  P.world.devices.set(d.url, d);

  const bad = await P.call('POST', '/api/devices', { cookie, body: { name: '', url: 'nope', username: 'a', password: 'b' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, '设备地址格式不正确，应形如 http://192.168.1.1');

  const wrongPw = await P.call('POST', '/api/devices', { cookie, body: { name: '机房', url: d.url, username: 'admin', password: 'wrong' } });
  assert.equal(wrongPw.status, 502, '设备密码错误不是面板登录问题, 不能返回 401 (否则前端会误以为要重新登录面板)');
  assert.equal(wrongPw.json.code, 'BAD_CREDENTIALS');
  assert.match(wrongPw.json.error, /用户名或密码错误.*192\.0\.2\.10/);

  const added = await P.call('POST', '/api/devices', { cookie, body: { name: '机房', url: d.url + '/', username: 'admin', password: 'pw', tags: ['lab'], notes: '.first' } });
  assert.equal(added.status, 200);
  deviceId = added.json.id;
  assert.match(deviceId, /^d_[0-9a-f]{10}$/);
  assert.equal(added.json.url, 'http://192.0.2.10');
  assert.equal(added.json.model, 'FAKE-8');
  assert.equal(added.json.portCount, 8);
  assert.equal(added.json.health, 'unknown');
  assert.ok(!JSON.stringify(added.json).includes('"password"'));
  assert.ok(!JSON.stringify(added.json).includes('"secret"'));

  const dup = await P.call('POST', '/api/devices', { cookie, body: { name: '机房 ', url: d.url, username: 'admin', password: 'pw' } });
  assert.equal(dup.status, 409);

  const list = await P.call('GET', '/api/devices', { cookie });
  assert.equal(list.json.devices.length, 1);
  const one = await P.call('GET', `/api/devices/${deviceId}`, { cookie });
  assert.equal(one.json.name, '机房');
  assert.deepEqual(one.json.capabilities.writes, ['loop.set']);

  const refreshed = await P.call('POST', `/api/devices/${deviceId}/refresh`, { cookie });
  assert.equal(refreshed.json.health, 'online');
  assert.equal(refreshed.json.portsUp, 3);
  const hist = await P.call('GET', `/api/devices/${deviceId}/history`, { cookie });
  assert.equal(hist.json.history.length, 1);
  assert.equal(hist.json.history[0].rx, 3600);

  const tested = await P.call('POST', `/api/devices/${deviceId}/test`, { cookie, body: {} });
  assert.equal(tested.status, 200);
  assert.equal(tested.json.identified.model, 'FAKE-8');
  assert.equal(tested.json.adapter.id, 'fake');
  const testedBad = await P.call('POST', `/api/devices/${deviceId}/test`, { cookie, body: { password: 'nope' } });
  assert.equal(testedBad.status, 502);

  const probed = await P.call('POST', '/api/probe', { cookie, body: { url: d.url } });
  assert.equal(probed.json.adapter.id, 'fake');
  const probedNone = await P.call('POST', '/api/probe', { cookie, body: { url: 'http://192.0.2.99' } });
  assert.equal(probedNone.json.adapter, null);

  const patched = await P.call('PATCH', `/api/devices/${deviceId}`, { cookie, body: { name: '机房 A', notes: '改过了', password: '' } });
  assert.equal(patched.json.name, '机房 A');
  assert.equal(patched.json.notes, '改过了');
  assert.equal(P.manager.store.credentials(deviceId).password, 'pw', '留空密码 = 不改');

  for (const id of ['nope', 'd_123', '__proto__', 'd_012345678z']) {
    assert.equal((await P.call('GET', `/api/devices/${id}`, { cookie })).status, 404, id);
  }
  const missing = await P.call('GET', '/api/devices/d_0000000000', { cookie });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.code, 'NOT_FOUND');
});

test('访问设备: overview / pages / stats / ping / 写操作 (校验与回读)', async () => {
  const d = P.world.devices.get('http://192.0.2.10');
  d.reads.length = 0;

  const cached = await P.call('GET', `/api/devices/${deviceId}/overview`, { cookie });
  assert.equal(cached.json.cached, true, '后台刚轮询过, 默认用缓存');
  assert.equal(cached.json.data.ports.length, 8);
  const live = await P.call('GET', `/api/devices/${deviceId}/overview?live=1`, { cookie });
  assert.equal(live.json.cached, false);
  assert.deepEqual(d.reads, ['overview']);

  const pages = await P.call('GET', `/api/devices/${deviceId}/pages?keys=system,loop`, { cookie });
  assert.deepEqual(pages.json, { system: { model: 'FAKE-8', firmware: 'fw-1.0' }, loop: { enabled: false } });
  assert.equal((await P.call('GET', `/api/devices/${deviceId}/pages?keys=`, { cookie })).status, 400);
  assert.equal((await P.call('GET', `/api/devices/${deviceId}/pages?keys=vlan8021q`, { cookie })).status, 400, '设备不支持的页面');

  const stats = await P.call('GET', `/api/devices/${deviceId}/stats/3`, { cookie });
  assert.equal(stats.json.port, 3);
  assert.equal((await P.call('GET', `/api/devices/${deviceId}/stats/0`, { cookie })).status, 400);
  assert.equal((await P.call('GET', `/api/devices/${deviceId}/stats/999`, { cookie })).status, 400);
  assert.equal((await P.call('GET', `/api/devices/${deviceId}/ping`, { cookie })).json.online, true);

  const badOp = await P.call('POST', `/api/devices/${deviceId}/op`, { cookie, body: { op: 'loop.set', params: { enabled: 'yes' } } });
  assert.equal(badOp.status, 400);
  assert.deepEqual(badOp.json.details, ['参数不完整']);
  const unsupported = await P.call('POST', `/api/devices/${deviceId}/op`, { cookie, body: { op: 'system.reboot', params: { save: true, confirm: true } } });
  assert.equal(unsupported.status, 400);
  assert.equal(unsupported.json.code, 'UNSUPPORTED');
  assert.equal((await P.call('POST', `/api/devices/${deviceId}/op`, { cookie, body: { op: '__proto__', params: {} } })).status, 404);

  const op = await P.call('POST', `/api/devices/${deviceId}/op`, { cookie, body: { op: 'loop.set', params: { enabled: true } } });
  assert.equal(op.status, 200);
  assert.equal(op.json.ok, true);
  assert.equal(op.json.tip, 'ok');
  assert.equal(op.json.fresh.loop.enabled, false);

  // 设备离线: 报错里带着设备信息, 且不影响面板登录态
  d.online = false;
  const gone = await P.call('GET', `/api/devices/${deviceId}/pages?keys=system`, { cookie });
  assert.equal(gone.status, 502);
  assert.equal(gone.json.code, 'OFFLINE');
  assert.equal((await P.call('GET', '/api/status', { cookie })).json.authed, true);
  const dash = await P.call('GET', '/api/dashboard', { cookie });
  assert.equal(dash.json.devices[0].health, 'offline');
  d.online = true;
});

test('停用的设备: 不能访问; 总览里标成已停用', async () => {
  await P.call('PATCH', `/api/devices/${deviceId}`, { cookie, body: { enabled: false } });
  const res = await P.call('GET', `/api/devices/${deviceId}/overview`, { cookie });
  assert.equal(res.status, 409);
  assert.equal(res.json.code, 'DISABLED');
  assert.equal((await P.call('GET', '/api/dashboard', { cookie })).json.totals.disabled, 1);
  await P.call('PATCH', `/api/devices/${deviceId}`, { cookie, body: { enabled: true } });
});

test('设置: 读取、修改、范围校验; 指标令牌只能通过专用接口更换', async () => {
  const got = await P.call('GET', '/api/settings', { cookie });
  assert.equal(got.json.settings.pollIntervalSec, 15);
  const set = await P.call('POST', '/api/settings', { cookie, body: { pollIntervalSec: 30 } });
  assert.equal(set.json.settings.pollIntervalSec, 30);
  assert.equal((await P.call('POST', '/api/settings', { cookie, body: { pollIntervalSec: 0 } })).status, 400);
  const token = await P.call('POST', '/api/settings/metrics-token', { cookie });
  assert.match(token.json.metricsToken, /^[\w-]{32,}$/);
  const token2 = await P.call('POST', '/api/settings/metrics-token', { cookie });
  assert.notEqual(token2.json.metricsToken, token.json.metricsToken);
});

test('删除设备', async () => {
  const res = await P.call('DELETE', `/api/devices/${deviceId}`, { cookie });
  assert.equal(res.status, 200);
  assert.equal((await P.call('GET', '/api/devices', { cookie })).json.devices.length, 0);
  assert.equal((await P.call('DELETE', `/api/devices/${deviceId}`, { cookie })).status, 404);
});

test('静态文件: 首页、脚本、图标; 路径不能越出前端目录; 安全响应头', async () => {
  const index = await P.call('GET', '/', { raw: true });
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  assert.match(index.text, /<div id="app"><\/div>/);
  assert.equal(index.headers.get('x-frame-options'), 'DENY');

  const js = await P.call('GET', '/js/app.js', { raw: true });
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);

  const icon = await P.call('GET', '/favicon.svg', { raw: true });
  assert.equal(icon.status, 200);
  assert.match(icon.headers.get('content-type'), /image\/svg/);

  assert.equal((await P.call('GET', '/../package.json', { raw: true })).status, 404);
  assert.equal((await P.call('GET', '/..%2Fpackage.json', { raw: true })).status, 404);
  assert.equal((await P.call('GET', '/..%5Cpackage.json', { raw: true })).status, 404);
  assert.equal((await P.call('GET', '/%E0%A4%A', { raw: true })).status, 404);
  assert.equal((await P.call('GET', '/nope.js', { raw: true })).status, 404);
  assert.equal((await P.call('POST', '/', { raw: true })).status, 405);

  assert.equal((await P.call('GET', '/api/nope', { cookie })).status, 404);
  assert.equal((await P.call('GET', '/api/devices/d_0123456789/nope', { cookie })).status, 404);
});

test('修改面板密码: 需要旧密码; 成功后旧 Cookie 失效', async () => {
  const wrong = await P.call('POST', '/api/password', { cookie, body: { oldPassword: 'nope-nope', newPassword: 'another-pass' } });
  assert.equal(wrong.status, 401);
  const weak = await P.call('POST', '/api/password', { cookie, body: { oldPassword: 'panel-password', newPassword: 'short' } });
  assert.equal(weak.status, 400);

  const res = await P.call('POST', '/api/password', { cookie, body: { oldPassword: 'panel-password', newPassword: 'another-pass' } });
  assert.equal(res.status, 200);
  assert.ok(res.cookie && res.cookie !== cookie, '会给当前浏览器换一个新的会话 Cookie');
  assert.equal((await P.call('GET', '/api/devices', { cookie })).status, 401, '旧 Cookie 失效');
  cookie = res.cookie;
  assert.equal((await P.call('GET', '/api/devices', { cookie })).status, 200);
  assert.equal((await P.call('POST', '/api/login', { body: ADMIN })).status, 401, '旧密码不能再登录');
});

test('退出登录', async () => {
  const res = await P.call('POST', '/api/logout', { cookie });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await P.call('GET', '/api/devices', { cookie })).status, 401);
  assert.equal((await P.call('POST', '/api/logout')).status, 200, '没登录也可以退出 (空操作)');
  assert.equal(P.auth.sessionCount, 0);
});

test('登录限速: 同一来源一分钟内超过 10 次后被拒 (单独起一个面板, 不影响上面的用例)', async () => {
  const Q = await startPanel();
  try {
    await Q.call('POST', '/api/setup', { body: ADMIN });
    let last;
    for (let i = 0; i < 12; i++) last = await Q.call('POST', '/api/login', { body: { username: 'admin', password: 'wrong-pass' } });
    assert.equal(last.status, 429);
    assert.equal(last.json.code, 'RATE_LIMITED');
  } finally {
    await Q.stop();
  }
});
