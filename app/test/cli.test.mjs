// 命令行: 用进程内的模拟交换机把主要命令跑一遍 (临时数据目录, 不碰真实设备, 不起子进程)。

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, before, test } from 'node:test';
import { APP_ROOT } from '../src/core/config.mjs';
import { coerceArrays, parseArgs, parsePorts, parseValue, runCli, table } from '../src/cli/index.mjs';
import { validateOp } from '../src/core/ops.mjs';
import { createMockSwitch } from '../scripts/mock-switch.mjs';

let mock;
let dir;
const USER = ['--user', 'admin'];
const URL = () => ['--url', mock.url, ...USER, '--password', 'admin'];

before(async () => {
  mock = await createMockSwitch({ profile: 'lab' }).listen(0);
  dir = mkdtempSync(join(tmpdir(), 'netpanel-cli-'));
});
after(async () => {
  await mock.close();
  rmSync(dir, { recursive: true, force: true });
});

const sink = () => {
  const stream = new PassThrough();
  const chunks = [];
  stream.on('data', (c) => chunks.push(c));
  return { stream, text: () => Buffer.concat(chunks).toString('utf8') };
};

/** 跑一次命令行。stdin 不是终端 (isTTY 为 undefined) → 按"无人值守"处理: 危险操作必须带 --yes。 */
async function cli(args, { password, stdinText } = {}) {
  const out = sink();
  const err = sink();
  const stdin = new PassThrough();
  if (stdinText !== undefined) stdin.end(stdinText); // 不结束的话 "从标准输入读密码" 会一直等
  const code = await runCli(args, { env: { NETPANEL_PASSWORD: password ?? '' }, stdin, stdout: out.stream, stderr: err.stream, appRoot: APP_ROOT });
  return { code, out: out.text(), err: err.text() };
}
const json = (args, opts) => cli(['--json', ...args], opts).then((r) => ({ ...r, json: JSON.parse(r.out) }));
const PANEL = (...args) => cli(['--data-dir', dir, ...args]);
/** 最近一次发给模拟交换机的写请求。 */
const lastWrite = (path) => [...mock.writes].reverse().find((w) => w.path === path);

// ── 参数解析 ──────────────────────────────────────────────────────────

test('parseArgs: 选项、= 写法、单字母开关、位置参数、--', () => {
  const o = parseArgs(['--json', '--device', '客厅', 'status', '--tags', 'a,b', '--speed=100f', '-y', 'extra', '--', '--not-an-option']);
  assert.equal(o.json, true);
  assert.equal(o.yes, true);
  assert.equal(o.device, '客厅');
  assert.equal(o.tags, 'a,b');
  assert.equal(o.speed, '100f');
  assert.deepEqual(o._, ['status', 'extra', '--not-an-option']);
  assert.throws(() => parseArgs(['--url']), /--url 需要一个值/);
  assert.throws(() => parseArgs(['--json=1']), /--json 不接受值/);
});

test('parsePorts: 逗号、区间、混合; 不合法的报错', () => {
  assert.deepEqual(parsePorts('1'), [1]);
  assert.deepEqual(parsePorts('1,3-5,2'), [1, 3, 4, 5, 2]);
  assert.throws(() => parsePorts('0'), /端口列表不合法/);
  assert.throws(() => parsePorts('5-3'), /端口列表不合法/);
  assert.throws(() => parsePorts('a'), /端口列表不合法/);
  assert.throws(() => parsePorts('1,,2'), /端口列表不合法/);
});

test('parseValue: 数字 / 布尔 / 字符串 / 逗号列表', () => {
  assert.equal(parseValue('20'), 20);
  assert.equal(parseValue('true'), true);
  assert.equal(parseValue('false'), false);
  assert.equal(parseValue('Guests'), 'Guests');
  assert.equal(parseValue('192.168.1.1'), '192.168.1.1'); // 不当成数字
  assert.deepEqual(parseValue('5,6'), [5, 6]);
  assert.deepEqual(parseValue('1,2,4'), [1, 2, 4]);
});

test('coerceArrays: 需要数组的参数 (tagged=1) 被包成数组, 其它参数保持不变', () => {
  const ctx = { enabled: true, portCount: 8, maxVlans: 32, vlans: [{ id: 1, tagged: [], untagged: [1, 2] }, { id: 10, tagged: [1], untagged: [3, 4] }] };
  const validate = (p) => validateOp('vlan.q.set', p, ctx);
  const fixed = coerceArrays(validate, { vid: 20, name: 'Guests', untagged: [5, 6], tagged: 1 });
  assert.deepEqual(fixed, { vid: 20, name: 'Guests', untagged: [5, 6], tagged: [1] });
  assert.deepEqual(validate(fixed), []);
  // 已经合法的参数不会被改动
  const ok = { vid: 20, name: 'Guests', untagged: [5, 6], tagged: [1] };
  assert.deepEqual(coerceArrays(validate, ok), ok);
  // 参数本身有问题时不会被"修好": 错误原样留给校验器报告
  const bad = coerceArrays(validate, { vid: 99999, name: 'Guests', untagged: [5, 6], tagged: [1] });
  assert.equal(bad.vid, 99999);
  assert.deepEqual(validate(bad), ['VLAN ID 取值范围为 1-4094']);
});

test('table: 按终端显示宽度对齐 (中文占两格)', () => {
  const wide = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/;
  const shown = (line) => [...line].reduce((n, ch) => n + (wide.test(ch) ? 2 : 1), 0);
  const lines = table(['端口', '状态'], [[1, '在线'], [12, 'up'], [3, '—']]).split('\n');
  assert.equal(lines.length, 5, '表头 + 分隔线 + 三行');
  assert.equal(new Set(lines.map(shown)).size, 1, `各行显示宽度应相同: ${JSON.stringify(lines)}`);
  assert.equal(table(['a'], []), '(空)');
});

// ── 帮助与用法 ────────────────────────────────────────────────────────

test('help 退出码 0; 不带命令退出码 2 并把用法打到 stderr; 未知命令 / 缺少必填参数 → 2', async () => {
  assert.equal((await cli(['help'])).code, 0);
  assert.equal((await cli([])).code, 2);
  const unknown = await cli(['frobnicate']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.err, /未知的命令: frobnicate/);
  assert.doesNotMatch(unknown.err, /用法: switchctl/, '简单的用法错误不重复打印整篇帮助');
  const usageJson = await json(['get']);
  assert.equal(usageJson.code, 2);
  assert.equal(usageJson.json.error.code, 'USAGE');
});

// ── 临时指定一台交换机 (--url) ────────────────────────────────────────

test('--url: 读状态 (文本 / JSON)', async () => {
  const text = await cli([...URL(), 'status']);
  assert.equal(text.code, 0);
  assert.match(text.out, /TL-SG2008D/);
  assert.match(text.out, /02:00:5E:01:02:03/); // 合成夹具里的虚构地址
  assert.match(text.out, /1000M 全双工/);

  const r = await json([...URL(), 'status']);
  assert.equal(r.code, 0);
  assert.equal(r.json.overview.device.model, 'TL-SG2008D');
  assert.equal(r.json.overview.ports.length, 8);
  assert.equal(r.json.system.hardware, '3.0');
});

test('--url: 各读取命令', async () => {
  assert.match((await cli([...URL(), 'vlans'])).out, /Office/);
  assert.match((await cli([...URL(), 'lag'])).out, /LAG 1\s+7-8/);
  const qos = await cli([...URL(), 'qos']);
  assert.match(qos.out, /基于端口/);
  assert.match(qos.out, /2,048/);
  const detail = await cli([...URL(), 'stats', '--port', '2']);
  assert.match(detail.out, /端口 2 报文统计/);
  const model = await json([...URL(), 'get', 'vlan8021q']);
  assert.deepEqual(model.json.vlan8021q.vlans.map((v) => v.id), [1, 10, 20, 30]);
  const ops = await cli([...URL(), 'ops']);
  assert.match(ops.out, /vlan\.q\.set/);
  assert.match(ops.out, /system\.reset\s+恢复出厂设置\s+是/);
  assert.equal(mock.writes.length, 0, '读取命令不产生写请求');
});

test('--url: 密码不对 / 地址连不上 / 认不出的设备 / 不支持的模型键', async () => {
  const bad = await cli(['--url', mock.url, ...USER, '--password', 'wrong', 'status']);
  assert.equal(bad.code, 1);
  assert.equal(mock.writes.length, 0);
  const down = await cli(['--url', 'http://127.0.0.1:9', ...USER, '--password', 'x', 'status']);
  assert.equal(down.code, 1);
  const model = await json([...URL(), 'get', 'nope']);
  assert.equal(model.code, 2);
  assert.match(model.json.error.message, /未知的模型键/);
  const both = await cli([...URL(), '--device', 'x', 'status']);
  assert.equal(both.code, 2);
});

test('--url: 修改端口 → 发给交换机的字段与界面一致', async () => {
  const r = await json([...URL(), 'port', 'set', '--ports', '1-2', '--speed', '100f']);
  assert.equal(r.code, 0);
  assert.equal(r.json.ok, true);
  const write = lastWrite('port_setting.cgi');
  assert.deepEqual(write.fields.filter(([k]) => k === 'portid').map(([, v]) => v), ['1', '2']);
  assert.equal(write.fields.find(([k]) => k === 'speed')?.[1], '5');
  assert.equal(write.fields.find(([k]) => k === 'state')?.[1], '7', '7 = 保持不变');
  assert.equal(write.fields.find(([k]) => k === 'flowcontrol')?.[1], '7');
  assert.deepEqual(r.json.fresh.ports.ports.slice(0, 2).map((p) => p.speedAct), [5, 5], '回读结果显示链路已经是 100M');
});

test('禁用端口: 无人值守时必须 --yes; 否则什么都不发', async () => {
  const before = mock.writes.length;
  const refused = await cli([...URL(), 'port', 'disable', '--ports', '3']);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /--yes/);
  assert.equal(mock.writes.length, before, '被拒绝的操作不能到达交换机');
  assert.equal((await cli([...URL(), 'port', 'disable', '--ports', '3', '--yes'])).code, 0);
  assert.equal(lastWrite('port_setting.cgi').fields.find(([k]) => k === 'state')?.[1], '0');
});

test('op: 规范写操作, 参数经校验后才提交; 不合法的参数不会发出去', async () => {
  const before = mock.writes.length;
  const bad = await cli([...URL(), 'op', 'lag.set', 'group=2', 'ports=7']); // 汇聚组至少 2 个口
  assert.equal(bad.code, 1);
  assert.match(bad.err, /请选择成员端口/);
  assert.equal(mock.writes.length, before);

  const ok = await cli([...URL(), 'op', 'vlan.q.set', 'vid=20', 'name=Guests2', 'untagged=5,6', 'tagged=1', '--yes']);
  assert.equal(ok.code, 0);
  assert.equal(lastWrite('qvlanSet.cgi').fields.find(([k]) => k === 'vname')?.[1], 'Guests2');
  assert.deepEqual(lastWrite('qvlanSet.cgi').fields.filter(([k]) => k.startsWith('selType_')).map(([k, v]) => [k, v]), [
    ['selType_1', '1'], ['selType_2', '2'], ['selType_3', '2'], ['selType_4', '2'], ['selType_5', '0'], ['selType_6', '0'], ['selType_7', '2'], ['selType_8', '2'],
  ]);
  assert.match((await cli([...URL(), 'vlans'])).out, /Guests2/);
});

test('危险操作: 重启需要 --yes; 恢复出厂设置还需要 --confirm-text', async () => {
  const before = mock.writes.length;
  assert.equal((await cli([...URL(), 'reboot'])).code, 1);
  assert.equal((await cli([...URL(), 'op', 'system.reset', '--yes'])).code, 2, '缺少确认文字');
  assert.equal((await cli([...URL(), 'op', 'system.reset', '--confirm-text', 'RESET'])).code, 1, '缺少 --yes');
  assert.equal(mock.writes.length, before, '没有任何请求到达交换机');
});

test('mac / cable / save / firmware check / backup', async () => {
  assert.match((await cli([...URL(), 'mac', 'aa:bb:cc:dd:ee:ff'])).out, /AA:BB:CC:DD:EE:FF\s+10\s+3/);
  assert.match((await cli([...URL(), 'mac', '00:11:22:33:44:55'])).out, /没有找到/);
  const cable = await cli([...URL(), 'cable', '--ports', '1,2']);
  assert.match(cable.out, /开路/);
  assert.match(cable.out, /正常/);
  assert.equal((await cli([...URL(), 'save'])).code, 0);
  assert.ok(lastWrite('savingconfig.cgi'));
  assert.match((await cli([...URL(), 'firmware', 'check'])).out, /已是最新版本/);
  const file = join(dir, 'backup.cfg');
  const backup = await json([...URL(), 'backup', '--out', file]);
  assert.equal(backup.code, 0);
  assert.ok(backup.json.bytes > 100);
  assert.ok(readFileSync(file).length === backup.json.bytes);
});

test('--url 模式不创建数据目录', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'netpanel-cli-empty-'));
  try {
    await cli([...URL(), '--data-dir', join(empty, 'data'), 'status']);
    assert.deepEqual((await import('node:fs')).readdirSync(empty), []);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

// ── 面板里的设备 (数据目录) ────────────────────────────────────────────

test('没初始化时设备管理命令拒绝执行, 并提示怎么办', async () => {
  const r = await PANEL('devices', 'list');
  assert.equal(r.code, 1);
  assert.match(r.err, /还没有初始化/);
  assert.match(r.err, /switchctl setup/);
});

test('setup → devices add → 操作 → disable/enable → set → remove', async () => {
  const setup = await PANEL('setup', '--user', 'admin', '--password', 'panel-password-1');
  assert.equal(setup.code, 0);
  assert.match(setup.out, /已创建管理员账号 admin/);
  assert.equal((await PANEL('setup', '--password', 'panel-password-1')).code, 1, '不能初始化两次');
  assert.equal((await PANEL('setup', '--password', 'short')).code, 1);

  const empty = await PANEL('devices', 'list');
  assert.match(empty.out, /还没有绑定设备/);

  const add = await json(['--data-dir', dir, 'devices', 'add', '客厅', mock.url, ...USER, '--password', 'admin', '--tags', '家里, 实验室', '--interval', '20']);
  assert.equal(add.code, 0);
  assert.equal(add.json.model, 'TL-SG2008D');
  assert.equal(add.json.portCount, 8);
  assert.equal(add.json.pollIntervalSec, 20);
  assert.deepEqual(add.json.tags, ['家里', '实验室']);
  const id = add.json.id;

  const second = await PANEL('devices', 'add', 'Second', mock.url, ...USER, '--password', 'admin');
  assert.equal(second.code, 0);
  const ambiguous = await PANEL('status');
  assert.equal(ambiguous.code, 2);
  assert.match(ambiguous.err, /绑定了多台设备/);

  const list = await PANEL('devices', 'list');
  assert.match(list.out, /客厅/);
  assert.match(list.out, /Second/);
  const status = await PANEL('status', 'Second'); // 设备名直接当位置参数
  assert.equal(status.code, 0);
  assert.match(status.out, /Second/);
  assert.equal((await PANEL('--device', '客厅', 'status')).code, 0);
  assert.equal((await PANEL('--device', 'nope', 'status')).code, 1);
  assert.equal((await PANEL('--device', id, 'status')).code, 0, '也可以用 id');

  const test = await PANEL('devices', 'test', '客厅');
  assert.match(test.out, /8/);
  const token = await PANEL('token');
  assert.match(token.out.trim(), /^[A-Za-z0-9_-]{32}$/);
  assert.notEqual((await PANEL('token', '--rotate')).out.trim(), token.out.trim());

  await PANEL('devices', 'disable', '客厅');
  const disabled = await PANEL('--device', '客厅', 'status');
  assert.equal(disabled.code, 1);
  assert.match(disabled.err, /已停用/);
  assert.equal((await PANEL('devices', 'enable', '客厅')).code, 0);

  const set = await json(['--data-dir', dir, 'devices', 'set', 'Second', '--name', '机房', '--interval', 'default', '--notes', '机柜 B']);
  assert.equal(set.json.name, '机房');
  assert.equal(set.json.pollIntervalSec, 15, '恢复默认轮询间隔');
  assert.equal(set.json.notes, '机柜 B');

  assert.equal((await PANEL('devices', 'remove', '机房')).code, 1, '无人值守时解除绑定也要 --yes');
  assert.equal((await PANEL('devices', 'remove', '机房', '--yes')).code, 0);
  const after = await json(['--data-dir', dir, 'devices', 'list']);
  assert.deepEqual(after.json.devices.map((d) => d.name), ['客厅']);

  const passwd = await PANEL('user', 'passwd', '--old-password', 'panel-password-1', '--password', 'panel-password-2');
  assert.equal(passwd.code, 0);
  assert.equal((await PANEL('user', 'passwd', '--old-password', 'panel-password-1', '--password', 'panel-password-3')).code, 1, '改过之后旧密码不能再用了');

  // 设备密码在磁盘上只有密文 (v1:iv:tag:ct); 面板密码只有 scrypt 哈希
  const stored = JSON.parse(readFileSync(join(dir, 'devices.json'), 'utf8'));
  const records = Array.isArray(stored) ? stored : stored.devices ?? Object.values(stored);
  assert.ok(records.length >= 1);
  for (const rec of records) assert.match(rec.secret, /^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
  assert.match(readFileSync(join(dir, 'auth.json'), 'utf8'), /"hash": "scrypt\$/);
});

test('绑定设备上的写操作与 --url 模式一致', async () => {
  const before = mock.writes.length;
  const r = await json(['--data-dir', dir, '--device', '客厅', 'port', 'set', '--ports', '8', '--flow', 'on']);
  assert.equal(r.code, 0);
  assert.equal(lastWrite('port_setting.cgi').fields.find(([k]) => k === 'flowcontrol')?.[1], '1');
  assert.equal(mock.writes.length, before + 1);
});

test('密码也可以从标准输入读 (非交互)', async () => {
  const r = await cli(['--url', mock.url, ...USER, 'status'], { stdinText: 'admin\n' });
  assert.equal(r.code, 0);
  const missing = await cli(['--url', mock.url, ...USER, 'status'], { stdinText: '' });
  assert.equal(missing.code, 1);
});
