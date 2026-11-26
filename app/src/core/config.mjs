// 面板自身的配置 (监听地址、端口、数据目录)。与具体设备无关——设备在界面里添加, 保存在数据目录里。
//
// 环境变量优先, 其次是 app/config.json, 都没有就用默认值:
//   PANEL_HOST       监听地址      默认 127.0.0.1 (只允许本机访问; 要让局域网访问就设成 0.0.0.0)
//   PANEL_PORT       端口          默认 8208
//   PANEL_DATA_DIR   数据目录      默认 <app>/data (设备表、密钥、面板账号、设置都在这里)
//   PANEL_CONFIG     配置文件路径  默认 <app>/config.json

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from './errors.mjs';

/** 应用根目录 (package.json 所在的目录)。本文件在 <app>/src/core/ 下, 所以往上两层。 */
export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function loadConfig(appRoot = APP_ROOT, env = process.env) {
  const fileConfig = env.PANEL_CONFIG ?? resolve(appRoot, 'config.json');
  let file = {};
  if (existsSync(fileConfig)) {
    try {
      file = JSON.parse(readFileSync(fileConfig, 'utf8'));
    } catch (err) {
      throw new AppError(`config.json 解析失败：${err.message}`, 'CONFIG', { cause: err, status: 500 });
    }
  }
  if (!file || typeof file !== 'object' || Array.isArray(file)) throw new AppError('config.json 应是一个 JSON 对象', 'CONFIG', { status: 500 });

  const pick = (...values) => values.find((v) => v !== undefined && v !== '');
  const config = {
    host: pick(env.PANEL_HOST, file.host, '127.0.0.1'),
    port: Number(pick(env.PANEL_PORT, file.port, 8208)),
    dataDir: resolve(appRoot, pick(env.PANEL_DATA_DIR, file.dataDir, 'data')),
    configPath: fileConfig,
  };
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new AppError('端口不合法 (PANEL_PORT 应为 1-65535)', 'CONFIG', { status: 500 });
  if (typeof config.host !== 'string' || !config.host) throw new AppError('监听地址不合法 (PANEL_HOST)', 'CONFIG', { status: 500 });
  return config;
}
