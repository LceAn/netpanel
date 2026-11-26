// 面板的 HTTP 服务: 静态前端 + JSON 接口 + 指标接口。
// openPanel() 负责打开数据目录、组装各部件 (不监听端口, 命令行也用它);
// createPanel() 只组装 HTTP 服务; main() 把两者接起来并启动后台轮询。

import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError, HttpError, normalizeError } from '../core/errors.mjs';
import { AdapterRegistry } from '../core/adapter.mjs';
import { loadConfig } from '../core/config.mjs';
import { FirmwareManager } from '../core/device-service.mjs';
import { DeviceManager } from '../core/manager.mjs';
import { renderMetrics } from '../core/metrics.mjs';
import { openDeviceStore } from '../core/store/devices.mjs';
import { openSettings } from '../core/store/settings.mjs';
import { openUserStore } from '../core/store/users.mjs';
import { openVault } from '../core/store/vault.mjs';
import { registerAdapters } from '../adapters/index.mjs';
import { PanelAuth } from './auth.mjs';
import { Router } from './router.mjs';
import { registerRoutes, VERSION } from './routes.mjs';
import { SECURITY_HEADERS, assertSameOrigin, serveStatic, sendJson } from './util.mjs';

/** 前端静态文件目录 (<app>/web)。 */
export const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');

/** 不需要登录就能访问的接口。 */
const PUBLIC_API = new Set(['GET /api/status', 'POST /api/setup', 'POST /api/login', 'POST /api/logout']);

/**
 * 打开面板的全部部件: 读配置 → 打开 (必要时创建) 数据目录 → 适配器、设备表、设置、账号、设备管理器。
 * 不监听端口, 也不启动后台轮询 —— Web 服务和命令行共用这一段。
 */
export function openPanel({ appRoot, env = process.env, log = () => {} } = {}) {
  const config = loadConfig(appRoot, env);
  const vault = openVault(join(config.dataDir, 'secret.key'));
  const settings = openSettings(join(config.dataDir, 'settings.json'));
  const adapters = new AdapterRegistry();
  registerAdapters(adapters);
  const store = openDeviceStore(join(config.dataDir, 'devices.json'), vault, { adapterExists: (id) => adapters.has(id) });
  const manager = new DeviceManager({ store, adapters, settings, log });
  const firmware = new FirmwareManager();
  manager.on('removed', (id) => firmware.forget(id));
  const auth = new PanelAuth({ users: openUserStore(join(config.dataDir, 'auth.json')) });
  return {
    config,
    vault,
    settings,
    adapters,
    store,
    manager,
    firmware,
    auth,
    /** 释放各设备上的会话 (后台轮询没启动时什么也不用做)。 */
    close: () => manager.stop(),
  };
}

export function createPanel({ manager, auth, settings, firmware, staticDir = WEB_DIR, log = console.log }) {
  const router = new Router();
  registerRoutes(router, { manager, auth, settings, firmware });

  const server = createServer(async (req, res) => {
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(key, value);
    const url = new URL(req.url, 'http://panel');
    try {
      if (url.pathname === '/metrics') return await serveMetrics(req, res, manager, settings);
      if (url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET') assertSameOrigin(req); // 会改动状态的请求必须同源并带自定义请求头
        const session = auth.sessionFrom(req);
        const route = router.find(req.method, url.pathname);
        if (!route) throw new HttpError(router.exists(url.pathname) ? 405 : 404, router.exists(url.pathname) ? '不支持的请求方法' : '接口不存在', router.exists(url.pathname) ? 'METHOD' : 'NOT_FOUND');
        if (!PUBLIC_API.has(`${req.method} ${url.pathname}`) && !session) throw new HttpError(401, '未登录或登录已过期', 'UNAUTHENTICATED');
        const result = await route.handler({ req, res, params: route.params, query: url.searchParams, session, log });
        // 处理函数返回 null 表示它已经自己写完了响应 (例如下载文件)
        if (!res.headersSent) sendJson(res, 200, result ?? { ok: true });
      } else {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method Not Allowed');
        await serveStatic(res, staticDir, url.pathname);
      }
    } catch (err) {
      respondError(res, err, log);
    }
  });

  return {
    server,
    router,
    listen: ({ host, port }) => new Promise((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolveListen(server.address());
      });
    }),
    close: () => new Promise((resolveClose) => {
      server.close(() => resolveClose());
      server.closeAllConnections?.(); // 别让空闲的长连接拖住关闭过程
    }),
  };
}

/** GET /metrics —— Prometheus 文本格式。验证方式是 Bearer 令牌 (在设置页查看或重置), 与面板登录无关。 */
async function serveMetrics(req, res, manager, settings) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method Not Allowed');
  const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? '';
  if (!settings.verifyMetricsToken(token)) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="netpanel"');
    throw new HttpError(401, '需要有效的指标访问令牌 (设置页 → 指标访问令牌)', 'UNAUTHENTICATED');
  }
  const body = renderMetrics(manager.metricsSnapshot(), { version: VERSION });
  res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function respondError(res, err, log) {
  const e = normalizeError(err);
  if (e.internal) log('[panel] 内部错误:', err);
  if (res.headersSent) {
    res.destroy();
    return;
  }
  sendJson(res, e.status, { error: e.message, code: e.code, ...(e.details ? { details: e.details } : {}) });
}

/** 启动整个面板 (Web 服务 + 后台轮询)。返回各部件, 便于测试和嵌入。 */
export async function main({ appRoot, env = process.env } = {}) {
  const log = (...args) => console.log(new Date().toLocaleString('zh-CN', { hour12: false }), ...args);
  const parts = openPanel({ appRoot, env, log });
  const { config, manager, auth, settings, firmware, store } = parts;

  const panel = createPanel({ manager, auth, settings, firmware, log });
  await manager.start();
  try {
    await panel.listen({ host: config.host, port: config.port });
  } catch (err) {
    await manager.stop();
    throw err;
  }

  const shown = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
  log(`NetPanel 已启动: http://${shown}:${config.port}`);
  log(`  数据目录: ${config.dataDir}`);
  if (auth.setupRequired) log('  首次运行: 打开上面的地址创建管理员账号, 然后在「设备管理」里添加交换机。');
  else log(`  已绑定 ${store.list().length} 台设备。`);
  if (env.SWITCH_URL) log('  提示: 环境变量 SWITCH_URL 已经不再使用, 设备请在界面的「设备管理」里添加。');

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await parts.close(); // 释放各设备上的会话
    await panel.close();
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

  return { ...parts, panel, shutdown };
}
