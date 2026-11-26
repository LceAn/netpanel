// TP-Link 旧版 Web 界面 (Rpm) 适配器: TL-SG2008D 及使用同一套 *Rpm.htm 页面体系的固件。
//
// 把传输层 (client.mjs)、读取模型 (pages.mjs)、表单编码 (ops.mjs) 封装成 core/adapter.mjs 约定的适配器,
// 并实现备份 / 还原 / 固件这几个"多步流程"——它们同样是这一代固件特有的, 所以放在适配器里而不是核心层。

import { defineAdapter } from '../../core/adapter.mjs';
import { AppError, SwitchError } from '../../core/errors.mjs';
import { RpmClient } from './client.mjs';
import { PAGES } from './pages.mjs';
import { BUILD, TID } from './ops.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const textOf = (result) => result.body.toString('utf8').trim();
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

/** 这一代固件的登录页特征 (不带凭据也能看到)。 */
const LOGIN_SIGNATURE = /var\s+logonInfo\s*=\s*new\s+Array/;

/** 不带凭据探测: 首页是不是这一代固件的登录页。超时或连不上一律当"不是"。 */
async function probe({ url }) {
  let target;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  if (target.protocol !== 'http:') return false; // 这一代固件只提供明文 HTTP
  try {
    const res = await fetch(target, { signal: AbortSignal.timeout(4000), redirect: 'manual' });
    if (!res.ok) return false;
    return LOGIN_SIGNATURE.test((await res.text()).slice(0, 600));
  } catch {
    return false;
  }
}

/** 登录后确认这确实是一台受支持的交换机, 并读出型号 / 固件 / 端口数。 */
async function identify(client) {
  let system;
  let overview;
  try {
    system = (await client.read('system')).data;
    overview = (await client.read('overview')).data;
  } catch (err) {
    if (err instanceof SwitchError && err.code === 'BAD_RESPONSE') throw unsupported();
    throw err;
  }
  // 读取模型对缺失的数据有默认值 (例如端口数默认 8), 所以不能只看"读到了东西":
  // 必须真的读到型号和固件版本, 否则多半是登录界面相似的其它设备 (路由器 / AP)。
  if (typeof system?.model !== 'string' || !system.model.trim() || typeof system?.firmware !== 'string' || !system.firmware.trim()) throw unsupported();
  const ports = overview?.ports?.length ?? 0;
  if (!ports || !overview.device) throw unsupported();
  return {
    model: system.model,
    firmware: system.firmware,
    hardware: system.hardware || '',
    mac: system.mac || overview.device.mac || '',
    ports,
    description: system.description || overview.device.description || '',
  };
}

const unsupported = () => new SwitchError('这台设备使用了相似的登录界面，但不是受支持的交换机', 'UNSUPPORTED');

function create({ url, credentials, options = {} }) {
  const client = new RpmClient({
    baseUrl: url,
    username: credentials.username,
    password: credentials.password,
    timeout: options.timeout,
    maxRetries: options.maxRetries,
  });

  // ── 固件: 原厂用 XHR 提交的几个接口 (空请求体, token 在查询串里) ──────────────────
  const tinyPost = (path) => client.sendRaw({ path, method: 'POST', send: 'query', fields: [['token', TID]], contentType: 'application/x-www-form-urlencoded' });

  /** 原厂 JS 取响应里 "value" 之后第 7 个字符当冲突标志 (1 = 已有升级在进行)。
   *  响应格式没法在不真正升级的前提下确认, 所以按 "value 之后出现的第一个 0/1" 来认。 */
  const parseConflict = (text) => {
    const at = text.indexOf('value');
    return (at >= 0 ? text.slice(at + 6) : text).slice(0, 16).replace(/^[^01]+/, '').startsWith('1');
  };

  const firmware = {
    async check() {
      await tinyPost('check_new_version_start.cgi');
      for (let i = 0; i < 40; i++) {
        await sleep(1000);
        if (textOf(await tinyPost('check_new_version.cgi')) !== '2') break; // 2 = 检查中
      }
      return (await client.read('firmware')).data;
    },
    async conflict() {
      return parseConflict(textOf(await tinyPost('upgradeConflict.cgi')));
    },
    async upgradeLocal(file) {
      await client.sendRaw({
        path: '/httpupg.cgi', method: 'POST', send: 'query', fields: [['cmd', 'fw_upgrade'], ['token', TID]],
        file: { name: 'firmware', filename: file.name, data: file.data },
      });
    },
    async upgradeOnline() {
      await tinyPost('upgrade_online.cgi');
    },
    /** 'running' | 'failed' | 'done'; 设备断开时抛错 (写完固件后设备会自行重启)。 */
    async status() {
      const state = textOf(await tinyPost('upgradeStatusCheck.cgi'));
      if (state === '1') return 'failed';
      if (state === '0') return 'done';
      return 'running';
    },
  };

  return {
    adapter: 'tplink-rpm',
    client,
    read: (key) => client.read(key),
    readStats: (port) => client.readStats(port),
    submit: (op, params, ctx) => client.submit(op, params, ctx),
    ping: () => client.ping(),
    identify: () => identify(client),
    logout: () => client.logout(),

    async backup() {
      const result = await client.sendRaw({ path: 'config_back.cgi', method: 'POST', send: 'multipart', fields: [['btnBackup', '配置备份'], ['token', TID]] });
      // 配置文件是二进制; 拿到 HTML 说明交换机返回的是出错提示页
      if (result.body.length === 0 || /^\s*</.test(result.body.subarray(0, 200).toString('latin1'))) {
        throw new SwitchError(result.tip || '交换机没有返回配置文件', 'BAD_RESPONSE');
      }
      const model = await client.frame().then((f) => f.model, () => null);
      return { body: result.body, filename: `${String(model ?? 'switch').replace(/[^\w.-]/g, '')}_${stamp()}.cfg` };
    },

    async restore(file) {
      const name = file.name.replace(/[^\\/]*[\\/]+/g, ''); // 与原厂一致: 只取文件名
      if (!/\.cfg$/i.test(name)) throw new AppError('请选择 .cfg 格式的配置文件', 'BAD_PARAM');
      if (file.data.length === 0) throw new AppError('配置文件是空的', 'BAD_PARAM');
      // 原厂表单: token 在查询串里, 请求体里只有文件。
      // 还原完成后交换机会重启并断开连接 (模拟器按这个行为实现; 真机上未验证), 所以把"连接被断开"当作正常结果
      const result = await client.sendRaw({
        path: 'conf_restore.cgi', method: 'POST', send: 'query', fields: [['token', TID]], expectDisconnect: true,
        file: { name: 'configfile', filename: name, data: file.data },
      });
      return { tip: result.tip, disconnected: result.disconnected };
    },

    firmware,
  };
}

export const rpmAdapter = defineAdapter({
  id: 'tplink-rpm',
  vendor: 'TP-LINK',
  name: 'TP-LINK 旧版 Web 界面',
  maturity: 'verified',
  // 能读的模型 = 有页面模型的那些 (macSearch 只是写操作的结果模型, 不是可读的页面)
  reads: Object.keys(PAGES).filter((key) => key !== 'macSearch'),
  // 能写的操作 = 规范操作里全部 (这套规范就是从这一代固件提炼出来的)
  writes: Object.keys(BUILD),
  features: ['statsDetail', 'backup', 'restore', 'firmwareLocal', 'firmwareOnline', 'firmwareCheck', 'reboot', 'reset'],
  probe,
  create,
});
