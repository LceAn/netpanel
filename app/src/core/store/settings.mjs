// 面板设置 (轮询间隔、指标令牌等)。保存在 data/settings.json。

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError } from '../errors.mjs';
import { trackJson } from './json-file.mjs';

export const DEFAULT_SETTINGS = Object.freeze({
  /** 默认的设备轮询间隔 (秒)。每台设备可以单独覆盖。 */
  pollIntervalSec: 15,
  /** 默认的端口统计轮询间隔 (秒), 供指标导出和总览页使用。 */
  statsIntervalSec: 30,
  /** Prometheus 指标接口的访问令牌; 首次需要时生成。 */
  metricsToken: null,
});

const LIMITS = {
  pollIntervalSec: [5, 3600, '默认轮询间隔'],
  statsIntervalSec: [10, 3600, '统计轮询间隔'],
};

export function openSettings(file) {
  // 文件只存用户改过的字段; 没写的用默认值。命令行 (switchctl token) 会在面板运行期间改这个文件, 所以每次都先核对文件
  const store = trackJson(file, {});
  const read = () => ({ ...DEFAULT_SETTINGS, ...store.read() });
  const write = (data) => store.write(Object.fromEntries(Object.entries(data).filter(([k]) => k in DEFAULT_SETTINGS)));

  return {
    file,
    get: read,

    /** 合并修改; 只接受已知字段。返回修改后的完整设置。 */
    set(patch) {
      const next = read();
      for (const [key, value] of Object.entries(patch ?? {})) {
        if (!(key in DEFAULT_SETTINGS) || key === 'metricsToken') continue;
        const [min, max, label] = LIMITS[key];
        if (!Number.isInteger(value) || value < min || value > max) throw new AppError(`${label}取值范围为 ${min}-${max} 秒`, 'BAD_PARAM');
        next[key] = value;
      }
      write(next);
      return read();
    },

    /** 取指标令牌, 没有就生成一个。 */
    ensureMetricsToken() {
      const data = read();
      if (typeof data.metricsToken === 'string' && data.metricsToken.length >= 32) return data.metricsToken;
      data.metricsToken = randomBytes(24).toString('base64url');
      write(data);
      return data.metricsToken;
    },

    /** 校验指标令牌。比较用常量时间, 不因为前缀相同就提前返回; 没有令牌时一律不通过。 */
    verifyMetricsToken(token) {
      const saved = read().metricsToken;
      if (typeof saved !== 'string' || saved.length < 32 || typeof token !== 'string' || !token) return false;
      const a = Buffer.from(saved);
      const b = Buffer.from(token);
      return a.length === b.length && timingSafeEqual(a, b);
    },

    /** 重新生成指标令牌 (旧令牌立即失效)。 */
    rotateMetricsToken() {
      const data = read();
      data.metricsToken = randomBytes(24).toString('base64url');
      write(data);
      return data.metricsToken;
    },
  };
}
