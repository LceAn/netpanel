// 适配器: 把"某一类设备的协议"封装在一个对象里, 上层 (设备管理器 / HTTP / 命令行 / 指标) 只通过这里约定的接口访问设备。
//
// ── 适配器对象 (由 defineAdapter 校验并冻结) ──────────────────────────────────────────────────────────
//   id         'tplink-rpm' 这样的稳定标识
//   vendor     厂商
//   name       给人看的名字
//   maturity   'verified'    已在真机上核对过
//              'experimental' 按公开资料实现, 没有在真机上验证过 (界面会显示提示)
//   reads      能产出哪些规范模型 (core/models.mjs 的键)
//   writes     能执行哪些规范操作 (core/ops.mjs 的键)
//   features   额外能力: 'statsDetail' | 'backup' | 'restore' | 'firmwareLocal' | 'firmwareOnline' | 'reboot' | 'reset'
//   probe({ url })                      → Promise<boolean>   不带凭据, 只看地址上是不是这类设备
//   create({ url, credentials, options }) → Promise<connection>
//
// ── connection (由适配器的 create 返回) ───────────────────────────────────────────────────────────────
//   read(key)                  → { data, tip }              规范模型
//   readStats(port)            → 单端口报文明细             (feature 'statsDetail')
//   submit(op, params, ctx)    → { tip, data?, disconnected, vars? }
//   ping()                     → boolean                    设备是否在线 (单次尝试)
//   identify()                 → { model, firmware, hardware?, ports? }
//   logout()                   → 释放设备上的会话
//   backup()                   → { body, filename }         (feature 'backup')
//   restore(file)              → { tip, disconnected }      (feature 'restore')
//   firmware.{ check, conflict, upgradeLocal, upgradeOnline, status }   (feature 'firmware*')

import { MODEL_KEYS } from './models.mjs';
import { AppError } from './errors.mjs';

export const FEATURES = ['statsDetail', 'backup', 'restore', 'firmwareLocal', 'firmwareOnline', 'firmwareCheck', 'reboot', 'reset'];
const MATURITY = ['verified', 'experimental'];

/** 校验适配器声明的结构, 并冻结, 防止运行期被改动。 */
export function defineAdapter(def) {
  const fail = (msg) => { throw new AppError(`适配器声明不合法: ${msg}`, 'BAD_ADAPTER', { status: 500 }); };
  if (!/^[a-z0-9][a-z0-9-]*$/.test(def.id ?? '')) fail('id 只能是小写字母、数字、连字符');
  if (typeof def.vendor !== 'string' || typeof def.name !== 'string') fail('缺少 vendor / name');
  if (!MATURITY.includes(def.maturity)) fail('maturity 必须是 ' + MATURITY.join(' | '));
  for (const key of ['reads', 'writes', 'features']) {
    if (!Array.isArray(def[key]) || def[key].some((x) => typeof x !== 'string')) fail(`${key} 必须是字符串数组`);
  }
  for (const key of def.reads) if (!MODEL_KEYS.includes(key)) fail(`reads 里有未知的模型键: ${key}`);
  for (const key of def.features) if (!FEATURES.includes(key)) fail(`features 里有未知的能力: ${key}`);
  for (const key of ['probe', 'create']) if (typeof def[key] !== 'function') fail(`缺少 ${key}()`);
  return Object.freeze({
    ...def,
    reads: Object.freeze([...new Set(def.reads)]),
    writes: Object.freeze([...new Set(def.writes)]),
    features: Object.freeze([...new Set(def.features)]),
  });
}

export class AdapterRegistry {
  #adapters = new Map();

  register(adapter) {
    // 经过 defineAdapter 的对象其 reads 已被冻结; 没经过的在这里补做校验
    const def = adapter && Object.isFrozen(adapter.reads) ? adapter : defineAdapter(adapter);
    if (this.#adapters.has(def.id)) throw new AppError(`适配器重复注册: ${def.id}`, 'BAD_ADAPTER', { status: 500 });
    this.#adapters.set(def.id, def);
    return def;
  }

  has(id) {
    return this.#adapters.has(id);
  }

  /** 按 id 取适配器; 没有就抛 NOT_FOUND (不会命中原型链上的名字)。 */
  get(id) {
    const adapter = typeof id === 'string' ? this.#adapters.get(id) : undefined;
    if (!adapter) throw new AppError(`不支持的适配器: ${String(id).slice(0, 40)}`, 'NOT_FOUND');
    return adapter;
  }

  list() {
    return [...this.#adapters.values()];
  }

  /** 不带凭据识别: 逐个问适配器"这个地址上是不是你的设备"。都不认得返回 null。 */
  async detect(url) {
    for (const adapter of this.#adapters.values()) {
      try {
        if (await adapter.probe({ url })) return adapter;
      } catch {
        // 这个适配器认不出, 换下一个
      }
    }
    return null;
  }
}
