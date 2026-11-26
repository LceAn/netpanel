// 面板运行期间, 另一个进程 (switchctl 命令行) 修改数据目录里的文件。
// 各个存储在每次读写之前核对文件有没有变过: 面板马上就能看到修改, 也不会拿自己内存里的旧数据把对方的修改覆盖掉;
// 设备管理器据此开始轮询新设备、恢复被重新启用的设备, 并给被删除 / 停用的设备收尾。
// 用"同一个文件上的两个存储实例"模拟两个进程。

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { DeviceManager, HEALTH } from '../src/core/manager.mjs';
import { openDeviceStore } from '../src/core/store/devices.mjs';
import { openSettings } from '../src/core/store/settings.mjs';
import { openUserStore } from '../src/core/store/users.mjs';
import { openVault } from '../src/core/store/vault.mjs';
import { makeWorld } from '../testkit/fake-adapter.mjs';

const input = (name, url) => ({ name, url, adapter: 'tplink-rpm', username: 'admin', password: 'pw' });

test('设备表: 命令行添加 / 修改 / 删除设备, 面板这边立刻看到; 面板自己的写入不会覆盖对方的修改', () => {
  const dir = mkdtempSync(join(tmpdir(), 'netpanel-concurrent-'));
  const file = join(dir, 'devices.json');
  const key = join(dir, 'secret.key');
  try {
    const panel = openDeviceStore(file, openVault(key));
    const cli = openDeviceStore(file, openVault(key)); // 另一个进程

    const a = cli.add(input('命令行添加', 'http://192.0.2.1'));
    assert.deepEqual(panel.list().map((d) => d.name), ['命令行添加'], '面板不需要重启就能看到');

    const b = panel.add(input('界面添加', 'http://192.0.2.2'));
    assert.deepEqual(cli.list().map((d) => d.name).sort(), ['命令行添加', '界面添加'], '面板写入时不能把命令行添加的那台覆盖掉');

    cli.update(a.id, { notes: '命令行改的备注', tags: ['机房'] });
    assert.equal(panel.get(a.id).notes, '命令行改的备注');
    assert.deepEqual(panel.get(a.id).tags, ['机房']);

    panel.update(b.id, { notes: '界面改的备注' });
    const onDisk = readFileSync(file, 'utf8');
    assert.ok(onDisk.includes('命令行改的备注'), '面板写回设备表时要带上命令行做的那次修改');
    assert.ok(onDisk.includes('界面改的备注'));

    cli.remove(a.id);
    assert.deepEqual(panel.list().map((d) => d.name), ['界面添加']);
    assert.throws(() => panel.get(a.id), (err) => err.code === 'NOT_FOUND');

    // 密码: 两边用的是同一个密钥文件, 所以一边加密的密码另一边能解
    cli.update(b.id, { password: 'new-password' });
    assert.equal(panel.credentials(b.id).password, 'new-password');
    assert.equal(cli.credentials(b.id).password, 'new-password');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('面板账号和设置: 命令行做了初始化、改了密码、换了指标令牌, 运行中的面板马上认', () => {
  const dir = mkdtempSync(join(tmpdir(), 'netpanel-concurrent-'));
  try {
    const usersPanel = openUserStore(join(dir, 'auth.json'));
    const usersCli = openUserStore(join(dir, 'auth.json'));
    assert.equal(usersPanel.exists, false, '面板启动时还没有初始化');
    usersCli.create('admin', 'password-1');
    assert.equal(usersPanel.exists, true, '命令行初始化之后, 面板不该再要求初始化');
    assert.equal(usersPanel.username, 'admin');
    assert.equal(usersPanel.verify('admin', 'password-1'), true);
    usersCli.changePassword('admin', 'password-1', 'password-2');
    assert.equal(usersPanel.verify('admin', 'password-1'), false, '旧密码失效');
    assert.equal(usersPanel.verify('admin', 'password-2'), true);

    const settingsPanel = openSettings(join(dir, 'settings.json'));
    const settingsCli = openSettings(join(dir, 'settings.json'));
    settingsCli.set({ pollIntervalSec: 20 });
    assert.equal(settingsPanel.get().pollIntervalSec, 20);
    const token = settingsCli.rotateMetricsToken();
    assert.equal(settingsPanel.verifyMetricsToken(token), true, '用命令行生成的令牌能立刻抓指标');
    settingsPanel.set({ statsIntervalSec: 40 });
    assert.deepEqual(settingsCli.get(), { pollIntervalSec: 20, statsIntervalSec: 40, metricsToken: token }, '面板保存设置时保留命令行生成的令牌');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('设备管理器: 面板运行期间命令行添加 / 停用 / 启用 / 改密码 / 删除设备, 都自动跟上, 且没有未处理的异常', async () => {
  const world = makeWorld();
  const dir = mkdtempSync(join(tmpdir(), 'netpanel-concurrent-'));
  const key = join(dir, 'secret.key');
  const file = join(dir, 'devices.json');
  const mgr = new DeviceManager({
    store: openDeviceStore(file, openVault(key), { adapterExists: (id) => world.registry.has(id) }),
    adapters: world.registry,
    settings: { get: () => ({ pollIntervalSec: 0.2, statsIntervalSec: 0.2 }) },
    log: () => {},
  });
  const cli = openDeviceStore(file, openVault(key), { adapterExists: (id) => world.registry.has(id) }); // 另一个进程
  const rejections = [];
  const onRejection = (err) => rejections.push(err);
  process.on('unhandledRejection', onRejection);

  /** 等到条件成立 (最多 6 秒)。 */
  const until = async (read, ok, what) => {
    for (let i = 0; i < 120; i++) {
      const value = read();
      if (ok(value)) return value;
      await delay(50);
    }
    assert.fail(`等不到: ${what}; 实际 ${JSON.stringify(read())}`);
  };
  const state = (id) => {
    try {
      return mgr.describe(id).health;
    } catch (err) {
      return err.code;
    }
  };

  try {
    const d1 = world.makeDevice('http://192.0.2.10');
    world.devices.set(d1.url, d1);
    const first = await mgr.add({ name: '界面添加', url: d1.url, adapter: 'fake', username: 'admin', password: 'pw' });
    await mgr.start();
    await until(() => state(first.id), (h) => h === HEALTH.ONLINE, '界面添加的设备上线');

    // 命令行添加
    const d2 = world.makeDevice('http://192.0.2.11', { model: 'FAKE-28' });
    world.devices.set(d2.url, d2);
    const added = cli.add({ name: '命令行添加', url: d2.url, adapter: 'fake', username: 'admin', password: 'pw' });
    const seen = mgr.list().find((d) => d.id === added.id);
    assert.ok(seen, 'list() 里能看到命令行添加的设备');
    assert.equal(seen.health, HEALTH.UNKNOWN, '还没轮询过');
    await until(() => state(added.id), (h) => h === HEALTH.ONLINE, '命令行添加的设备自动开始轮询并上线');

    // 停用: 立刻显示为已停用; 下一次轮询时释放会话
    cli.update(added.id, { enabled: false });
    assert.equal(state(added.id), HEALTH.DISABLED);
    const logoutsBefore = d2.logouts;
    await until(() => d2.logouts, (n) => n > logoutsBefore, '停用后释放设备上的会话');
    const readsWhenStopped = d2.reads.length;
    await delay(600);
    assert.equal(d2.reads.length, readsWhenStopped, '停用之后不再读取设备');

    // 启用: 恢复轮询
    cli.update(added.id, { enabled: true });
    await until(() => mgr.list() && state(added.id), (h) => h === HEALTH.ONLINE, '重新启用后恢复轮询');

    // 改密码 (交换机上的密码同时改了): 面板用新密码重新登录
    d2.password = 'rotated';
    const connectionsBefore = world.connections.length;
    cli.update(added.id, { password: 'rotated' });
    await until(() => world.connections.length, (n) => n > connectionsBefore, '设备记录被改过之后换一条新连接');
    await until(() => state(added.id), (h) => h === HEALTH.ONLINE, '用新密码重新上线');
    assert.ok(d2.reads.length > 0);

    // 删除: 面板不再列出它; 之后即使再经过多个轮询周期也不会抛错
    cli.remove(added.id);
    assert.equal(mgr.list().some((d) => d.id === added.id), false);
    assert.equal(state(added.id), 'NOT_FOUND');
    await delay(1200);
    assert.deepEqual(rejections, [], '设备被别的进程删除后, 后台轮询不能产生未处理的异常');

    // 面板之后再改设备表, 不会让被删除的设备"复活"
    await mgr.update(first.id, { notes: '界面改的' });
    assert.deepEqual(mgr.list().map((d) => d.name), ['界面添加']);
    assert.equal(state(first.id), HEALTH.ONLINE);
  } finally {
    process.off('unhandledRejection', onRejection);
    await mgr.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
