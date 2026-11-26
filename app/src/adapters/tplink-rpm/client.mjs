// TP-Link 旧版 Web 界面 (Rpm) 适配器的传输层: TL-SG2008D 等使用 *Rpm.htm 页面体系的固件。
//
// 要点:
//  - 所有请求串行执行: 嵌入式 Web 服务对并发连接处理很差, 偶发直接断开。
//  - 读请求遇到网络错误自动重试; 写请求不自动重试 (重复下发可能重复生效), 结果未知时明确报错。
//  - 响应是登录页 → 说明会话失效 → 自动重新登录后重放一次。
//  - 写操作只能走 core/ops.mjs 的白名单, 这里不提供任意路径转发。

import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { parseVars, scripts } from '../../core/jslite.mjs';
import { OPS, validateOp } from '../../core/ops.mjs';
import { SwitchError } from '../../core/errors.mjs';
import { PAGES, STATS_DETAIL } from './pages.mjs';
import { buildOp, TID } from './ops.mjs';

const LOGIN_PAGE = /var\s+logonInfo\s*=\s*new\s+Array/;
const RETRYABLE = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNABORTED', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNREFUSED']);
const RETRY_DELAYS = [150, 400, 900, 1800];
const WRITE_TIMEOUT = 30000; // 保存配置等到 FLASH 的操作比较慢
const FILE_TIMEOUT = 600000; // 固件上传与校验

const utf8 = new TextDecoder('utf-8', { fatal: true });
const gb18030 = new TextDecoder('gb18030');

// 原厂 cryp_new.js 里的 "hex_md5": 名字叫 md5, 实际是固定密钥的异或编码。
const ENC_KEY = 'RDpbLfCPsJZ7fiv';
const ENC_ALPHA = 'yLwVl0zKqws7LgKPRQ84Mdt708T1qQ3Ha7xv3H7NyU84p21BriUWBU43odz3iP4rBL3cD02KZciXTysVXiV8ngg6vL48rPJyAUw0HurW20'
  + 'xqxv9aYb4M9wK1Ae0wlro510qXeU07kV57fQMc8L6aLgMLwygtc0F10a0Dg70TOoouyFhdysuRMO51yY5ZlOZZLEal1h0t9YQW0Ko7oBwmCAHoic4HYbUyVeU3sfQ1xtXcPcf1aT303wAQhv66qzW';

export function securityEncode(password) {
  let out = '';
  const len = Math.max(password.length, ENC_KEY.length);
  for (let i = 0; i < len; i++) {
    const a = i < password.length ? password.charCodeAt(i) : 187;
    const b = i < ENC_KEY.length ? ENC_KEY.charCodeAt(i) : 187;
    out += ENC_ALPHA[(a ^ b) % ENC_ALPHA.length];
  }
  return out;
}

const LOGON_ERRORS = {
  1: '用户名或密码错误',
  2: '该用户不允许登录',
  3: '允许登录的用户数量已满',
  4: '允许登录的用户数量已满（最多 16 个用户同时登录）',
};

const isLoginPage = (body) => LOGIN_PAGE.test(body.subarray(0, 400).toString('latin1'));

function decodeText(body) {
  try {
    return utf8.decode(body);
  } catch {
    return gb18030.decode(body); // 个别页面是 GBK
  }
}

const offlineError = (err, host) => new SwitchError(`无法连接交换机 (${host})`, err?.code === 'SW_TIMEOUT' ? 'TIMEOUT' : 'OFFLINE', { cause: err });

const UNCERTAIN_MESSAGE = '交换机在处理请求时断开了连接，操作结果未知，请刷新后确认';

const isNetworkError = (err) => RETRYABLE.has(err?.code) || err?.code === 'SW_TIMEOUT' || err?.code === 'ECONNRESET';

export class RpmClient {
  #baseUrl;
  #username;
  #password;
  #timeout;
  #maxRetries;
  #cookie = '';
  #chain = Promise.resolve();

  /**
   * @param {{ baseUrl: string, username: string, password: string, timeout?: number, maxRetries?: number }} opts
   */
  constructor({ baseUrl, username, password, timeout = 10000, maxRetries = RETRY_DELAYS.length }) {
    this.#baseUrl = new URL(baseUrl);
    if (this.#baseUrl.protocol !== 'http:') throw new SwitchError('交换机地址只支持 http://', 'BAD_PARAM');
    this.#username = username;
    this.#password = password;
    this.#timeout = timeout;
    this.#maxRetries = maxRetries;
  }

  get host() {
    return this.#baseUrl.host;
  }

  /** 队列化: 同一时刻只有一个请求在途。 */
  #serial(task) {
    const run = this.#chain.then(task, task);
    this.#chain = run.then(() => undefined, () => undefined);
    return run;
  }

  /** 把站内路径解析成完整地址。原厂表单的 action 是相对路径 (如 port_setting.cgi), 按浏览器规则补成 /port_setting.cgi。
   *  只接受由安全字符组成的站内路径, 永远不会请求到交换机以外的地址。 */
  #url(pathWithQuery) {
    const [path, query = ''] = String(pathWithQuery).split('?');
    const absolute = path.startsWith('/') ? path : `/${path}`;
    if (absolute.includes('..') || !/^\/(?:[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*)?$/.test(absolute)) throw new SwitchError('非法路径', 'BAD_PARAM');
    return new URL(`${absolute}?${query}`, this.#baseUrl);
  }

  #httpOnce(pathWithQuery, { method = 'GET', body, contentType, timeout } = {}) {
    return new Promise((resolve, reject) => {
      const headers = {
        'User-Agent': 'Mozilla/5.0 (switch-panel)',
        Accept: '*/*',
        Referer: this.#baseUrl.href,
      };
      if (this.#cookie) headers.Cookie = this.#cookie;
      if (contentType) headers['Content-Type'] = contentType;
      if (method !== 'GET' && method !== 'HEAD') headers['Content-Length'] = body ? body.length : 0;
      const req = http.request(this.#url(pathWithQuery), { method, headers, agent: false }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('error', reject);
        res.on('aborted', () => reject(Object.assign(new Error('响应中断'), { code: 'ECONNRESET' })));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.setTimeout(timeout ?? this.#timeout, () => req.destroy(Object.assign(new Error('请求超时'), { code: 'SW_TIMEOUT' })));
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  /** 发一次请求, 跟随站内重定向。不重试。 */
  async #http(pathWithQuery, opts = {}) {
    let path = pathWithQuery;
    let { method, body, contentType, timeout } = opts;
    for (let hop = 0; hop < 4; hop++) {
      const res = await this.#httpOnce(path, { method, body, contentType, timeout });
      const loc = res.headers.location;
      if (![301, 302, 303, 307, 308].includes(res.status) || !loc) return res;
      const next = new URL(loc, this.#baseUrl);
      if (next.origin !== this.#baseUrl.origin) return res; // 不跟到站外
      path = next.pathname + next.search;
      if (res.status === 302 || res.status === 303) {
        method = 'GET';
        body = undefined;
        contentType = undefined;
      }
    }
    throw new SwitchError('交换机重定向次数过多', 'BAD_RESPONSE');
  }

  /** 读请求: 网络错误自动重试。 */
  async #httpRetry(pathWithQuery) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#http(pathWithQuery);
      } catch (err) {
        if (!RETRYABLE.has(err?.code) && err?.code !== 'SW_TIMEOUT') throw err;
        if (attempt >= this.#maxRetries) throw offlineError(err, this.host);
        await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
      }
    }
  }

  // ── 会话 ────────────────────────────────────────────────────────────

  async login() {
    return this.#serial(() => this.#login());
  }

  async #login() {
    const form = new URLSearchParams({ username: this.#username, password: securityEncode(this.#password), isIe: '', logon: '登录', code: '' });
    let res;
    try {
      res = await this.#http('/logon.cgi', { method: 'POST', body: Buffer.from(String(form)), contentType: 'application/x-www-form-urlencoded' });
    } catch (err) {
      throw offlineError(err, this.host);
    }
    const code = Number(/logonInfo\s*=\s*new\s+Array\(\s*(\d+)/.exec(decodeText(res.body))?.[1] ?? -1);
    if (code !== 0) {
      throw new SwitchError(LOGON_ERRORS[code] ?? `交换机拒绝登录（代码 ${code}）`, code === 1 ? 'BAD_CREDENTIALS' : 'LOGIN_FAILED', { logonCode: code });
    }
    const sid = /SessionID=([^;,\s]+)/.exec(res.headers['set-cookie']?.join('; ') ?? '');
    if (!sid) throw new SwitchError('登录响应里没有会话信息', 'BAD_RESPONSE');
    this.#cookie = `SessionID=${sid[1]}`;
    return true;
  }

  /** 退出登录, 释放交换机上有限的会话名额。尽力而为。 */
  async logout() {
    const cookie = this.#cookie;
    this.#cookie = '';
    if (!cookie) return;
    await this.#serial(async () => {
      try {
        await this.#http('/Logout.htm');
      } catch {
        // 会话超时后交换机会自行回收
      }
    });
  }

  /** 交换机是否在线 (单次尝试, 不重试)。 */
  async ping() {
    return this.#serial(async () => {
      try {
        await this.#http('/', { timeout: 4000 });
        return true;
      } catch {
        return false;
      }
    });
  }

  /** 读一个页面; 若返回登录页则重新登录后重放一次。 */
  async #fetch(pathWithQuery) {
    let res = await this.#httpRetry(pathWithQuery);
    if (isLoginPage(res.body)) {
      await this.#login();
      res = await this.#httpRetry(pathWithQuery);
      if (isLoginPage(res.body)) throw new SwitchError('登录状态无效，请重新登录', 'SESSION');
    }
    return res;
  }

  #parse(body) {
    const html = decodeText(body);
    const vars = parseVars(scripts(html)[0] ?? '');
    return { html, vars, tip: typeof vars.tip === 'string' ? vars.tip : '' };
  }

  async #tidUnlocked() {
    const { body } = await this.#fetch('/');
    const tid = /g_tid\s*=\s*(\d+)/.exec(decodeText(body))?.[1];
    if (!tid) throw new SwitchError('没能从交换机取得会话令牌', 'BAD_RESPONSE');
    return tid;
  }

  // ── 读 ──────────────────────────────────────────────────────────────

  /** 按注册表读取并归一化一个页面。 @returns {Promise<{data: object, tip: string}>} */
  async read(key) {
    return this.#serial(async () => {
      const page = Object.hasOwn(PAGES, key) ? PAGES[key] : undefined;
      if (!page) throw new SwitchError(`未知页面: ${String(key).slice(0, 40)}`, 'BAD_PARAM');
      const { vars, tip } = this.#parse((await this.#fetch(page.path)).body);
      return { data: page.model(vars), tip };
    });
  }

  /** 单端口报文统计明细。 */
  async readStats(port) {
    return this.#serial(async () => {
      if (!Number.isInteger(port) || port < 1 || port > 64) throw new SwitchError('端口不合法', 'BAD_PARAM');
      const tid = await this.#tidUnlocked();
      const query = `${STATS_DETAIL.buildQuery(port)}&token=${encodeURIComponent(tid)}`;
      const { vars } = this.#parse((await this.#fetch(`${STATS_DETAIL.path}?${query}`)).body);
      return STATS_DETAIL.model(vars, port);
    });
  }

  /** 主框架页里的全局信息 (型号、用户级别、是否有新固件)。 */
  async frame() {
    return this.#serial(async () => {
      const html = decodeText((await this.#fetch('/')).body);
      const pick = (re) => re.exec(html)?.[1] ?? null;
      return {
        model: pick(/g_title\s*=\s*'([^']*)'/),
        level: Number(pick(/g_level\s*=\s*(\d+)/) ?? 0),
        hasNewFirmware: pick(/g_hasNewFirmware\s*=\s*(\d+)/) === '1',
      };
    });
  }

  // ── 写 ──────────────────────────────────────────────────────────────

  /**
   * 执行白名单里的一个写操作 (校验 → 按原厂表单组包 → 发送)。
   * @returns {Promise<{tip: string, vars: object, data: object|undefined, status: number, disconnected: boolean}>}
   *          vars 是返回页里的变量; data 是把 vars 按该操作的"结果模型"整理后的结果
   *          (只有 MAC 搜索、线缆检测这类"结果就在返回页里"的操作才有)。
   */
  async submit(name, params, ctx) {
    const errors = validateOp(name, params, ctx);
    if (errors.length) throw new SwitchError(errors.join('；'), 'BAD_PARAM', { details: errors });
    const req = buildOp(name, params, ctx, securityEncode);
    const result = await this.sendRaw({ path: req.path, method: req.method, send: req.send, fields: req.fields, expectDisconnect: req.expectDisconnect });
    const model = OPS[name].result ? PAGES[OPS[name].result]?.model : null;
    return { ...result, data: model && result.vars ? model(result.vars) : undefined };
  }

  /**
   * 内部专用: 发送一个写请求。只供 server.mjs 里写死的备份/还原/升级流程使用, 不接受来自前端的路径。
   * @param {{ path: string, method?: string, send: 'form'|'multipart'|'query', fields?: [string, any][],
   *           file?: { name: string, filename: string, data: Buffer }, contentType?: string,
   *           expectDisconnect?: boolean, timeout?: number }} spec
   * @returns {Promise<{status: number, headers: object, body: Buffer, tip: string, vars: object, disconnected: boolean}>}
   *          vars 是响应页里的变量 —— 有些操作 (MAC 搜索、线缆检测) 的结果就在返回的页面里。
   */
  async sendRaw(spec) {
    return this.#serial(async () => {
      const { path, body, contentType } = encodeRequest(spec, await this.#tidUnlocked());
      const timeout = spec.timeout ?? (spec.file ? FILE_TIMEOUT : WRITE_TIMEOUT);
      const send = () => this.#http(path, { method: spec.method ?? 'POST', body, contentType, timeout });
      const dropped = () => ({ status: 0, headers: {}, body: Buffer.alloc(0), tip: '', vars: {}, disconnected: true });
      // 只有网络层面的中断才算"结果未知"; 面板自己的参数/路径错误原样抛出, 不伪装成连接问题
      const uncertain = (err) => {
        if (isNetworkError(err)) throw new SwitchError(UNCERTAIN_MESSAGE, 'UNCERTAIN', { cause: err });
        throw err;
      };
      let res;
      try {
        res = await send();
      } catch (err) {
        // 重启/复位时服务端可能直接断开, 属预期; 其它情况结果未知, 不盲目重发
        if (spec.expectDisconnect && isNetworkError(err)) return dropped();
        return uncertain(err);
      }
      if (isLoginPage(res.body)) {
        await this.#login(); // 交换机先校验会话才处理请求, 返回登录页说明操作没有被执行
        try {
          res = await send();
        } catch (err) {
          if (spec.expectDisconnect && isNetworkError(err)) return dropped();
          return uncertain(err);
        }
        if (isLoginPage(res.body)) throw new SwitchError('登录状态无效，操作没有提交', 'SESSION');
      }
      const { tip, vars } = this.#parse(res.body);
      return { status: res.status, headers: res.headers, body: res.body, tip, vars, disconnected: false };
    });
  }
}

/** 把白名单操作或内部请求编码成最终的 HTTP 请求。 */
function encodeRequest(spec, tid) {
  const value = (v) => String(v === TID ? tid : v);
  let path = spec.path;
  if (spec.send === 'query') {
    const qs = (spec.fields ?? []).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(value(v))}`).join('&');
    path += `?${qs}`;
  }
  if (!spec.file && spec.send !== 'multipart') {
    if (spec.send === 'query') return { path, contentType: spec.contentType }; // 空请求体 (原厂用 XHR.send() 提交的那几个接口)
    const form = new URLSearchParams();
    for (const [k, v] of spec.fields) form.append(k, value(v));
    return { path, body: Buffer.from(String(form)), contentType: 'application/x-www-form-urlencoded' };
  }
  // 原厂还原配置的表单: token 在查询串里, 请求体只有文件
  return { path, ...encodeMultipart(spec.send === 'query' ? [] : spec.fields ?? [], spec.file, value) };
}

function encodeMultipart(fields, file, value) {
  const boundary = `----SwitchPanel${randomBytes(12).toString('hex')}`;
  const parts = [];
  for (const [name, v] of fields) {
    const text = value(v);
    if (/[\r\n]/.test(text)) throw new SwitchError('字段含非法字符', 'BAD_PARAM'); // 防止注入额外的 part
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${text}\r\n`));
  }
  if (file) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
    parts.push(file.data);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}
