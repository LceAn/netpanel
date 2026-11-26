// switchctl —— NetPanel 的命令行。与 Web 面板共用同一套核心 (数据目录、设备表、适配器、规范操作):
// 命令行能做的事和界面一致, 参数校验、危险操作确认也走同一套逻辑。
//
// 两种指定设备的方式:
//   面板里绑定的设备   switchctl --device 客厅 ports              (读写数据目录里的设备表, 需要先 setup)
//   临时指定一台交换机  switchctl --url http://192.168.1.1 --user admin ports   (不依赖面板, 不保存任何东西)
// 只绑定了一台设备时可以不写 --device。
//
// 全部命令支持 --json。退出码: 0 成功, 1 失败, 2 用法错误。

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AdapterRegistry } from '../core/adapter.mjs';
import { AppError, normalizeError } from '../core/errors.mjs';
import { backup as backupDevice, checkFirmware as checkDeviceFirmware, restore as restoreDevice, runOp } from '../core/device-service.mjs';
import { APP_ROOT } from '../core/config.mjs';
import { registerAdapters } from '../adapters/index.mjs';
import { MODELS } from '../core/models.mjs';
import { OPS, validateOp } from '../core/ops.mjs';
import { ID_RE, normalizeUrl } from '../core/store/devices.mjs';
import { openPanel } from '../http/server.mjs';

export const USAGE = `NetPanel 命令行 switchctl

用法: switchctl [选项] <命令> [参数]

选项:
  --device <名称|id>      要操作的那台设备 (已绑定到面板的)
  --url <地址>            临时操作一台交换机, 不经过面板: --url http://192.168.1.1 --user admin [--password ..]
  --user <账号>           交换机的管理账号 (配合 --url, 或 devices add)
  --password <密码>       密码。不给则读环境变量 NETPANEL_PASSWORD, 再没有就交互式询问
  --adapter <id>          指定适配器 (默认自动识别, 见 adapters)
  --data-dir <目录>       面板的数据目录 (默认 <程序目录>/data, 或环境变量 PANEL_DATA_DIR)
  --json                  以 JSON 输出结果
  --yes                   跳过危险操作的确认 (脚本里用)
  --confirm-text <文字>   需要手工输入确认文字的操作 (恢复出厂设置)
  --quiet                 不输出过程信息

面板:
  serve                          启动 Web 面板 (与 node server.mjs 相同)
  setup                          创建面板管理员账号 (首次运行, 只需一次)
  user passwd                    修改面板管理员密码 (需要 --old-password)
  token [--rotate]               查看指标访问令牌; --rotate 重新生成 (旧令牌立即失效)
  adapters                       已注册的适配器

设备管理:
  devices list                   列出已绑定的设备
  devices add <名称> <地址>       绑定一台交换机: --user <账号> [--password <密码>] [--tags 家里,机房] [--interval 15]
  devices remove <设备>          解除绑定 (不会改动交换机)
  devices enable|disable <设备>  启用 / 停用后台轮询
  devices test <设备>            用保存的账号密码重新连接并识别
  devices set <设备>             修改绑定信息: [--name ..] [--url ..] [--user ..] [--password ..] [--tags ..] [--notes ..] [--interval ..]

读取设备:
  status                         设备信息和各端口状态
  ports                          端口配置
  stats [--port N]               端口统计; 指定 --port 时输出该端口的报文明细
  vlans                          802.1Q VLAN 与 PVID
  lag                            链路聚合
  qos                            QoS 模式、优先级、带宽与风暴抑制
  get <模型键>                   读任意一个规范模型, 以 JSON 输出: overview ports stats system ip fixIp user cloud lag isolation
                                 mirror loop cable vlanMtu vlanPort vlan8021q vlanPvid qosBasic qosBandwidth qosStorm firmware
  ops                            这台设备支持哪些写操作

修改设备:
  port set --ports 1,2-4         批量设置端口: [--state enable|disable] [--speed auto|10h|10f|100h|100f|1000f|2.5g] [--flow on|off]
  port enable|disable --ports    启用 / 禁用端口
  mac <MAC> [--vlan N]           搜索 MAC 地址是从哪个端口学到的
  cable [--ports 1,2]            线缆检测 (不给 --ports 则检测全部可检测的端口)
  save                           保存配置到 FLASH
  backup [--out <文件>]          下载配置备份
  restore <文件>                 用备份文件还原配置 (设备会重启)
  reboot [--no-save]             重启交换机
  firmware check                 在线检查新固件版本
  op <操作> [键=值 ...]          提交任意一个规范写操作。例: op vlan.q.set vid=20 name=Guests untagged=5,6 tagged=1

例:
  switchctl devices add 客厅 http://192.168.2.20 --user admin --tags 家里
  switchctl --device 客厅 port set --ports 5,6 --speed 100f
  switchctl --url http://192.168.2.21 --user admin --json status
`;

const FLAGS = new Set(['json', 'yes', 'quiet', 'rotate', 'no-save', 'help']);
/** 第一个词本身不是命令、要和第二个词合起来才是命令的。 */
const TWO_WORD = new Set(['devices', 'user', 'port', 'firmware']);
const SHORT = { y: 'yes', h: 'help' };

/** 解析命令行参数: --key value / --key=value / 单字母开关; `--` 之后的内容都当作位置参数。 */
export function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      opts._.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (FLAGS.has(key)) {
        if (eq > 0) throw new Error(`--${key} 不接受值`);
        opts[key] = true;
        continue;
      }
      const value = eq > 0 ? a.slice(eq + 1) : argv[++i];
      if (value === undefined) throw new Error(`--${key} 需要一个值`);
      opts[key] = value;
    } else if (/^-[a-z]$/i.test(a) && SHORT[a[1]]) opts[SHORT[a[1]]] = true;
    else opts._.push(a);
  }
  return opts;
}

// ── 输出 ──────────────────────────────────────────────────────────────

const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/;
/** 终端里的显示宽度: 中日韩文字和全角符号占 2 格。 */
const width = (s) => [...String(s ?? '')].reduce((n, ch) => n + (WIDE.test(ch) ? 2 : 1), 0);
const pad = (s, w) => {
  const text = String(s ?? '');
  return text + ' '.repeat(Math.max(0, w - width(text)));
};

const num = (v) => (Number.isFinite(v) ? v.toLocaleString('en-US') : '—');
const rate = (kbps) => {
  if (!Number.isFinite(kbps)) return '—';
  if (kbps >= 1e6) return `${(kbps / 1e6).toFixed(2)} Gbps`;
  if (kbps >= 1e3) return `${(kbps / 1e3).toFixed(2)} Mbps`;
  return `${Math.round(kbps)} Kbps`;
};
const portText = (list) => {
  const out = [];
  for (const n of [...(list ?? [])].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && last[1] === n - 1) last[1] = n;
    else out.push([n, n]);
  }
  return out.length ? out.map(([a, b]) => (a === b ? String(a) : `${a}-${b}`)).join(',') : '—';
};

/** "1,3-5" → [1,3,4,5]。不合法抛错。 */
export function parsePorts(text) {
  const out = new Set();
  for (const part of String(text).split(',')) {
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part.trim());
    if (!m) throw new AppError(`端口列表不合法: ${part.trim()}`, 'BAD_PARAM');
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (b < a || b - a > 255 || a < 1) throw new AppError(`端口列表不合法: ${part.trim()}`, 'BAD_PARAM');
    for (let n = a; n <= b; n++) out.add(n);
  }
  if (!out.size) throw new AppError('请至少选择一个端口', 'BAD_PARAM');
  return [...out];
}

/** "a,b,c" → 去重后的标签列表 (允许为空)。 */
const splitTags = (text) => (text === undefined || text === null ? [] : [...new Set(String(text).split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean))]);

/** op 命令的参数值: 键=值。值按 JSON 解析, 失败当字符串; 带逗号的拆成数组 (1,2,3 → [1,2,3])。 */
export function parseValue(text) {
  const one = (s) => {
    if (/^-?\d+$/.test(s)) return Number(s);
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (s === 'null') return null;
    return s;
  };
  const parts = String(text).split(',');
  return parts.length > 1 ? parts.map(one) : one(String(text));
}

const SPEED = { 0: '关闭', 1: '自动', 2: '10M 半双工', 3: '10M 全双工', 4: '100M 半双工', 5: '100M 全双工', 6: '1000M 全双工', 7: '2.5G 全双工', 8: '保持不变' };
const SPEED_ALIAS = { off: 0, auto: 1, '10h': 2, '10f': 3, '100h': 4, '100f': 5, '1000f': 6, '1g': 6, '2.5g': 7 };
const ONOFF = ['关闭', '开启'];
const QOS_MODE = ['基于端口', '基于 802.1P', '基于 DSCP'];
const STORM = { 1: '未知单播', 2: '组播', 4: '广播' };
const CABLE = { '-1': '未检测', 0: '无线缆', 1: '正常', 2: '开路', 3: '短路', 4: '开路 & 短路', 5: '阻抗失配', 6: '不支持' };
const PKT_TYPES = ['单播', '组播', '广播', 'Pause 帧', '小于 64 字节', 'CRC 错误', 'Fragments', 'Jabbers', 'Collisions'];

// ── 主流程 ────────────────────────────────────────────────────────────

/**
 * 运行一次命令行。返回退出码。
 * @param {string[]} argv 不含 node 和脚本名
 * @param {{ env?: object, stdin?: stream, stdout?: stream, stderr?: stream, appRoot?: string }} io  测试时替换
 */
export async function runCli(argv, { env = process.env, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, appRoot = APP_ROOT } = {}) {
  const say = (text = '') => stdout.write(`${text}\n`);
  const warn = (text = '') => stderr.write(`${text}\n`);
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    warn(`参数错误: ${err.message}\n\n运行 switchctl help 查看完整用法。`);
    return 2;
  }
  const [command, sub, ...rest] = opts._;
  const cmd = TWO_WORD.has(command) ? `${command} ${sub ?? ''}`.trim() : command; // devices add / port set / firmware check …
  let ctx = null;
  // 多词命令 (devices add / port set …) 之后的都是位置参数; 单词命令的第二个词就是第一个位置参数
  const positional = cmd === command ? [sub, ...rest].filter((x) => x !== undefined) : rest;

  try {
    if (!command || opts.help || command === 'help') {
      (command ? say : warn)(USAGE);
      return command ? 0 : 2;
    }
    if (!COMMANDS.has(cmd)) throw new AppError(`未知的命令: ${cmd}`, 'USAGE');
    if (opts.quiet && opts.json) throw new AppError('--quiet 和 --json 不能一起用', 'USAGE');

    ctx = { // 赋给外面声明的变量: catch 里要用 json 模式决定错误怎么输出
      opts, env, stdin, stdout, stderr, say, warn, appRoot, json: !!opts.json, yes: !!opts.yes,
      // 没有自己的位置参数的设备命令, 第一个位置参数就是设备名: switchctl status 客厅
      pos: NO_POSITIONAL.has(cmd) ? positional[0] : undefined,
    };
    // JSON 模式下命令只返回数据, 由这里统一输出; 文本模式下命令自己打印
    const result = await COMMANDS.get(cmd)(ctx, positional);
    if (ctx.json && result !== undefined) say(JSON.stringify(result, null, 2));
    return 0;
  } catch (err) {
    const e = normalizeError(err);
    if (e.code === 'USAGE') {
      if (ctx?.json) say(JSON.stringify({ ok: false, error: { message: e.message, code: e.code } }, null, 2));
      else warn(`用法错误: ${e.message}\n\n运行 switchctl help 查看完整用法。`);
      return 2;
    }
    if (e.code === 'CANCELLED') {
      if (!ctx.quiet) warn('已取消');
      return 1;
    }
    if (ctx?.json) say(JSON.stringify({ ok: false, error: { message: e.message, code: e.code, ...(e.details?.length ? { details: e.details } : {}) } }, null, 2));
    else {
      warn(`错误: ${e.message}`);
      for (const d of e.details ?? []) warn(`  - ${d}`);
      if (e.internal && e.cause) warn(e.cause.stack ?? String(e.cause));
    }
    return 1;
  }
}

// ── 命令表 ────────────────────────────────────────────────────────────

const COMMANDS = new Map();
const NO_POSITIONAL = new Set(['status', 'ports', 'stats', 'vlans', 'lag', 'qos', 'ops', 'save', 'reboot', 'backup', 'firmware check', 'port set', 'port enable', 'port disable', 'cable']);

const command = (name, fn) => COMMANDS.set(name, fn);

const need = (value, what) => {
  if (value === undefined || value === null || value === '') throw new AppError(`缺少 ${what}`, 'USAGE');
  return value;
};

/** 是否交互式运行 (可以在终端里询问、确认)。 */
const interactive = (io) => !!io.stdin.isTTY;

/** 读密码: 参数 > 环境变量 NETPANEL_PASSWORD > 终端里隐藏输入 > (非交互) 从标准输入读一行。 */
async function readPassword(io, { arg, label = '密码' }) {
  if (arg !== undefined) return String(arg);
  if (io.env.NETPANEL_PASSWORD) return io.env.NETPANEL_PASSWORD;
  if (!interactive(io)) {
    const chunks = [];
    for await (const chunk of io.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  }
  io.stderr.write(`${label}: `);
  io.stdin.setRawMode(true);
  io.stdin.resume();
  io.stdin.setEncoding('utf8');
  let value = '';
  await new Promise((done) => {
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n') {
        io.stdin.off('data', onData);
        io.stdin.setRawMode(false);
        io.stdin.pause();
        io.stderr.write('\n');
        done();
      } else if (ch === '\u0003') {
        io.stderr.write('\n');
        process.exit(130);
      } else if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
      else value += ch;
    };
    io.stdin.on('data', onData);
  });
  return value;
}

/** 危险操作在终端里问一句; 非交互运行必须带 --yes。 */
async function confirm(io, text) {
  if (io.yes) return;
  if (!interactive(io)) throw new AppError(`这是危险操作, 无人值守运行时请加 --yes 表示已确认 (${text})`, 'CONFIRM_REQUIRED');
  io.stderr.write(`${text}\n继续请输入 y: `);
  io.stdin.setRawMode(true);
  io.stdin.resume();
  io.stdin.setEncoding('utf8');
  let answer = '';
  await new Promise((done) => {
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n') {
        io.stdin.off('data', onData);
        io.stdin.setRawMode(false);
        io.stdin.pause();
        io.stderr.write('\n');
        done();
      } else if (ch === '\u0003') process.exit(130);
      else if (ch !== '\u007f') answer += ch;
    };
    io.stdin.on('data', onData);
  });
  if (answer.trim().toLowerCase() !== 'y') throw new AppError('用户取消', 'CANCELLED');
}

/** 规范写操作的危险确认: 标志位和确认文字与界面走同一个校验 (core/ops.mjs validateOp)。 */
async function guard(io, name, params, where) {
  const def = OPS[name];
  if (!def) throw new AppError(`未知操作: ${String(name).slice(0, 40)}`, 'NOT_FOUND');
  if (!def.danger) return;
  if (def.confirmText) {
    if (io.opts['confirm-text'] !== def.confirmText) throw new AppError(`「${def.title}」不可撤销, 请加 --confirm-text ${def.confirmText} 表示确认`, 'USAGE');
    params.confirmText = def.confirmText;
  }
  await confirm(io, `即将在「${where}」上执行「${def.title}」${def.confirmText ? ' (不可撤销)' : ''}。`);
  params.confirm = true;
}

/** 打开面板的数据目录。设备管理类的命令要求先创建管理员账号 (与界面保持一致)。 */
function openData(io, { requireSetup = true } = {}) {
  const parts = openPanel({ appRoot: io.appRoot, env: { ...io.env, ...(io.opts['data-dir'] ? { PANEL_DATA_DIR: io.opts['data-dir'] } : {}) } });
  if (requireSetup && parts.auth.setupRequired) {
    throw new AppError('面板还没有初始化: 先运行 switchctl setup (或打开网页创建管理员账号); 也可以用 --url 直接操作一台交换机', 'SETUP_REQUIRED');
  }
  return parts;
}

// ── 面板本身 ──────────────────────────────────────────────────────────

command('serve', async (io) => {
  const { main } = await import('../http/server.mjs');
  await main({ appRoot: io.appRoot, env: io.env });
  await new Promise(() => {}); // 进程由 HTTP 服务和信号处理接管
});

command('setup', async (io, { username }) => {
  const parts = openData(io, { requireSetup: false });
  const user = username ?? io.opts.user ?? 'admin';
  const password = await readPassword(io, { arg: io.opts.password, label: '设置面板密码 (至少 8 个字符)' });
  const again = interactive(io) ? await readPassword(io, { arg: undefined, label: '再输入一次' }) : password;
  if (password !== again) throw new AppError('两次输入的密码不一致', 'BAD_PARAM');
  parts.auth.setup({ username: user, password });
  if (!io.json && !io.opts.quiet) io.say(`已创建管理员账号 ${user}。运行 switchctl serve 或 node server.mjs 启动面板。`);
  return io.json ? { ok: true, username: user, dataDir: parts.config.dataDir } : undefined;
});

command('user passwd', async (io) => {
  const parts = openData(io);
  const oldPassword = await readPassword(io, { arg: io.opts['old-password'], label: '当前密码' });
  const newPassword = await readPassword(io, { arg: io.opts.password, label: '新密码 (至少 8 个字符)' });
  parts.auth.users.changePassword(parts.auth.users.username, oldPassword, newPassword);
  if (!io.json && !io.opts.quiet) io.say('面板密码已修改, 所有已登录的浏览器需要重新登录。');
  return io.json ? { ok: true } : undefined;
});

command('token', async (io) => {
  const { settings } = openData(io);
  const token = io.opts.rotate ? settings.rotateMetricsToken() : settings.ensureMetricsToken();
  if (io.json) return { metricsToken: token, rotated: !!io.opts.rotate };
  io.say(token);
  return undefined;
});

command('adapters', async (io) => {
  const parts = openData(io, { requireSetup: false });
  const adapters = parts.adapters.list().map((a) => ({ id: a.id, name: a.name, vendor: a.vendor, maturity: a.maturity }));
  if (io.json) return { adapters };
  io.say(table(['id', '名称', '厂商', '成熟度'], adapters.map((a) => [a.id, a.name, a.vendor, a.maturity])));
  return undefined;
});

// ── 设备管理 ──────────────────────────────────────────────────────────

/** 按名称 (不区分大小写) 或 id 找设备。 */
function findDevice(parts, key) {
  const all = parts.manager.list();
  if (key === undefined || key === null || key === '') {
    if (all.length === 1) return all[0];
    throw new AppError(all.length ? '绑定了多台设备, 请用 --device <名称|id> 指定' : '还没有绑定设备 (switchctl devices add …)', 'USAGE');
  }
  const want = String(key);
  const hit = all.find((d) => d.id === want) ?? all.find((d) => d.name.toLowerCase() === want.toLowerCase());
  if (!hit) throw new AppError(`找不到设备「${want}」, 现有设备: ${all.map((d) => d.name).join(', ') || '(无)'}`, 'NOT_FOUND');
  return hit;
}

const HEALTH_TEXT = { online: '在线', offline: '离线', auth: '凭据失效', error: '出错', disabled: '已停用', unknown: '未轮询' };

command('devices list', async (io) => {
  const devices = openData(io).manager.list();
  if (io.json) return { devices };
  if (!devices.length) {
    io.say('还没有绑定设备。用 switchctl devices add <名称> <地址> --user <账号> 添加一台。');
    return undefined;
  }
  io.say(table(
    ['名称', 'id', '地址', '型号', '状态', '端口', '标签'],
    devices.map((d) => [d.name, d.id, d.url.replace(/^https?:\/\//, ''), d.model ?? '—', HEALTH_TEXT[d.health] ?? d.health, `${d.portsUp}/${d.portCount ?? '?'}`, (d.tags ?? []).join(',') || '—']),
  ));
  io.say('\n(状态来自后台轮询; 面板没在运行时不会更新, 用 devices test 实际连一次)');
  return undefined;
});

command('devices add', async (io, [name, url]) => {
  need(name, '设备名称: devices add <名称> <地址>');
  need(url, '设备地址: devices add <名称> <地址>');
  const username = need(io.opts.user, '--user <交换机账号>');
  const password = await readPassword(io, { arg: io.opts.password });
  const { manager } = openData(io);
  const interval = io.opts.interval === undefined ? null : Number(io.opts.interval);
  const device = await manager.add({
    name, url, username, password,
    adapter: io.opts.adapter ?? 'auto',
    tags: splitTags(io.opts.tags),
    notes: io.opts.notes ?? '',
    ...(interval !== null ? { pollIntervalSec: interval } : {}),
  });
  if (io.json) return device;
  if (!io.opts.quiet) io.say(`已绑定 ${device.name} (${device.id}): ${device.model}, ${device.portCount} 个端口, 固件 ${device.firmware}`);
  return undefined;
});

command('devices remove', async (io, [key]) => {
  const key2 = need(io.opts.device ?? key, '要解除绑定的设备 (名称或 --device)');
  const parts = openData(io);
  const device = findDevice(parts, key2);
  await confirm(io, `解除绑定「${device.name}」(${device.url})? 不会改动交换机上的任何配置。`);
  await parts.manager.remove(device.id);
  return io.json ? { ok: true } : (io.opts.quiet ? undefined : io.say(`已解除绑定 ${device.name}`));
});

command('devices enable', async (io, [key]) => setEnabled(io, key, true));
command('devices disable', async (io, [key]) => setEnabled(io, key, false));

async function setEnabled(io, key, enabled) {
  const { manager } = openData(io);
  const device = findDevice({ manager }, need(io.opts.device ?? key, '设备 (名称或 --device)'));
  const updated = await manager.update(device.id, { enabled });
  return io.json ? updated : (io.opts.quiet ? undefined : io.say(`${updated.name}: ${enabled ? '已启用' : '已停用'}`));
}

command('devices test', async (io, [key]) => {
  const parts = openData(io);
  const device = findDevice(parts, need(io.opts.device ?? key, '设备 (名称或 --device)'));
  const res = await parts.manager.test({
    url: device.url, adapter: device.adapter, username: device.username, password: parts.store.credentials(device.id).password,
  });
  if (io.json) return res;
  io.say(kv([
    ['设备', `${device.name}  ${device.url}`],
    ['适配器', res.adapter.name],
    ['型号', res.identified.model || '—'],
    ['固件', res.identified.firmware || '—'],
    ['硬件版本', res.identified.hardware || '—'],
    ['MAC', res.identified.mac || '—'],
    ['端口数', String(res.identified.ports ?? '—')],
  ]));
  return undefined;
});

command('devices set', async (io, [key]) => {
  const parts = openData(io);
  const device = findDevice(parts, need(io.opts.device ?? key, '设备 (名称或 --device)'));
  const o = io.opts;
  const patch = {};
  if (o.name !== undefined) patch.name = o.name;
  if (o.url !== undefined) patch.url = o.url;
  if (o.user !== undefined) patch.username = o.user;
  if (o.password !== undefined || (o.user !== undefined && o.password === undefined && interactive(io))) patch.password = await readPassword(io, { arg: o.password, label: '新的设备密码 (留空表示不修改)' });
  if (o.tags !== undefined) patch.tags = splitTags(o.tags);
  if (o.notes !== undefined) patch.notes = o.notes;
  if (o.interval !== undefined) patch.pollIntervalSec = o.interval === '' || o.interval === 'default' ? null : Number(o.interval);
  if (!Object.keys(patch).length) throw new AppError('没有指定要修改的内容 (--name / --url / --user / --password / --tags / --notes / --interval)', 'USAGE');
  const updated = await parts.manager.update(device.id, patch);
  if (io.json) return updated;
  if (!io.opts.quiet) io.say(`已更新 ${updated.name}`);
  return undefined;
});

// ── 访问设备 (面板里的设备, 或 --url 临时指定) ─────────────────────────

/**
 * 解析要操作的设备, 返回统一的一组方法。两种来源的行为完全一致。
 * - 已绑定: 走 DeviceManager (用面板保存的密码, 健康状态随之更新)
 * - --url: 临时建一条连接, 用完立刻退出登录, 不写任何文件
 */
async function openTarget(io, positional) {
  const o = io.opts;
  if (o.url && (o.device || positional)) throw new AppError('--url 和 --device 只能二选一', 'USAGE');
  if (o.url) {
    const url = normalizeUrl(o.url);
    const username = need(o.user, '--user <交换机账号>');
    const password = await readPassword(io, { arg: o.password });
    const adapters = new AdapterRegistry(); // 临时模式只用适配器表, 不创建数据目录, 也不读写任何文件
    registerAdapters(adapters);
    const adapter = o.adapter && o.adapter !== 'auto' ? adapters.get(o.adapter) : await adapters.detect(url);
    if (!adapter) throw new AppError(`认不出 ${url} 上的设备: 没有发现受支持的交换机管理界面`, 'UNSUPPORTED');
    const connection = adapter.create({ url, credentials: { username, password } });
    const target = {
      label: url,
      adapter,
      read: async (key) => (await connection.read(key)).data,
      readStats: (port) => connection.readStats(port),
      submit: (op, params) => runOp(connection, adapter, op, params),
      backup: () => backupDevice(connection, adapter),
      restore: (file) => restoreDevice(connection, adapter, file),
      checkFirmware: () => checkDeviceFirmware(connection, adapter),
      close: () => connection.logout().catch(() => {}),
    };
    try {
      await target.read('overview'); // 先登录: 账号密码不对在这里就报出来
      return target;
    } catch (err) {
      await target.close();
      throw err;
    }
  }
  const parts = openData(io);
  const device = findDevice(parts, o.device ?? positional);
  const { manager } = parts;
  return {
    label: device.name,
    adapter: parts.adapters.get(device.adapter),
    device,
    read: async (key) => (await manager.read(device.id, key, { live: true })).data,
    readStats: (port) => manager.readStats(device.id, port),
    submit: (op, params) => manager.submit(device.id, op, params),
    backup: () => manager.backup(device.id),
    restore: (file) => manager.restore(device.id, file),
    checkFirmware: () => manager.checkFirmware(device.id),
    close: () => parts.close(),
  };
}

async function withTarget(io, fn) {
  const target = await openTarget(io, io.pos);
  try {
    return await fn(target);
  } finally {
    await target.close();
  }
}

const portState = (p) => (!p.enabled ? '禁用' : p.speedAct ? SPEED[p.speedAct] : '断开');

command('status', (io, [device]) => withTarget(io, async (t) => {
  const [overview, system] = await Promise.all([t.read('overview'), t.adapter.reads.includes('system') ? t.read('system') : Promise.resolve(null)]);
  if (io.json) return { overview, system };
  const d = overview.device;
  io.say(kv([
    ['设备', t.device ? `${t.device.name}  ${t.device.url}` : t.label],
    ['型号', [d.model, system?.model && system.model !== d.model ? system.model : ''].filter(Boolean).join(' / ') || '—'],
    ['描述', d.description || '—'],
    ['固件', d.firmware || '—'],
    ['硬件版本', system?.hardware || '—'],
    ['MAC', d.mac || '—'],
    ['管理地址', d.dhcp ? `${d.ip} (DHCP)` : d.ip],
    ['子网掩码', d.netmask || '—'],
    ['网关', d.gateway || '—'],
    ['DNS', d.dns ? `${d.dns}${d.dnsAuto ? ' (自动)' : ''}` : '—'],
    ['运行时间', d.uptimeText || '—'],
    ['云管理', overview.cloud.enabled ? (overview.cloud.connected ? '已启用, 已连接' : '已启用, 未连接') : '未启用'],
  ]));
  io.say(`\n${table(
    ['端口', '状态', '接收', '发送', 'VLAN', 'LAG'],
    overview.ports.map((p) => [p.id, portState(p), rate(p.rxKbps), rate(p.txKbps), p.vlans?.length ? portText(p.vlans) : '—', p.lag ? `LAG ${p.lag}` : '—']),
  )}`);
  return undefined;
}));

command('ports', (io, [device]) => withTarget(io, async (t) => {
  const ports = await t.read('ports');
  if (io.json) return ports;
  io.say(table(
    ['端口', '状态', '速率 / 双工', '实际链路', '流控', 'LAG'],
    ports.ports.map((p) => [p.id, p.enabled ? '启用' : '禁用', SPEED[p.speedCfg] ?? p.speedCfg, p.speedAct ? SPEED[p.speedAct] : '断开', ONOFF[p.flowCfg] ?? '—', p.lag ? `LAG ${p.lag}` : '—']),
  ));
  return undefined;
}));

command('stats', (io) => withTarget(io, async (t) => {
  if (io.opts.port !== undefined) {
    const port = Number(io.opts.port);
    if (!Number.isInteger(port) || port < 1) throw new AppError('--port 应为端口号', 'USAGE');
    const detail = await t.readStats(port);
    if (io.json) return detail;
    io.say(`端口 ${port} 报文统计\n\n${table(['类型', '接收', '发送'], PKT_TYPES.map((name, i) => [name, num(detail.rx[i]), num(detail.tx[i])]))}`);
    return undefined;
  }
  const stats = await t.read('stats');
  if (io.json) return stats;
  io.say(table(
    ['端口', '链路', '接收 (正常)', '接收 (错误)', '发送 (正常)', '发送 (错误)'],
    stats.ports.map((p) => [p.id, p.enabled ? (SPEED[p.link] ?? '断开') : '禁用', num(p.rxGood), num(p.rxBad), num(p.txGood), num(p.txBad)]),
  ));
  return undefined;
}));

command('vlans', (io, [device]) => withTarget(io, async (t) => {
  const keys = ['vlan8021q', 'vlanPvid'].filter((k) => t.adapter.reads.includes(k));
  const data = Object.fromEntries(await Promise.all(keys.map(async (k) => [k, await t.read(k)])));
  if (io.json) return data;
  if (data.vlan8021q) {
    io.say(`802.1Q VLAN: ${data.vlan8021q.enabled ? '已启用' : '未启用'}\n`);
    io.say(table(['VLAN', '名称', 'Untagged', 'Tagged'], data.vlan8021q.vlans.map((v) => [v.id, v.name || '—', portText(v.untagged), portText(v.tagged)])));
  }
  if (data.vlanPvid) {
    io.say(`\nPVID\n`);
    io.say(table(['端口', 'PVID', 'LAG'], data.vlanPvid.ports.map((p) => [p.id, p.pvid, p.lag ? `LAG ${p.lag}` : '—'])));
  }
  return undefined;
}));

command('lag', (io, [device]) => withTarget(io, async (t) => {
  const lag = await t.read('lag');
  if (io.json) return lag;
  const rows = lag.groups.filter((g) => g.members.length);
  io.say(`链路聚合: 最多 ${lag.maxLag} 组, 每组 2-${lag.portsPerLag} 个端口\n`);
  io.say(rows.length ? table(['汇聚组', '成员端口'], rows.map((g) => [`LAG ${g.id}`, portText(g.members)])) : '还没有配置汇聚组。');
  return undefined;
}));

command('qos', (io, [device]) => withTarget(io, async (t) => {
  const keys = ['qosBasic', 'qosBandwidth', 'qosStorm'].filter((k) => t.adapter.reads.includes(k));
  const data = Object.fromEntries(await Promise.all(keys.map(async (k) => [k, await t.read(k)])));
  if (io.json) return data;
  if (data.qosBasic) {
    const { mode, ports } = data.qosBasic;
    io.say(`QoS 模式: ${QOS_MODE[mode] ?? mode}\n`);
    io.say(table(['端口', '优先级 (1 最低 - 4 最高)'], ports.map((p) => [p.id, p.priority])));
  }
  if (data.qosBandwidth) {
    io.say(`\n带宽控制 (Kbps, 0 = 不限制)\n`);
    io.say(table(['端口', '接收上限', '发送上限'], data.qosBandwidth.ports.map((p) => [p.id, num(p.ingress), num(p.egress)])));
  }
  if (data.qosStorm) {
    io.say(`\n风暴抑制\n`);
    io.say(table(['端口', '启用', '速率 (Kbps)', '报文类型'], data.qosStorm.ports.map((p) => [p.id, p.enabled ? '是' : '否', p.enabled ? num(p.rate) : '—', p.enabled ? p.types.map((x) => STORM[x] ?? x).join('、') : '—'])));
  }
  return undefined;
}));

command('get', (io, [key]) => {
  const model = need(key, `模型键, 例如: switchctl get vlan8021q (可用: ${Object.keys(MODELS).filter((k) => k !== 'macSearch').join(' ')})`);
  const readable = Object.keys(MODELS).filter((k) => k !== 'macSearch'); // macSearch 只是写操作的结果模型, 不能单独读
  if (!readable.includes(model)) throw new AppError(`未知的模型键「${model}」, 可用: ${readable.join(' ')}`, 'USAGE');
  return withTarget(io, async (t) => {
    const result = { [model]: await t.read(model) };
    if (!io.json) io.say(JSON.stringify(result, null, 2));
    return io.json ? result : undefined;
  });
});

command('ops', (io, [device]) => withTarget(io, async (t) => {
  const ops = t.adapter.writes.map((name) => ({ op: name, title: OPS[name]?.title ?? name, danger: !!OPS[name]?.danger }));
  if (io.json) return { ops };
  io.say(table(['操作', '说明', '危险'], ops.map((x) => [x.op, x.title, x.danger ? '是' : ''])));
  io.say('\n参数格式见文档 (docs/cli.md), 或用 --json 看各操作的校验提示。');
  return undefined;
}));

// ── 修改设备 ──────────────────────────────────────────────────────────

const SPEED_ARG = (text) => {
  const code = SPEED_ALIAS[String(text).toLowerCase()];
  if (code === undefined) throw new AppError(`--speed 不合法: ${text} (可选 ${Object.keys(SPEED_ALIAS).join('|')})`, 'USAGE');
  return code;
};

command('port set', async (io) => {
  const ports = parsePorts(need(io.opts.ports, '--ports <端口列表>, 例如 --ports 1,3-5'));
  const state = io.opts.state === undefined ? 7 : io.opts.state === 'enable' || io.opts.state === 'on' ? 1 : io.opts.state === 'disable' || io.opts.state === 'off' ? 0 : null;
  if (state === null) throw new AppError('--state 只能是 enable 或 disable', 'USAGE');
  if (state === 0 || SPEED_ARG(io.opts.speed ?? 'auto') === 0) await confirm(io, DISABLE_TEXT(ports));
  const flow = io.opts.flow === undefined ? 7 : io.opts.flow === 'on' ? 1 : io.opts.flow === 'off' ? 0 : null;
  if (flow === null) throw new AppError('--flow 只能是 on 或 off', 'USAGE');
  const params = { ports, state, speed: io.opts.speed === undefined ? 8 : SPEED_ARG(io.opts.speed), flow }; // 7 / 8 = 保持不变
  return submit(io, 'port.settings', params);
});

command('port enable', (io) => submit(io, 'port.settings', { ports: parsePorts(need(io.opts.ports, '--ports <端口列表>')), state: 1, speed: 8, flow: 7 }));
command('port disable', async (io) => {
  const ports = parsePorts(need(io.opts.ports, '--ports <端口列表>'));
  await confirm(io, DISABLE_TEXT(ports));
  return submit(io, 'port.settings', { ports, state: 0, speed: 8, flow: 7 });
});

// 禁用端口在规范操作里不算"危险操作" (界面按情况提示), 但在命令行里手滑禁掉上联口就会失联, 所以统一问一句
const DISABLE_TEXT = (ports) => `禁用端口 ${ports.join(', ')}? 链路会立即断开; 如果其中有正在使用的管理链路, 会连不上交换机。`;

/**
 * 命令行里的参数都是标量, 而规范操作里"端口列表"这类参数要数组 (untagged=5,6 会解析成数组, tagged=1 却是一个数字)。
 * 哪些参数要数组没有现成的名单, 所以让校验器来判断: 逐个参数试着包成数组, 校验错误变少了就采用。
 */
export function coerceArrays(validate, params) {
  const best = { ...params };
  let errors = validate(best).length;
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value) || (typeof value !== 'number' && typeof value !== 'string')) continue;
    const tried = { ...best, [key]: [value] };
    const count = validate(tried).length;
    if (count < errors) {
      best[key] = [value];
      errors = count;
    }
  }
  return best;
}

/** 提交一个规范写操作, 成功后输出设备的提示。 */
async function submit(io, op, params) {
  return withTarget(io, async (t) => {
    const def = OPS[op];
    if (!def) throw new AppError(`未知操作: ${String(op).slice(0, 40)}`, 'NOT_FOUND');
    const ctx = def.ctxPage ? await t.read(def.ctxPage) : undefined; // 与 runOp 相同的校验上下文
    const full = coerceArrays((p) => validateOp(op, p, ctx), params);
    await guard(io, op, full, t.label);
    const res = await t.submit(op, full);
    if (io.json) return res;
    if (!io.opts.quiet) io.say(res.tip || `完成: ${OPS[op]?.title ?? op}`);
    return undefined;
  });
}

command('mac', (io, [mac]) => withTarget(io, async (t) => {
  const vid = io.opts.vlan === undefined ? '' : Number(io.opts.vlan);
  const res = await t.submit('mac.search', { mac: need(mac, 'MAC 地址, 例如: switchctl mac aa:bb:cc:dd:ee:ff'), vid });
  const rows = res.data?.results ?? [];
  if (io.json) return res;
  io.say(rows.length ? table(['MAC 地址', 'VLAN', '端口'], rows.map((r) => [r.mac, res.data.qvlan ? r.vid : '—', r.port])) : '没有找到这个 MAC 地址。');
  return undefined;
}));

command('cable', (io) => withTarget(io, async (t) => {
  const cable = await t.read('cable');
  const ports = io.opts.ports === undefined ? cable.results.filter((r) => r.enabled).map((r) => r.id) : parsePorts(io.opts.ports);
  const res = await t.submit('cable.run', { ports });
  const results = res.data?.results ?? [];
  if (io.json) return res;
  io.say(table(['端口', '线缆状态', '长度 (米)'], results.map((r) => [r.id, CABLE[r.state] ?? r.state, r.length >= 0 ? r.length : '—'])));
  return undefined;
}));

command('save', (io) => submit(io, 'config.save', {}));

command('backup', (io) => {
  const out = io.opts.out;
  return withTarget(io, async (t) => {
    const file = await t.backup();
    const target = out || file.filename;
    try {
      writeFileSync(target, file.body);
    } catch (err) {
      throw new AppError(`无法写入 ${target}: ${err.message}`, 'IO', { cause: err, status: 500 });
    }
    if (io.json) return { file: target, bytes: file.body.length };
    io.say(`配置备份已保存到 ${target} (${file.body.length} 字节)`);
    return undefined;
  });
});

command('restore', (io, [file]) => withTarget(io, async (t) => {
  const name = need(file, '备份文件: switchctl restore <文件.cfg>');
  let data;
  try {
    data = readFileSync(name);
  } catch {
    throw new AppError(`读不到文件 ${name}`, 'NOT_FOUND');
  }
  await confirm(io, `用「${name}」覆盖「${t.label}」上的当前配置? 还原后设备会重启。`);
  const res = await t.restore({ name, data });
  if (io.json) return res;
  io.say(res.tip || '配置已还原, 设备正在重启');
  return undefined;
}));

command('reboot', (io) => submit(io, 'system.reboot', { save: !io.opts['no-save'] }));

command('firmware check', (io) => withTarget(io, async (t) => {
  const firmware = await t.checkFirmware();
  if (io.json) return firmware;
  io.say(kv([
    ['当前版本', firmware.firmware || '—'],
    ['硬件版本', firmware.hardware || '—'],
    ['在线升级', firmware.onlineUpgrade ? '支持' : '不支持'],
    ['新版本', firmware.hasNew === 1 ? firmware.newFirmware || '（版本号未知）' : firmware.hasNew === -1 ? '暂时无法获取' : '已是最新版本'],
    ...(firmware.releaseLog ? [['更新说明', firmware.releaseLog]] : []),
  ]));
  return undefined;
}));

command('op', (io, [name, ...pairs]) => {
  const op = need(name, `操作名, 例如: switchctl op vlan.q.set vid=20 name=Guests untagged=5,6`);
  const params = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq < 1) throw new AppError(`参数应写成 键=值: ${pair}`, 'USAGE');
    params[pair.slice(0, eq)] = parseValue(pair.slice(eq + 1));
  }
  return submit(io, op, params);
});

// ── 文本排版 ──────────────────────────────────────────────────────────

export function table(headers, rows) {
  if (!rows.length) return '(空)';
  const widths = headers.map((h, i) => Math.max(width(h), ...rows.map((r) => width(r[i]))));
  const line = (cells) => cells.map((c, i) => pad(c, widths[i])).join('  ');
  return [line(headers), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
}

export function kv(pairs) {
  const w = Math.max(...pairs.map(([k]) => width(k)));
  return pairs.map(([k, v]) => `${pad(k, w)}  ${v}`).join('\n');
}
