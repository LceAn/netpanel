// 面板的登录态。面板有自己的管理员账号 (users), 登录后发一个随机会话 Cookie。
//
// 和旧版的区别: 以前"登录面板"就是"登录交换机", 一个面板会话绑定一条交换机连接;
// 现在面板会话和设备连接彻底分开——设备连接由 DeviceManager 常驻维护, 与谁登录了面板无关。

import { randomBytes } from 'node:crypto';
import { AppError } from '../core/errors.mjs';

export const SESSION_COOKIE = 'netpanel_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 60 * 1000;
const LOGIN_MAX = 10;

export class PanelAuth {
  #sessions = new Map(); // token → { username, seen }
  #attempts = new Map(); // ip → { count, resetAt }
  #ttlMs;

  constructor({ users, ttlMs = SESSION_TTL_MS }) {
    this.users = users;
    this.#ttlMs = ttlMs;
  }

  /** 还没有创建管理员账号 (首次运行)。 */
  get setupRequired() {
    return !this.users.exists;
  }

  /** 从请求里取出有效的会话; 没有或已过期返回 null。 */
  sessionFrom(req) {
    const token = req.headers?.cookie ? cookieToken(req.headers.cookie) : null;
    if (!token) return null;
    const s = this.#sessions.get(token);
    if (!s) return null;
    if (Date.now() - s.seen > this.#ttlMs) {
      this.#sessions.delete(token);
      return null;
    }
    s.seen = Date.now();
    return { token, username: s.username };
  }

  #limit(ip) {
    const key = ip || 'unknown';
    const now = Date.now();
    for (const [k, v] of this.#attempts) if (now > v.resetAt) this.#attempts.delete(k); // 顺手清理过期的计数
    const bucket = this.#attempts.get(key) ?? { count: 0, resetAt: now + LOGIN_WINDOW_MS };
    bucket.count += 1;
    this.#attempts.set(key, bucket);
    if (bucket.count > LOGIN_MAX) throw new AppError('尝试次数过多，请一分钟后再试', 'RATE_LIMITED', { status: 429 });
  }

  /** 首次初始化: 创建管理员账号。已经初始化过则拒绝。 */
  setup({ username, password }) {
    if (!this.setupRequired) throw new AppError('面板已经初始化过了', 'CONFLICT');
    this.users.create(username, password);
    return { username: this.users.username };
  }

  /** 校验账号密码, 成功则建立会话并返回会话令牌。按来源地址限速。 */
  login(credentials, ip) {
    this.#limit(ip);
    const ok = this.users.verify(credentials?.username, credentials?.password);
    if (!ok) throw new AppError('面板账号或密码不正确', 'BAD_CREDENTIALS');
    return this.#issue(this.users.username);
  }

  /** 修改自己的密码: 需要旧密码。成功后其它浏览器上的登录态全部失效。 */
  changePassword(session, { oldPassword, newPassword }) {
    this.users.changePassword(session.username, oldPassword, newPassword);
    for (const [token, s] of this.#sessions) if (token !== session.token) this.#sessions.delete(token);
    // 密码参数已哈希存储后, 用新密码给当前浏览器换一个新会话 (旧会话令牌作废)
    const fresh = this.#issue(session.username);
    this.#sessions.delete(session.token);
    return fresh;
  }

  logout(session) {
    if (session) this.#sessions.delete(session.token);
  }

  #issue(username) {
    const token = randomBytes(32).toString('base64url');
    this.#sessions.set(token, { username, seen: Date.now() });
    return token;
  }

  cookie(token) {
    return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(this.#ttlMs / 1000)}`;
  }

  get clearCookie() {
    return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
  }

  /** 当前有多少个登录态 (测试和诊断用)。 */
  get sessionCount() {
    return this.#sessions.size;
  }
}

function cookieToken(header) {
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === SESSION_COOKIE) return decodeURIComponent(part.slice(i + 1).trim()).slice(0, 128);
  }
  return null;
}
