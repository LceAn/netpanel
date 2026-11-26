// TP-LINK JetStream 交换机较新固件 (3.x) 的 JSON 接口客户端。
// 实验性: 按公开的逆向资料实现 (两个开源项目对 T1600G / T2600G 固件 3.0.3 的抓包), 没有在真机上验证过。
//
//   POST {base}/data/login.json                        { username, password, operation: "write" }
//        → { success: true, data: { _tid_: "…", usrLvl: 15, … } }
//   POST {base}/data/<接口>.json?_tid_=…&usrLvl=…      { operation: "read" | "load" | …, …参数 }
//        → { success: true | false, errorcode?: 数字, data: … }      (表格类接口出错时 success 仍是 true, 所以以 success 为准)
//   POST {base}/data/logout.json?_tid_=…&usrLvl=…      { operation: "write" }
//
// 这类交换机默认用 HTTPS + 自签证书, 所以不校验证书 —— 与管理员在浏览器里点"继续访问"是同一回事。

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { SwitchError } from '../../core/errors.mjs';

const MAX_BODY = 4 * 1024 * 1024;
const HEADERS = { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };

/** 发一个请求, 收完整的响应。连接失败 / 超时按设备侧的错误报告。 */
function send(url, { body = '', timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'POST',
      headers: { ...HEADERS, Referer: `${url.origin}/`, Origin: url.origin, 'Content-Length': Buffer.byteLength(body) },
      rejectUnauthorized: false, // 只对 https 生效
      timeout,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) return req.destroy(new SwitchError('交换机返回的内容过大', 'BAD_RESPONSE'));
        chunks.push(c);
      });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('请求超时'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end(body);
  });
}

/** 把网络层的错误翻译成设备侧的错误 (与 RPM 客户端用同一套代码, 上层的处理不变)。 */
function translate(err) {
  if (err instanceof SwitchError) return err;
  if (err?.code === 'ETIMEDOUT') return new SwitchError(`连接交换机超时 (${err.message})`, 'TIMEOUT', { cause: err });
  return new SwitchError(`无法连接交换机 (${err?.code ?? err?.message ?? '未知错误'})`, 'OFFLINE', { cause: err });
}

/**
 * 不带会话地调用一个只读接口, 返回响应正文 (探测用)。
 * 新版固件会回答一个 JSON 信封 (success: false), 旧版固件回答的是 HTML 登录页 —— 以此区分两代设备。
 */
export async function probeEndpoint(baseUrl, { endpoint = 'version', timeout = 4000 } = {}) {
  const target = new URL(baseUrl);
  const url = new URL(`/data/${endpoint}.json`, target);
  const res = await send(url, { body: JSON.stringify({ operation: 'read' }), timeout });
  return res.body.slice(0, 2000);
}

export class JsonClient {
  #baseUrl;
  #username;
  #password;
  #timeout;
  #tid = null;
  #usrLvl = 0;
  #chain = Promise.resolve(); // 同一连接上的请求一个接一个发

  constructor({ baseUrl, username, password, timeout = 10000 }) {
    this.#baseUrl = new URL(baseUrl);
    this.#username = username;
    this.#password = password;
    this.#timeout = timeout;
  }

  /** 登录后的会话令牌; 没登录过是 null。 */
  get tid() {
    return this.#tid;
  }

  #url(endpoint) {
    const url = new URL(`/data/${endpoint}.json`, this.#baseUrl);
    if (this.#tid) {
      url.searchParams.set('_tid_', this.#tid);
      url.searchParams.set('usrLvl', String(this.#usrLvl));
    }
    return url;
  }

  /** 同一连接上的请求一个接一个发。只在对外的方法 (login / call / logout) 里调用: 排队的任务内部一律用不带 # 的私有方法, 否则会自己等自己。 */
  #serial(fn) {
    const run = this.#chain.then(fn, fn);
    this.#chain = run.catch(() => {});
    return run;
  }

  async #post(endpoint, payload) {
    const url = this.#url(endpoint);
    try {
      const res = await send(url, { body: JSON.stringify(payload), timeout: this.#timeout });
      let json;
      try {
        json = JSON.parse(res.body);
      } catch {
        throw new SwitchError('交换机没有返回 JSON —— 这多半不是使用新版 Web 界面的交换机', 'BAD_RESPONSE');
      }
      if (!json || typeof json !== 'object') throw new SwitchError('交换机返回的 JSON 不是对象', 'BAD_RESPONSE');
      return json;
    } catch (err) {
      throw translate(err);
    }
  }

  /** 登录并保存会话令牌。已经登录过 (或别的调用刚登录完) 就什么都不做。 */
  async login() {
    return this.#serial(() => this.#loginNow());
  }

  async #loginNow() {
    if (this.#tid) return;
    const json = await this.#post('login', { username: this.#username, password: this.#password, operation: 'write' });
    const data = json.data && typeof json.data === 'object' ? json.data : {};
    if (json.success !== true || typeof data._tid_ !== 'string' || !data._tid_) {
      // 与原厂页面一致: 不区分"账号不存在"和"密码错误"
      throw new SwitchError('用户名或密码错误', 'BAD_CREDENTIALS', { status: 401 });
    }
    this.#tid = data._tid_;
    this.#usrLvl = Number(data.usrLvl) || 0;
  }

  /**
   * 调用一个接口, 返回信封里的 data。
   * 会话失效 (设备重启、超时被踢) 时自动重新登录并重试一次。
   */
  async call(endpoint, operation, extra = {}) {
    return this.#serial(async () => {
      await this.#loginNow();
      const payload = { operation, ...(extra && typeof extra === 'object' ? extra : {}) };
      let json = await this.#post(endpoint, payload);
      if (json.success !== true) {
        this.#tid = null;
        await this.#loginNow();
        json = await this.#post(endpoint, payload);
      }
      if (json.success !== true) throw new SwitchError(`交换机拒绝了 ${endpoint} 请求 (errorcode ${json.errorcode ?? '?'})`, 'BAD_RESPONSE');
      return json.data ?? null;
    });
  }

  async logout() {
    if (!this.#tid) return;
    try {
      await this.#serial(() => send(this.#url('logout'), { body: JSON.stringify({ operation: 'write' }), timeout: this.#timeout }));
    } catch {
      // 退出失败无所谓: 令牌会在设备那边过期
    }
    this.#tid = null;
  }
}
