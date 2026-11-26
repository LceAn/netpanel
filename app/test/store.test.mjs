// 存储层: 保险箱 (加解密)、设备表、面板账号、设置。全部在临时目录里进行, 不碰真实数据。

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openVault } from '../src/core/store/vault.mjs';
import { normalizeUrl, openDeviceStore } from '../src/core/store/devices.mjs';
import { openUserStore, assertPasswordPolicy } from '../src/core/store/users.mjs';
import { openSettings, DEFAULT_SETTINGS } from '../src/core/store/settings.mjs';
import { readJson, writeJson } from '../src/core/store/json-file.mjs';
import { AppError } from '../src/core/errors.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'netpanel-test-'));
const failsWith = (re, code) => (err) => {
  assert.ok(err instanceof AppError, `应抛 AppError, 实际是 ${err}`);
  if (code) assert.equal(err.code, code);
  assert.match(err.message, re);
  return true;
};

// ── 保险箱 ────────────────────────────────────────────────────────────

test('保险箱: 加密后能解回原文; 密文里不出现明文', () => {
  const dir = tmp();
  try {
    const vault = openVault(join(dir, 'secret.key'));
    const secret = vault.encrypt('S3cret!密码', 'd_abc');
    assert.match(secret, /^v1:[\w-]+:[\w-]+:[\w-]+$/);
    assert.ok(!secret.includes('S3cret'));
    assert.equal(vault.decrypt(secret, 'd_abc'), 'S3cret!密码');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('保险箱: 密文被改动、被挪给别的设备、或换了密钥文件, 都解不出来 (且不会返回错误的明文)', () => {
  const dir = tmp();
  try {
    const vault = openVault(join(dir, 'secret.key'));
    const secret = vault.encrypt('hunter2', 'd_one');
    const parts = secret.split(':');
    const ct = Buffer.from(parts[3], 'base64url');
    ct[0] ^= 1;
    const tampered = [...parts.slice(0, 3), ct.toString('base64url')].join(':');
    assert.throws(() => vault.decrypt(tampered, 'd_one'), failsWith(/无法解密/, 'VAULT'));
    assert.throws(() => vault.decrypt(secret, 'd_two'), failsWith(/无法解密/, 'VAULT'));
    assert.throws(() => vault.decrypt('v1:bad:bad:bad', 'd_one'), failsWith(/无法解密/, 'VAULT'));
    assert.throws(() => vault.decrypt('garbage', 'd_one'), failsWith(/格式无法识别/, 'VAULT'));
    // 同一目录、密钥文件被删后重建 → 新密钥解不开旧密文
    rmSync(join(dir, 'secret.key'));
    assert.throws(() => openVault(join(dir, 'secret.key')).decrypt(secret, 'd_one'), failsWith(/无法解密/, 'VAULT'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('保险箱: 密钥只生成一次, 之后每次打开都用同一个', () => {
  const dir = tmp();
  try {
    const keyFile = join(dir, 'secret.key');
    const first = openVault(keyFile);
    const secret = first.encrypt('pw', 'x');
    const second = openVault(keyFile);
    assert.equal(second.decrypt(secret, 'x'), 'pw');
    assert.equal(readFileSync(keyFile).length, 32);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 设备地址 ──────────────────────────────────────────────────────────

test('设备地址: 规范化为 http(s)://主机[:端口], 拒绝路径 / 查询串 / 内嵌账号', () => {
  assert.equal(normalizeUrl('http://192.168.50.20'), 'http://192.168.50.20');
  assert.equal(normalizeUrl('http://192.168.50.20/'), 'http://192.168.50.20');
  assert.equal(normalizeUrl('https://switch.lan:8443/'), 'https://switch.lan:8443');
  assert.throws(() => normalizeUrl('ftp://x'), failsWith(/只支持/, 'BAD_PARAM'));
  assert.throws(() => normalizeUrl('http://user:pw@192.168.50.1'), failsWith(/不能带账号密码/, 'BAD_PARAM'));
  assert.throws(() => normalizeUrl('http://192.168.50.1/admin'), failsWith(/不要带路径/, 'BAD_PARAM'));
  assert.throws(() => normalizeUrl('http://192.168.50.1/?x=1'), failsWith(/不要带路径/, 'BAD_PARAM'));
  assert.throws(() => normalizeUrl('not a url'), failsWith(/格式不正确/, 'BAD_PARAM'));
  assert.throws(() => normalizeUrl(''), failsWith(/格式不正确/, 'BAD_PARAM'));
});

// ── 设备表 ────────────────────────────────────────────────────────────

const openDevices = (dir) => openDeviceStore(join(dir, 'devices.json'), openVault(join(dir, 'secret.key')), { adapterExists: (id) => id === 'tplink-rpm' });
const sample = { name: '客厅', url: 'http://192.0.2.10', adapter: 'tplink-rpm', username: 'admin', password: 'pw-one' };

test('设备表: 添加 / 读取 / 改密码 / 删除; 对外记录里没有密文和明文', () => {
  const dir = tmp();
  try {
    const store = openDevices(dir);
    assert.deepEqual(store.list(), []);
    const rec = store.add(sample);
    assert.match(rec.id, /^d_[0-9a-f]{10}$/);
    assert.equal(rec.hasSecret, true);
    assert.equal(rec.secret, undefined);
    assert.ok(!JSON.stringify(rec).includes('pw-one'));

    assert.deepEqual(store.credentials(rec.id), { username: 'admin', password: 'pw-one' });

    store.update(rec.id, { password: 'pw-two', name: '客厅交换机' });
    assert.deepEqual(store.credentials(rec.id), { username: 'admin', password: 'pw-two' });
    assert.equal(store.get(rec.id).name, '客厅交换机');

    // 留空密码 = 不改
    store.update(rec.id, { password: '', notes: '备注' });
    assert.equal(store.credentials(rec.id).password, 'pw-two');
    assert.equal(store.get(rec.id).notes, '备注');

    store.remove(rec.id);
    assert.deepEqual(store.list(), []);
    assert.throws(() => store.get(rec.id), failsWith(/设备不存在/, 'NOT_FOUND'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('设备表: 磁盘上只有密文; 重新打开 (新的进程) 仍能解出密码', () => {
  const dir = tmp();
  try {
    const store = openDevices(dir);
    const rec = store.add(sample);
    const onDisk = readFileSync(join(dir, 'devices.json'), 'utf8');
    assert.ok(!onDisk.includes('pw-one'), '磁盘上的设备表不能出现明文密码');
    assert.match(onDisk, /"secret": "v1:/);
    // 模拟另一个进程: 重新打开同一个目录
    assert.deepEqual(openDevices(dir).credentials(rec.id), { username: 'admin', password: 'pw-one' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('设备表: 非法输入一律拒绝 (地址、适配器、账号密码、重名、标签、间隔)', () => {
  const dir = tmp();
  try {
    const store = openDevices(dir);
    const bad = (patch, re, code = 'BAD_PARAM') => assert.throws(() => store.add({ ...sample, ...patch }), failsWith(re, code));
    bad({ url: 'javascript:alert(1)' }, /只支持/);
    bad({ adapter: 'nope' }, /不支持的适配器/);
    bad({ adapter: '__proto__' }, /不支持的适配器/);
    bad({ username: '' }, /账号/);
    bad({ password: '' }, /密码/);
    bad({ password: 'a b' }, /密码/); // 含空格
    bad({ name: '' }, /名字/);
    bad({ pollIntervalSec: 1 }, /轮询间隔/);
    bad({ tags: ['x'.repeat(40)] }, /标签最长/);
    bad({ tags: Array.from({ length: 9 }, (_, i) => `t${i}`) }, /最多 8 个标签/);
    const rec = store.add(sample);
    assert.throws(() => store.add({ ...sample, name: '客厅 ' }), failsWith(/已经有一台设备叫/, 'CONFLICT')); // 大小写/首尾空格不敏感
    assert.throws(() => store.update(rec.id, { pollIntervalSec: 99999 }), failsWith(/轮询间隔/, 'BAD_PARAM'));
    assert.equal(store.get(rec.id).id, rec.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('设备表: 文件损坏时明确报错, 而不是悄悄当成空表', () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'devices.json'), '{ broken');
    assert.throws(() => openDevices(dir), failsWith(/已损坏/, 'DATA_CORRUPT'));
    writeFileSync(join(dir, 'devices.json'), '{"version":1,"devices":"nope"}');
    assert.throws(() => openDevices(dir), failsWith(/已损坏/, 'DATA_CORRUPT'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 面板账号 ──────────────────────────────────────────────────────────

test('面板账号: 完整流程', () => {
  const dir = tmp();
  try {
    const file = join(dir, 'auth.json');
    const users = openUserStore(file);
    assert.equal(users.exists, false);
    assert.equal(users.verify('admin', 'whatever'), false);
    assert.equal(users.username, null);

    assert.throws(() => users.create('ad min', 'goodpassword'), failsWith(/面板账号/, 'BAD_PARAM'));
    assert.throws(() => users.create('admin', 'short'), failsWith(/至少 8/, 'BAD_PARAM'));
    users.create('admin', 'goodpassword');
    assert.equal(users.exists, true);
    assert.equal(users.username, 'admin');
    assert.ok(!readFileSync(file, 'utf8').includes('goodpassword'), '磁盘上不能有明文密码');

    assert.equal(users.verify('admin', 'goodpassword'), true);
    assert.equal(users.verify('admin', 'goodpassworD'), false);
    assert.equal(users.verify('admin', ''), false);
    assert.equal(users.verify('nobody', 'goodpassword'), false);
    assert.equal(users.verify(undefined, undefined), false);
    assert.throws(() => users.create('other', 'goodpassword'), failsWith(/已经初始化/, 'CONFLICT'));

    assert.throws(() => users.changePassword('admin', 'wrong', 'newpassword1'), failsWith(/不正确/, 'BAD_CREDENTIALS'));
    assert.throws(() => users.changePassword('admin', 'goodpassword', 'short'), failsWith(/至少 8/, 'BAD_PARAM'));
    users.changePassword('admin', 'goodpassword', 'newpassword1');
    assert.equal(users.verify('admin', 'goodpassword'), false);
    assert.equal(users.verify('admin', 'newpassword1'), true);

    // 新进程重新打开
    assert.equal(openUserStore(file).verify('admin', 'newpassword1'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('密码策略', () => {
  assert.throws(() => assertPasswordPolicy('1234567'), failsWith(/至少 8/));
  assert.throws(() => assertPasswordPolicy('x'.repeat(129)), failsWith(/最长 128/));
  assert.throws(() => assertPasswordPolicy(12345678), failsWith(/至少 8/));
  assert.doesNotThrow(() => assertPasswordPolicy('12345678'));
});

// ── 设置 ──────────────────────────────────────────────────────────────

test('设置: 默认值、范围校验、指标令牌的生成与重置', () => {
  const dir = tmp();
  try {
    const file = join(dir, 'settings.json');
    let s = openSettings(file);
    assert.deepEqual(s.get(), { ...DEFAULT_SETTINGS });
    s = openSettings(file);
    s.set({ pollIntervalSec: 30, bogus: 1 });
    s = openSettings(file);
    assert.equal(s.get().pollIntervalSec, 30);
    assert.equal('bogus' in s.get(), false);
    assert.throws(() => s.set({ pollIntervalSec: 0 }), failsWith(/默认轮询间隔/, 'BAD_PARAM'));
    assert.throws(() => s.set({ statsIntervalSec: 5 }), failsWith(/统计轮询间隔/, 'BAD_PARAM'));
    const token = s.ensureMetricsToken();
    assert.match(token, /^[\w-]{32,}$/);
    s.set({ metricsToken: 'hands-off' }); // 令牌只能通过专用方法改, set() 会忽略它
    assert.equal(s.ensureMetricsToken(), token);
    assert.notEqual(s.rotateMetricsToken(), token);
    assert.equal(openSettings(file).get().metricsToken === token, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── JSON 文件 ─────────────────────────────────────────────────────────

test('JSON 文件: 不存在时用默认值; 写后可读; 正式文件写坏时用临时文件恢复; 两者都坏才报错', () => {
  const dir = tmp();
  try {
    const file = join(dir, 'a', 'b.json');
    assert.deepEqual(readJson(file, { ok: 1 }), { ok: 1 });
    writeJson(file, { hello: '世界' });
    assert.deepEqual(readJson(file), { hello: '世界' });
    assert.deepEqual(readFileSync(file, 'utf8'), '{\n  "hello": "世界"\n}\n');
    assert.deepEqual(readJson(file + '.tmp'), { hello: '世界' }); // 临时文件是同一份完整内容

    // 模拟"覆盖正式文件写到一半崩溃": 正式文件被截断
    writeFileSync(file, '{ "hello": ');
    assert.deepEqual(readJson(file), { hello: '世界' });

    // 两个文件都坏 → 明确报错, 而不是悄悄当成空数据
    writeFileSync(file + '.tmp', 'nope');
    assert.throws(() => readJson(file), failsWith(/已损坏/, 'DATA_CORRUPT'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('JSON 文件: 写入耗时在毫秒级 (不依赖重命名)', () => {
  const dir = tmp();
  try {
    const file = join(dir, 'fast.json');
    writeJson(file, { n: 0 }); // 首次创建文件不计入
    const started = process.hrtime.bigint();
    for (let i = 1; i <= 20; i++) writeJson(file, { n: i });
    const perWrite = Number(process.hrtime.bigint() - started) / 1e6 / 20;
    assert.ok(perWrite < 200, `每次写入平均 ${perWrite.toFixed(0)}ms, 太慢了`);
    assert.deepEqual(readJson(file), { n: 20 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
