// 面板的全部 HTTP 接口。
//
// 处理函数收到一个 ctx: { req, res, params, query, session, log }, 返回的值会以 JSON 发出 (状态码 200)。
// 需要特殊响应 (下载文件) 的接口直接操作 res。
//
// 接口分三组:
//   面板本身   /api/status  /api/setup  /api/login  /api/logout  /api/password  /api/settings
//   设备管理   /api/devices  /api/dashboard  /api/probe
//   访问设备   /api/devices/:id/...   —— 全部针对某一台已绑定的设备

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ID_RE } from '../core/store/devices.mjs';
import { AppError, HttpError } from '../core/errors.mjs';
import { readJson, readUpload } from './util.mjs';

/** 面板版本 (package.json 里的 version)。 */
export const VERSION = (() => {
  try {
    const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
    return existsSync(pkg) ? JSON.parse(readFileSync(pkg, 'utf8')).version ?? 'unknown' : 'unknown';
  } catch {
    return 'unknown';
  }
})();

const deviceOnly = (id) => {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new HttpError(404, '设备不存在', 'NOT_FOUND');
  return id;
};

export function registerRoutes(router, { manager, auth, settings, firmware }) {
  const ok = (extra = {}) => ({ ok: true, ...extra });

  // ── 面板本身 ────────────────────────────────────────────────────────

  router.get('/api/status', (ctx) => ({
    // 不需要登录。只回答"要不要初始化、登没登录", 不泄露任何设备信息。
    setupRequired: auth.setupRequired,
    authed: !!ctx.session,
    user: ctx.session?.username ?? null,
  }));

  router.post('/api/setup', async (ctx) => {
    const body = await readJson(ctx.req);
    auth.setup(body);
    const token = auth.login(body, ctx.req.socket.remoteAddress); // 初始化后直接登录
    ctx.res.setHeader('Set-Cookie', auth.cookie(token));
    return ok({ user: auth.users.username });
  });

  router.post('/api/login', async (ctx) => {
    const body = await readJson(ctx.req);
    const token = auth.login(body, ctx.req.socket.remoteAddress);
    ctx.res.setHeader('Set-Cookie', auth.cookie(token));
    return ok({ user: auth.users.username });
  });

  router.post('/api/logout', (ctx) => {
    auth.logout(ctx.session);
    ctx.res.setHeader('Set-Cookie', auth.clearCookie);
    return ok();
  });

  router.post('/api/password', async (ctx) => {
    const body = await readJson(ctx.req);
    const token = auth.changePassword(ctx.session, body);
    ctx.res.setHeader('Set-Cookie', auth.cookie(token));
    return ok();
  });

  // 指标访问令牌不随设置一起下发, 只能通过 /api/settings/metrics-token 取 (见下)
  const publicSettings = () => {
    const { metricsToken, ...rest } = settings.get();
    return rest;
  };

  router.get('/api/settings', () => ({ settings: publicSettings() }));

  router.post('/api/settings', async (ctx) => {
    settings.set(await readJson(ctx.req));
    return ok({ settings: publicSettings() });
  });

  router.get('/api/settings/metrics-token', () => ok({ metricsToken: settings.ensureMetricsToken() }));

  router.post('/api/settings/metrics-token', () => ok({ metricsToken: settings.rotateMetricsToken() }));

  /** 已注册的适配器 (添加设备时可选的"适配器"下拉框)。 */
  router.get('/api/adapters', () => ({
    adapters: manager.adapters.list().map((a) => ({ id: a.id, name: a.name, vendor: a.vendor, maturity: a.maturity })),
  }));

  router.get('/api/about', () => ({ version: VERSION, node: process.version, adapters: manager.adapters.list().length }));

  // ── 设备管理 ────────────────────────────────────────────────────────

  router.get('/api/devices', () => ({ devices: manager.list() }));

  router.get('/api/dashboard', () => manager.dashboard());

  router.post('/api/probe', async (ctx) => manager.probe(await readJson(ctx.req)));

  // 注意顺序无关: "/api/devices/test" 是三段, "/api/devices/:id" 要求 id 形如 d_xxxxxxxxxx
  router.post('/api/devices/test', async (ctx) => manager.test(await readJson(ctx.req)));

  router.post('/api/devices', async (ctx) => manager.add(await readJson(ctx.req)));

  router.get('/api/devices/:id', (ctx) => manager.describe(deviceOnly(ctx.params.id)));

  router.patch('/api/devices/:id', async (ctx) => manager.update(deviceOnly(ctx.params.id), await readJson(ctx.req)));

  router.delete('/api/devices/:id', async (ctx) => {
    await manager.remove(deviceOnly(ctx.params.id));
    return ok();
  });

  router.post('/api/devices/:id/test', async (ctx) => {
    const id = deviceOnly(ctx.params.id);
    // 默认用已保存的地址和账号密码重新识别; 也可以在请求体里给新的值来试 (不影响已保存的记录)
    const body = await readJson(ctx.req);
    const rec = manager.store.get(id);
    return manager.test({
      url: body.url ?? rec.url,
      adapter: body.adapter ?? rec.adapter,
      username: body.username ?? rec.username,
      password: body.password ?? manager.store.credentials(id).password,
    });
  });

  router.post('/api/devices/:id/refresh', (ctx) => manager.refresh(deviceOnly(ctx.params.id)));

  router.get('/api/devices/:id/history', (ctx) => ({ history: manager.history(deviceOnly(ctx.params.id)) }));

  // ── 访问设备 ────────────────────────────────────────────────────────

  router.get('/api/devices/:id/overview', async (ctx) => {
    const id = deviceOnly(ctx.params.id);
    const live = ctx.query.get('live') === '1';
    const result = await manager.read(id, 'overview', { live });
    return { ...result, health: manager.describe(id).health };
  });

  router.get('/api/devices/:id/pages', async (ctx) => {
    const id = deviceOnly(ctx.params.id);
    const keys = String(ctx.query.get('keys') ?? '').split(',').filter(Boolean);
    return manager.readPages(id, keys);
  });

  router.get('/api/devices/:id/stats/:port', async (ctx) => {
    const id = deviceOnly(ctx.params.id);
    const port = Number(ctx.params.port);
    if (!Number.isInteger(port) || port < 1 || port > 256) throw new HttpError(400, '端口不合法', 'BAD_PARAM');
    return manager.readStats(id, port);
  });

  router.get('/api/devices/:id/ping', async (ctx) => ({ online: await manager.ping(deviceOnly(ctx.params.id)) }));

  router.get('/api/devices/:id/backup', async (ctx) => {
    const file = await manager.backup(deviceOnly(ctx.params.id));
    ctx.res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${file.filename}"`, 'Content-Length': file.body.length });
    ctx.res.end(file.body);
    return null; // 已直接写出响应
  });

  router.post('/api/devices/:id/op', async (ctx) => {
    const body = await readJson(ctx.req);
    return manager.submit(deviceOnly(ctx.params.id), body.op, body.params);
  });

  router.post('/api/devices/:id/mac-search', async (ctx) => {
    const body = await readJson(ctx.req);
    return manager.submit(deviceOnly(ctx.params.id), 'mac.search', body);
  });

  router.post('/api/devices/:id/restore', async (ctx) => {
    const id = deviceOnly(ctx.params.id);
    if (firmware.status(id).state === 'running') throw new AppError('这台设备正在升级固件，不能还原配置', 'BUSY');
    return manager.restore(id, await readUpload(ctx.req));
  });

  router.post('/api/devices/:id/firmware/check', (ctx) => manager.checkFirmware(deviceOnly(ctx.params.id)));

  router.post('/api/devices/:id/firmware/upgrade', async (ctx) => {
    const id = deviceOnly(ctx.params.id);
    const file = await readUpload(ctx.req);
    if (!/\.bin$/i.test(file.name)) throw new AppError('固件文件应为 .bin 格式', 'BAD_PARAM');
    return firmware.start(id, await manager.connectionFor(id), manager.adapters.get(manager.store.get(id).adapter), 'local', file);
  });

  router.post('/api/devices/:id/firmware/online', async (ctx) => {
    const id = deviceOnly(ctx.params.id);
    return firmware.start(id, await manager.connectionFor(id), manager.adapters.get(manager.store.get(id).adapter), 'online');
  });

  router.get('/api/devices/:id/firmware/job', (ctx) => firmware.status(deviceOnly(ctx.params.id)));

  router.post('/api/devices/:id/firmware/job/settle', (ctx) => firmware.settle(deviceOnly(ctx.params.id)));

  router.post('/api/devices/:id/firmware/job/clear', (ctx) => {
    firmware.clear(deviceOnly(ctx.params.id));
    return ok();
  });
}
