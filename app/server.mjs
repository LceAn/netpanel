#!/usr/bin/env node
// 交换机管理面板: 静态前端 + JSON API。
//
// 鉴权模型: 用交换机自己的账号密码登录本面板 → 面板用它登录交换机并保持会话。
// 密码只在内存里 (会话失效时自动重新登录用), 不落盘、不下发浏览器。
//
// 配置 (环境变量优先于 config.json, 都没有则用默认值):
//   SWITCH_URL   交换机地址            默认 http://10.0.0.239
//   PANEL_HOST   面板监听地址          默认 127.0.0.1 (要让局域网其它设备访问就设成 0.0.0.0)
//   PANEL_PORT   面板端口              默认 8208

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SwitchClient, SwitchError } from './lib/switch.mjs';
import { PAGES } from './lib/pages.mjs';
import { OPS, TID } from './lib/ops.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(ROOT, 'public');
const SESSION_COOKIE = 'sp_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const JSON_LIMIT = 64 * 1024;
const UPLOAD_LIMIT = 32 * 1024 * 1024;

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class HttpError extends Error {
  constructor(status, message, code = 'HTTP', details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// ── 配置 ──────────────────────────────────────────────────────────────

function loadConfig() {
  let file = {};
  const fileConfig = process.env.PANEL_CONFIG ?? resolve(ROOT, 'config.json');
  if (existsSync(fileConfig)) {
    try {
      file = JSON.parse(readFileSync(fileConfig, 'utf8'));
    } catch (err) {
      console.error(`config.json 解析失败: ${err.message}`);
      process.exit(1);
    }
  }
  const pick = (...values) => values.find((v) => v !== undefined && v !== '');
  return {
    switchUrl: pick(process.env.SWITCH_URL, file.switchUrl, 'http://10.0.0.239'),
    host: pick(process.env.PANEL_HOST, file.host, '127.0.0.1'),
    port: Number(pick(process.env.PANEL_PORT, file.port, 8208)),
  };
}

const config = loadConfig();
try {
  if (new URL(config.switchUrl).protocol !== 'http:') throw new Error('只支持 http://');
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('端口不合法');
} catch (err) {
  console.error(`配置不合法 (SWITCH_URL / PANEL_PORT): ${err.message}`);
  process.exit(1);
}

// ── 登录会话 (仅内存) ──────────────────────────────────────────────────

/** token → { token, client, username, password, seen } */
const sessions = new Map();

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()).slice(0, 128);
  }
  return out;
}

function getSession(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() - s.seen > SESSION_TTL_MS) {
    void destroySession(s);
    return null;
  }
  s.seen = Date.now();
  return s;
}

function destroySession(session) {
  sessions.delete(session.token);
  if (upgradeJob.state === 'running') return Promise.resolve(); // 固件写入期间不去打扰交换机
  return session.client.logout();
}

// 登录接口限速: 每个来源地址每分钟最多 10 次
const loginAttempts = new Map();
function rateLimitLogin(req) {
  const key = req.socket.remoteAddress ?? '?';
  const now = Date.now();
  const bucket = loginAttempts.get(key) ?? { count: 0, resetAt: now + 60_000 };
  if (now > bucket.resetAt) Object.assign(bucket, { count: 0, resetAt: now + 60_000 });
  bucket.count++;
  loginAttempts.set(key, bucket);
  if (bucket.count > 10) throw new HttpError(429, '尝试次数过多，请一分钟后再试', 'RATE_LIMITED');
}

// ── 请求 / 响应辅助 ────────────────────────────────────────────────────

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, '请求体过大', 'TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req, JSON_LIMIT);
  try {
    const obj = JSON.parse(raw.toString('utf8'));
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('not an object');
    return obj;
  } catch {
    throw new HttpError(400, '请求体不是合法的 JSON 对象', 'BAD_REQUEST');
  }
}

async function readUpload(req) {
  const raw = await readBody(req, UPLOAD_LIMIT);
  if (!/^multipart\/form-data;/i.test(String(req.headers['content-type'] ?? ''))) throw new HttpError(400, '需要 multipart/form-data', 'BAD_REQUEST');
  try {
    const form = await new Response(raw, { headers: { 'content-type': req.headers['content-type'] } }).formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') throw new Error('no file');
    return { name: file.name, data: Buffer.from(await file.arrayBuffer()) };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, '没有收到文件', 'BAD_REQUEST');
  }
}

// ── 业务: 写操作 ───────────────────────────────────────────────────────

/** 读上下文 → 校验 → 提交 → 回读。所有写操作都走这一条路。 */
async function runOp(session, name, params) {
  const def = Object.hasOwn(OPS, name) ? OPS[name] : null;
  if (!def) throw new HttpError(404, '未知操作', 'BAD_OP');
  const client = session.client;
  const ctx = def.ctxPage ? (await client.read(def.ctxPage)).data : undefined;
  const result = await client.submit(name, params, ctx);
  const fresh = {};
  if (!result.disconnected) {
    for (const key of def.refresh ?? []) fresh[key] = (await client.read(key)).data;
  }
  return {
    ok: true,
    tip: result.tip,
    disconnected: result.disconnected,
    data: def.resultModel ? def.resultModel(result.vars ?? {}) : undefined,
    fresh,
  };
}

async function readPages(client, keys) {
  const out = {};
  for (const key of keys) {
    if (!Object.hasOwn(PAGES, key)) throw new HttpError(404, `未知页面: ${key}`, 'BAD_PAGE');
    out[key] = (await client.read(key)).data;
  }
  return out;
}

// ── 业务: 备份 / 还原 ─────────────────────────────────────────────────

function backupFilename(model) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `${String(model ?? 'switch').replace(/[^\w.-]/g, '')}_${stamp}.cfg`;
}

async function backup(session, res) {
  const result = await session.client.sendRaw({ path: 'config_back.cgi', method: 'POST', send: 'multipart', fields: [['btnBackup', '配置备份'], ['token', TID]] });
  // 配置文件是二进制; 拿到 HTML 说明交换机返回的是出错提示页
  if (result.body.length === 0 || /^\s*</.test(result.body.subarray(0, 200).toString('latin1'))) {
    throw new HttpError(502, result.tip || '交换机没有返回配置文件', 'BAD_RESPONSE');
  }
  const model = await session.client.frame().then((f) => f.model, () => null);
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${backupFilename(model)}"`, 'Content-Length': result.body.length });
  res.end(result.body);
}

async function restore(session, upload) {
  const name = upload.name.replace(/[^\\/]*[\\/]+/g, ''); // 与原厂一致: 只取文件名
  if (!/\.cfg$/i.test(name)) throw new HttpError(400, '请选择 .cfg 格式的配置文件', 'BAD_PARAM');
  if (upload.data.length === 0) throw new HttpError(400, '配置文件是空的', 'BAD_PARAM');
  // 原厂表单: token 在查询串里, 请求体里只有文件
  const result = await session.client.sendRaw({
    path: 'conf_restore.cgi', method: 'POST', send: 'query', fields: [['token', TID]],
    file: { name: 'configfile', filename: name, data: upload.data },
  });
  return { ok: true, tip: result.tip, disconnected: result.disconnected };
}

// ── 业务: 固件 ─────────────────────────────────────────────────────────

const textOf = (result) => result.body.toString('utf8').trim();

const tinyPost = (client, path) => client.sendRaw({ path, method: 'POST', send: 'query', fields: [['token', TID]], contentType: 'application/x-www-form-urlencoded' });

/** 原厂 JS 取响应里 "value" 之后第 7 个字符当冲突标志 (1 = 已有升级在进行)。
 *  响应格式没法在不真正升级的前提下确认, 所以按 "value 之后出现的第一个 0/1" 来认。 */
function parseConflict(text) {
  const at = text.indexOf('value');
  const tail = (at >= 0 ? text.slice(at + 6) : text).slice(0, 16).replace(/^[^01]+/, '');
  return tail.startsWith('1');
}

async function checkFirmware(session) {
  await tinyPost(session.client, 'check_new_version_start.cgi');
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    const state = textOf(await tinyPost(session.client, 'check_new_version.cgi'));
    if (state !== '2') break; // 2 = 检查中
  }
  return (await session.client.read('firmware')).data;
}

/** 固件升级在后台跑, 前端轮询进度 (一次升级要几分钟)。 */
const upgradeJob = { state: 'idle', log: [], error: null };

function startUpgrade(session, kind, upload) {
  if (upgradeJob.state === 'running') throw new HttpError(409, '已有升级任务在进行中', 'BUSY');
  const client = session.client;
  const log = (line) => {
    upgradeJob.log.push(`${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${line}`);
    if (upgradeJob.log.length > 200) upgradeJob.log.shift();
  };
  Object.assign(upgradeJob, { state: 'running', log: [], error: null, kind });
  (async () => {
    try {
      if (parseConflict(textOf(await tinyPost(client, 'upgradeConflict.cgi')))) throw new SwitchError('设备中已有一个升级任务在进行', 'BUSY');
      if (kind === 'local') {
        log(`上传固件 ${upload.name} (${(upload.data.length / 1024 / 1024).toFixed(2)} MB)`);
        await client.sendRaw({
          path: '/httpupg.cgi', method: 'POST', send: 'query', fields: [['cmd', 'fw_upgrade'], ['token', TID]],
          file: { name: 'firmware', filename: upload.name, data: upload.data },
        });
      } else {
        log('开始在线升级');
        await tinyPost(client, 'upgrade_online.cgi');
      }
      log('交换机正在写入固件，请勿断电');
      for (let i = 0; i < 900; i++) {
        await sleep(1000);
        let state;
        try {
          state = textOf(await tinyPost(client, 'upgradeStatusCheck.cgi'));
        } catch {
          log('交换机正在重启');
          upgradeJob.state = 'rebooting';
          return; // 写完固件后交换机会自行重启并断开连接
        }
        if (state === '1') throw new SwitchError('交换机报告升级失败', 'UPGRADE_FAILED');
        if (state === '0') {
          upgradeJob.state = 'rebooting';
          return;
        }
      }
      throw new SwitchError('等待升级超时', 'TIMEOUT');
    } catch (err) {
      upgradeJob.state = 'failed';
      upgradeJob.error = err instanceof SwitchError || err instanceof HttpError ? err.message : '升级过程出错';
    }
  })();
  return { ok: true };
}

// ── 路由 ───────────────────────────────────────────────────────────────

async function handleApi(req, res, url) {
  const path = url.pathname;
  const method = req.method;

  // 写请求必须带自定义请求头且同源: 浏览器里的跨站表单发不出这种请求 (防 CSRF)
  if (method !== 'GET') {
    if (req.headers['x-requested-with'] !== 'switch-panel') throw new HttpError(403, '缺少防跨站校验', 'CSRF');
    const origin = req.headers.origin;
    let sameOrigin = true;
    try {
      sameOrigin = !origin || new URL(origin).host === req.headers.host;
    } catch {
      sameOrigin = false;
    }
    if (!sameOrigin) throw new HttpError(403, '跨站请求被拒绝', 'CSRF');
  }

  if (method === 'GET' && path === '/api/health') {
    return sendJson(res, 200, { ok: true, switchUrl: config.switchUrl });
  }

  if (method === 'GET' && path === '/api/status') {
    const session = getSession(req);
    return sendJson(res, 200, { switchUrl: config.switchUrl, authed: !!session, user: session?.username ?? null });
  }

  if (method === 'POST' && path === '/api/login') {
    const { username, password } = await readJson(req);
    if (typeof username !== 'string' || !/^[\x21-\x7e]{1,64}$/.test(username) || typeof password !== 'string' || password.length > 128 || /[^\x21-\x7e]/.test(password)) {
      throw new HttpError(400, '用户名或密码格式不正确', 'BAD_PARAM');
    }
    rateLimitLogin(req);
    const client = new SwitchClient({ baseUrl: config.switchUrl, username, password });
    await client.login();
    const previous = getSession(req);
    if (previous) void destroySession(previous); // 同一浏览器重复登录: 释放旧的交换机会话
    const token = randomBytes(32).toString('base64url');
    sessions.set(token, { token, client, username, password, seen: Date.now() });
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
    return sendJson(res, 200, { ok: true, user: username, frame: await client.frame().catch(() => null) });
  }

  if (method === 'POST' && path === '/api/logout') {
    const session = getSession(req);
    if (session) await destroySession(session);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    return sendJson(res, 200, { ok: true });
  }

  // ── 以下接口都需要登录 ──
  const session = getSession(req);
  if (!session) throw new HttpError(401, '未登录或登录已过期', 'UNAUTHENTICATED');
  const client = session.client;

  if (method === 'GET' && path === '/api/overview') {
    return sendJson(res, 200, await client.read('overview'));
  }
  if (method === 'GET' && path === '/api/pages') {
    const keys = String(url.searchParams.get('keys') ?? '').split(',').filter(Boolean).slice(0, 8);
    if (!keys.length) throw new HttpError(400, '缺少 keys 参数', 'BAD_PARAM');
    return sendJson(res, 200, await readPages(client, keys));
  }
  if (method === 'GET' && /^\/api\/stats\/\d{1,2}$/.test(path)) {
    return sendJson(res, 200, await client.readStats(Number(path.slice('/api/stats/'.length))));
  }
  if (method === 'GET' && path === '/api/ping') {
    return sendJson(res, 200, { online: await client.ping() });
  }
  if (method === 'GET' && path === '/api/backup') {
    return backup(session, res);
  }
  if (method === 'POST' && path === '/api/op') {
    const { op, params } = await readJson(req);
    if (typeof op !== 'string') throw new HttpError(400, '缺少 op', 'BAD_PARAM');
    return sendJson(res, 200, await runOp(session, op, params));
  }
  if (method === 'POST' && path === '/api/mac-search') {
    const body = await readJson(req);
    return sendJson(res, 200, await runOp(session, 'mac.search', body));
  }
  if (method === 'POST' && path === '/api/restore') {
    if (upgradeJob.state === 'running') throw new HttpError(409, '升级进行中，不能还原配置', 'BUSY');
    return sendJson(res, 200, await restore(session, await readUpload(req)));
  }
  if (method === 'POST' && path === '/api/firmware/check') {
    return sendJson(res, 200, await checkFirmware(session));
  }
  if (method === 'POST' && path === '/api/firmware/upgrade') {
    const upload = await readUpload(req);
    if (!/\.bin$/i.test(upload.name)) throw new HttpError(400, '固件文件应为 .bin 格式', 'BAD_PARAM');
    return sendJson(res, 200, startUpgrade(session, 'local', upload));
  }
  if (method === 'POST' && path === '/api/firmware/online') {
    return sendJson(res, 200, startUpgrade(session, 'online'));
  }
  if (method === 'GET' && path === '/api/firmware/job') {
    return sendJson(res, 200, { state: upgradeJob.state, log: upgradeJob.log, error: upgradeJob.error });
  }
  throw new HttpError(404, '接口不存在', 'NOT_FOUND');
}

async function serveStatic(res, path) {
  let rel;
  try {
    rel = path === '/' ? 'index.html' : decodeURIComponent(path).slice(1);
  } catch {
    throw new HttpError(404, 'Not Found');
  }
  const file = resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + sep)) throw new HttpError(404, 'Not Found');
  let data;
  try {
    data = await readFile(file);
  } catch {
    throw new HttpError(404, 'Not Found');
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': data.length, 'Cache-Control': 'no-cache' });
  res.end(data);
}

function respondError(res, err) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (err instanceof HttpError) {
    return sendJson(res, err.status, { error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) });
  }
  if (err instanceof SwitchError) {
    const status = { BAD_CREDENTIALS: 401, SESSION: 401, BAD_PARAM: 400, BAD_RESPONSE: 502, OFFLINE: 502, TIMEOUT: 504, LOGIN_FAILED: 503, UNCERTAIN: 502 }[err.code] ?? 500;
    return sendJson(res, status, { error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) });
  }
  console.error('[panel]', err);
  sendJson(res, 500, { error: '面板内部错误', code: 'INTERNAL' });
}

const server = createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  try {
    const url = new URL(req.url, 'http://panel');
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method Not Allowed');
      await serveStatic(res, url.pathname);
    }
  } catch (err) {
    respondError(res, err);
  }
});

server.keepAliveTimeout = 5000;

// 过期会话回收: 顺便在交换机上退出, 不占它的 16 个登录名额
const sweeper = setInterval(() => {
  for (const s of sessions.values()) if (Date.now() - s.seen > SESSION_TTL_MS) void destroySession(s);
}, 10 * 60 * 1000);
sweeper.unref();

server.listen(config.port, config.host, () => {
  console.log(`交换机面板已启动: http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${config.port}   (交换机 ${config.switchUrl})`);
});

server.on('error', (err) => {
  console.error(`监听 ${config.host}:${config.port} 失败: ${err.message}`);
  process.exit(1);
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await Promise.allSettled([...sessions.values()].map((s) => destroySession(s)));
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
