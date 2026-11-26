// 设备管理器: 用一个内存里的假适配器 (不碰网络) 验证后台轮询、健康状态、缓存与实时读取、设备增删改。

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { DeviceManager, HEALTH } from '../src/core/manager.mjs';
import { AppError } from '../src/core/errors.mjs';
import { makeWorld } from '../testkit/fake-adapter.mjs';
import { openDeviceStore } from '../src/core/store/devices.mjs';
import { openVault } from '../src/core/store/vault.mjs';

const failsWith = (code, re) => (err) => {
  assert.ok(err instanceof AppError, `应抛 AppError, 实际是 ${err}`);
  assert.equal(err.code, code);
  if (re) assert.match(err.message, re);
  return true;
};

function makeManager(world, { settings } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'netpanel-mgr-'));
  const store = openDeviceStore(join(dir, 'devices.json'), openVault(join(dir, 'secret.key')), { adapterExists: (id) => world.registry.has(id) });
  const mgr = new DeviceManager({
    store,
    adapters: world.registry,
    settings: settings ?? { get: () => ({ pollIntervalSec: 0.2, statsIntervalSec: 0.2 }) },
  });
  return { mgr, store, dir };
}

const cleanup = (ctx) => {
  rmSync(ctx.dir, { recursive: true, force: true });
};

test('添加设备: 先识别 (型号 / 固件 / 端口数), 识别成功才保存; 描述里有能力和适配器信息', async () => {
  const world = makeWorld();
  const ctx = makeManager(world);
  try {
    const d = world.makeDevice('http://192.0.2.10', { model: 'FAKE-24', ports: Array.from({ length: 24 }, (_, i) => ({ id: i + 1 })) });
    world.devices.set(d.url, d);
    const rec = await ctx.mgr.add({ name: '机房', url: 'http://192.0.2.10', adapter: 'auto', username: 'admin', password: 'pw', tags: ['lab'] });
    assert.equal(rec.model, 'FAKE-24');
    assert.equal(rec.portCount, 24);
    assert.equal(rec.identified.firmware, 'fw-1.0');
    assert.equal(rec.health, HEALTH.UNKNOWN); // 还没轮询
    assert.equal(rec.adapter, 'fake');
    assert.equal(rec.adapterMaturity, 'verified');
    assert.deepEqual(rec.capabilities.reads, ['overview', 'stats', 'system', 'loop']);
    assert.deepEqual(rec.tags, ['lab']);
    assert.equal(rec.hasSecret, true);
    assert.equal(rec.secret, undefined);
    assert.equal(ctx.store.list().length, 1);
    assert.equal(d.logouts, 1, '识别完应当立刻释放设备上的会话');
  } finally {
    cleanup(ctx);
  }
});

test('密码错误时添加失败, 且不会留下半条设备记录', async () => {
  const world = makeWorld();
  const ctx = makeManager(world);
  try {
    const d = world.makeDevice('http://192.0.2.11');
    world.devices.set(d.url, d);
    await assert.rejects(ctx.mgr.add({ name: 'x', url: d.url, adapter: 'fake', username: 'admin', password: 'wrong' }), failsWith('BAD_CREDENTIALS', /192\.0\.2\.11/));
    assert.deepEqual(ctx.store.list(), []);
    // 地址上没有可识别的设备
    await assert.rejects(ctx.mgr.add({ name: 'x', url: 'http://192.0.2.99', username: 'admin', password: 'pw' }), failsWith('UNSUPPORTED', /认不出/));
    await assert.rejects(ctx.mgr.add({ name: 'x', url: 'http://192.0.2.99', adapter: 'nope', username: 'admin', password: 'pw' }), failsWith('NOT_FOUND'));
  } finally {
    cleanup(ctx);
  }
});

test('刷新: 读概览和统计, 更新健康状态与历史; 之后 overview / stats 走缓存, live 才打设备', async () => {
  const world = makeWorld();
  const ctx = makeManager(world);
  try {
    const d = world.makeDevice('http://192.0.2.10');
    world.devices.set(d.url, d);
    const rec = await ctx.mgr.add({ name: 'A', url: d.url, adapter: 'fake', username: 'admin', password: 'pw' });
    d.reads.length = 0;

    const after = await ctx.mgr.refresh(rec.id);
    assert.equal(after.health, HEALTH.ONLINE);
    assert.equal(after.portsUp, 3);
    assert.equal(after.rxKbps, 100 * 36); // 100+200+...+800
    assert.equal(after.txKbps, 10 * 36);
    assert.deepEqual(after.portStates.slice(0, 4), [
      { id: 1, enabled: true, speedAct: 6 }, { id: 2, enabled: true, speedAct: 6 }, { id: 3, enabled: true, speedAct: 6 }, { id: 4, enabled: true, speedAct: 0 },
    ]);
    assert.deepEqual(d.reads, ['overview', 'stats']);
    assert.equal(ctx.mgr.history(rec.id).length, 1);

    d.reads.length = 0;
    const cached = await ctx.mgr.read(rec.id, 'overview');
    assert.equal(cached.cached, true);
    assert.deepEqual(d.reads, [], '缓存新鲜时不应再打设备');
    const live = await ctx.mgr.read(rec.id, 'overview', { live: true });
    assert.equal(live.cached, false);
    assert.deepEqual(d.reads, ['overview']);
    const sys = await ctx.mgr.read(rec.id, 'system');
    assert.equal(sys.data.model, 'FAKE-8');
    await assert.rejects(ctx.mgr.read(rec.id, 'vlan8021q'), failsWith('UNSUPPORTED', /不支持读取/));
  } finally {
    cleanup(ctx);
  }
});

test('健康状态: 偶发一次连不上不算离线, 连续失败才标离线; 恢复后回到在线', async () => {
  const world = makeWorld();
  const ctx = makeManager(world);
  try {
    const d = world.makeDevice('http://192.0.2.10');
    world.devices.set(d.url, d);
    const rec = await ctx.mgr.add({ name: 'A', url: d.url, adapter: 'fake', username: 'admin', password: 'pw' });
    await ctx.mgr.refresh(rec.id);
    d.online = false;
    await ctx.mgr.refresh(rec.id);
    assert.equal(ctx.mgr.describe(rec.id).health, HEALTH.ONLINE, '第一次失败仍视为在线');
    await ctx.mgr.refresh(rec.id);
    assert.equal(ctx.mgr.describe(rec.id).health, HEALTH.OFFLINE);
    assert.match(ctx.mgr.describe(rec.id).lastError, /无法连接/);
    d.online = true;
    await ctx.mgr.refresh(rec.id);
    assert.equal(ctx.mgr.describe(rec.id).health, HEALTH.ONLINE);
    assert.equal(ctx.mgr.describe(rec.id).lastError, null);
  } finally {
    cleanup(ctx);
  }
});

test('凭据失效: 标成 auth 并给出明确报错; 改对密码后恢复', async () => {
  const world = makeWorld();
  const ctx = makeManager(world);
  try {
    const d = world.makeDevice('http://192.0.2.10');
    world.devices.set(d.url, d);
    const rec = await ctx.mgr.add({ name: 'A', url: d.url, adapter: 'fake', username: 'admin', password: 'pw' });
    await ctx.mgr.refresh(rec.id);
    d.password = 'changed-on-device';
    await ctx.mgr.refresh(rec.id);
    assert.equal(ctx.mgr.describe(rec.id).health, HEALTH.AUTH);
    await assert.rejects(ctx.mgr.read(rec.id, 'system', { live: true }), failsWith('BAD_CREDENTIALS'));

    await ctx.mgr.update(rec.id, { password: 'changed-on-device' });
    assert.equal(ctx.mgr.describe(rec.id).health, HEALTH.UNKNOWN, '改了凭据后要重新轮询才能确认');
    await ctx.mgr.refresh(rec.id);
    assert.equal(ctx.mgr.describe(rec.id).health, HEALTH.ONLINE);
    assert.equal(ctx.store.credentials(rec.id).password, 'changed-on-device');
  } finally {
    cleanup(ctx);
  }
});

test('写操作: 先过能力检查和参数校验, 不合法的不会发到设备', async () => {
  const world = makeWorld();
  const ctx = makeManager(world);
  try {
    const d = world.makeDevice('http://192.0.2.10');
    world.devices.set(d.url, d);
    const rec = await ctx.mgr.add({ name: 'A', url: d.url, adapter: 'fake', username: 'admin', password: 'pw' });
    await assert.rejects(ctx.mgr.submit(rec.id, 'system.reboot', { save: true, confirm: true }), failsWith('UNSUPPORTED', /不支持操作/));
    await assert.rejects(ctx.mgr.submit(rec.id, 'loop.set', { enabled: 'yes' }), failsWith('BAD_PARAM'));
    await assert.rejects(ctx.mgr.submit(rec.id, 'nope', {}), failsWith('NOT_FOUND'));
    assert.deepEqual(d.submits, []);
    const res = await ctx.mgr.submit(rec.id, 'loop.set', { enabled: true });
    assert.equal(res.ok, true);
    assert.equal(res.tip, 'ok');
    assert.equal(res.fresh.loop.enabled, false); // 提交后回读受影响的页面 (规范里 loop.set 还会回读概览)
    assert.ok(res.fresh.overview?.ports);
    assert.deepEqual(d.submits, [['loop.set', { enabled: true }]]);
  } finally {
    cleanup(ctx);
  }
});

test('停用: 不再访问设备并释放会话; 启用后恢复', async () => {
  const world = makeWorld();
  const ctx = makeManager(world);
  try {
    const d = world.makeDevice('http://192.0.2.10');
    world.devices.set(d.url, d);
    const rec = await ctx.mgr.add({ name: 'A', url: d.url, adapter: 'fake', username: 'admin', password: 'pw' });
    await ctx.mgr.refresh(rec.id);
    const logoutsBefore = d.logouts;
    const off = await ctx.mgr.update(rec.id, { enabled: false });
    assert.equal(off.health, HEALTH.DISABLED);
    assert.equal(d.logouts, logoutsBefore + 1);
    await assert.rejects(ctx.mgr.read(rec.id, 'overview', { live: true }), failsWith('DISABLED'));
    await ctx.mgr.update(rec.id, { enabled: true });
    assert.equal((await ctx.mgr.refresh(rec.id)).health, HEALTH.ONLINE);
  } finally {
    cleanup(ctx);
  }
});

test('删除设备: 释放设备上的会话并清掉记录', async () => {
  const world = makeWorld();
  const ctx = makeManager(world);
  try {
    const d = world.makeDevice('http://192.0.2.10');
    world.devices.set(d.url, d);
    const rec = await ctx.mgr.add({ name: 'A', url: d.url, adapter: 'fake', username: 'admin', password: 'pw' });
    await ctx.mgr.refresh(rec.id);
    const logoutsBefore = d.logouts;
    await ctx.mgr.remove(rec.id);
    assert.equal(d.logouts, logoutsBefore + 1);
    assert.deepEqual(ctx.store.list(), []);
    assert.throws(() => ctx.mgr.describe(rec.id), failsWith('NOT_FOUND'));
    await assert.rejects(ctx.mgr.remove(rec.id), failsWith('NOT_FOUND'));
  } finally {
    cleanup(ctx);
  }
});

test('多台设备: 总览汇总各设备状态; 一台离线不影响另一台', async () => {
  const world = makeWorld();
  const ctx = makeManager(world);
  try {
    const a = world.makeDevice('http://192.0.2.10', { model: 'FAKE-8' });
    const b = world.makeDevice('http://192.0.2.11', { model: 'FAKE-24', ports: Array.from({ length: 24 }, (_, i) => ({ id: i + 1, enabled: true, speedAct: i < 5 ? 6 : 0, rxKbps: 1, txKbps: 2 })) });
    world.devices.set(a.url, a);
    world.devices.set(b.url, b);
    const ra = await ctx.mgr.add({ name: 'A', url: a.url, adapter: 'fake', username: 'admin', password: 'pw' });
    const rb = await ctx.mgr.add({ name: 'B', url: b.url, adapter: 'auto', username: 'admin', password: 'pw' });
    await ctx.mgr.refresh(ra.id);
    await ctx.mgr.refresh(rb.id);
    b.online = false;
    await ctx.mgr.refresh(rb.id);
    await ctx.mgr.refresh(rb.id);
    const dash = ctx.mgr.dashboard();
    assert.equal(dash.totals.total, 2);
    assert.equal(dash.totals.online, 1);
    assert.equal(dash.totals.offline, 1);
    assert.equal(dash.totals.ports, 32);
    assert.equal(dash.totals.portsUp, 3);
    assert.equal(dash.devices.find((x) => x.name === 'A').health, HEALTH.ONLINE);
    assert.equal(dash.devices.find((x) => x.name === 'B').health, HEALTH.OFFLINE);
    assert.equal(dash.devices[0].history.length, 1);
    // 自动探测: 地址上没有可识别的设备 → 认不出
    await assert.rejects(ctx.mgr.add({ name: 'C', url: 'http://192.0.2.12', username: 'admin', password: 'pw' }), failsWith('UNSUPPORTED', /认不出/));
    // 手动指定了适配器: 不探测, 直接去连 → 连不上就是离线
    await assert.rejects(ctx.mgr.add({ name: 'C', url: 'http://192.0.2.12', adapter: 'fake', username: 'admin', password: 'pw' }), failsWith('OFFLINE', /192\.0\.2\.12/));
    // 离线的那台并没有影响另一台设备的访问
    assert.equal((await ctx.mgr.read(ra.id, 'system')).data.model, 'FAKE-8');
  } finally {
    cleanup(ctx);
  }
});

test('test / probe: 不保存就能验证一台设备', async () => {
  const world = makeWorld();
  const ctx = makeManager(world);
  try {
    const d = world.makeDevice('http://192.0.2.10');
    world.devices.set(d.url, d);
    const probed = await ctx.mgr.probe({ url: d.url });
    assert.equal(probed.adapter.id, 'fake');
    assert.equal((await ctx.mgr.probe({ url: 'http://192.0.2.99' })).adapter, null);
    const ok = await ctx.mgr.test({ url: d.url, adapter: 'auto', username: 'admin', password: 'pw' });
    assert.equal(ok.identified.model, 'FAKE-8');
    await assert.rejects(ctx.mgr.test({ url: d.url, username: 'admin', password: 'bad' }), failsWith('BAD_CREDENTIALS'));
    await assert.rejects(ctx.mgr.test({ url: d.url, username: '', password: '' }), failsWith('BAD_PARAM', /账号和密码/));
    assert.deepEqual(ctx.store.list(), []);
  } finally {
    cleanup(ctx);
  }
});

test('后台轮询: start() 之后自己按间隔刷新, stop() 后停止并释放会话', async () => {
  const world = makeWorld();
  const ctx = makeManager(world);
  try {
    const d = world.makeDevice('http://192.0.2.10');
    world.devices.set(d.url, d);
    const rec = await ctx.mgr.add({ name: 'A', url: d.url, adapter: 'fake', username: 'admin', password: 'pw' });
    await ctx.mgr.start();
    await delay(3600); // 启动 300ms 后第一次, 之后约每秒一次
    const overviewReads = d.reads.filter((k) => k === 'overview').length;
    assert.ok(overviewReads >= 3, `应已轮询多次, 实际 ${overviewReads}`);
    assert.equal(ctx.mgr.describe(rec.id).health, HEALTH.ONLINE);
    assert.ok(ctx.mgr.history(rec.id).length >= 2);
    await ctx.mgr.stop();
    const after = d.reads.length;
    await delay(1300);
    assert.equal(d.reads.length, after, 'stop() 之后不应再有读取');
    assert.ok(d.logouts >= 1);
  } finally {
    cleanup(ctx);
  }
});
