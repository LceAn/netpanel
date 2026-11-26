// 设备服务: 面向"一条设备连接"的业务流程。HTTP 接口和命令行都调用这里, 不各自实现一遍。

import { OPS, validateOp } from './ops.mjs';
import { MODELS } from './models.mjs';
import { AppError, SwitchError } from './errors.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 能力检查 ──────────────────────────────────────────────────────────

export function requireRead(adapter, key) {
  if (!adapter.reads.includes(key)) throw new AppError(`这台设备不支持读取「${MODELS[key]?.title ?? key}」`, 'UNSUPPORTED');
}

export function requireWrite(adapter, op) {
  if (!adapter.writes.includes(op)) throw new AppError(`这台设备不支持操作「${OPS[op]?.title ?? op}」`, 'UNSUPPORTED');
}

export function requireFeature(adapter, feature) {
  if (!adapter.features.includes(feature)) throw new AppError('这台设备不支持该功能', 'UNSUPPORTED');
}

// ── 读 ────────────────────────────────────────────────────────────────

/** 依次读取若干个规范模型, 返回 { 模型键: 数据 }。 */
export async function readPages(connection, adapter, keys) {
  if (!Array.isArray(keys) || keys.length === 0) throw new AppError('缺少要读取的页面', 'BAD_PARAM');
  if (keys.length > 8) throw new AppError('一次最多读取 8 个页面', 'BAD_PARAM');
  const out = {};
  for (const key of keys) {
    requireRead(adapter, key);
    out[key] = (await connection.read(key)).data;
  }
  return out;
}

// ── 写 ────────────────────────────────────────────────────────────────

/**
 * 执行一个规范写操作: 能力检查 → 读校验上下文 → 校验参数 → 交给适配器提交 → 回读受影响的页面。
 * @returns {Promise<{ok: true, tip: string, disconnected: boolean, data?: object, fresh: object}>}
 */
export async function runOp(connection, adapter, name, params) {
  const def = typeof name === 'string' && Object.hasOwn(OPS, name) ? OPS[name] : null;
  if (!def) throw new AppError(`未知操作：${String(name).slice(0, 40)}`, 'NOT_FOUND');
  requireWrite(adapter, name);

  const ctx = def.ctxPage ? (await connection.read(def.ctxPage)).data : undefined;
  const errors = validateOp(name, params, ctx);
  if (errors.length) throw new AppError(errors.join('；'), 'BAD_PARAM', { details: errors });

  const result = await connection.submit(name, params, ctx);
  const fresh = {};
  if (!result.disconnected) {
    for (const key of def.refresh ?? []) fresh[key] = (await connection.read(key)).data;
  }
  return { ok: true, tip: result.tip || '', disconnected: !!result.disconnected, data: result.data, fresh };
}

// ── 备份 / 还原 / 固件检查 ────────────────────────────────────────────

export async function backup(connection, adapter) {
  requireFeature(adapter, 'backup');
  return connection.backup();
}

export async function restore(connection, adapter, file) {
  requireFeature(adapter, 'restore');
  return connection.restore(file);
}

export async function checkFirmware(connection, adapter) {
  requireFeature(adapter, 'firmwareCheck');
  return connection.firmware.check();
}

// ── 固件升级任务 ──────────────────────────────────────────────────────

/**
 * 固件升级要跑几分钟, 所以按设备各起一个后台任务, 前端轮询进度。
 * 状态: idle → running → rebooting (设备写完固件自行重启) → done (设备重新上线) | failed
 */
export class FirmwareManager {
  #jobs = new Map(); // 设备 id → 任务

  status(id) {
    const job = this.#jobs.get(id);
    return job ? { state: job.state, log: [...job.log], error: job.error, kind: job.kind, startedAt: job.startedAt } : { state: 'idle', log: [], error: null };
  }

  /** 设备被移除后忘掉它的任务。 */
  forget(id) {
    this.#jobs.delete(id);
  }

  /** 设备重新上线后由界面调用: 把"设备重启中"标记为"升级完成", 以后打开页面不必再等它重启。 */
  settle(id) {
    const job = this.#jobs.get(id);
    if (job?.state === 'rebooting') job.state = 'done';
    return this.status(id);
  }

  /** 把 rebooting / failed 状态复位成 idle (用户在界面上点了"知道了")。 */
  clear(id) {
    const job = this.#jobs.get(id);
    if (job && job.state !== 'running') this.#jobs.delete(id);
  }

  /**
   * @param {'local'|'online'} kind
   * @param {{ name: string, data: Buffer }} file  本地升级时的固件文件
   */
  start(id, connection, adapter, kind, file) {
    if (kind !== 'local' && kind !== 'online') throw new AppError('未知的升级方式', 'BAD_PARAM');
    requireFeature(adapter, kind === 'local' ? 'firmwareLocal' : 'firmwareOnline');
    if (kind === 'local' && (!file || !file.data?.length)) throw new AppError('没有收到固件文件', 'BAD_PARAM');
    if (this.#jobs.get(id)?.state === 'running') throw new AppError('这台设备已有一个升级任务在进行中', 'BUSY');

    const job = { state: 'running', log: [], error: null, kind, startedAt: Date.now() };
    this.#jobs.set(id, job);
    const log = (line) => {
      job.log.push(`${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${line}`);
      if (job.log.length > 200) job.log.shift();
    };

    (async () => {
      try {
        if (adapter.features.includes('firmwareCheck') && (await connection.firmware.conflict())) {
          throw new SwitchError('设备中已有一个升级任务在进行', 'BUSY');
        }
        if (kind === 'local') {
          log(`上传固件 ${file.name} (${(file.data.length / 1024 / 1024).toFixed(2)} MB)`);
          await connection.firmware.upgradeLocal(file);
        } else {
          log('开始在线升级');
          await connection.firmware.upgradeOnline();
        }
        log('设备正在写入固件，请勿断电');
        for (let i = 0; i < 900; i++) {
          await sleep(1000);
          let state;
          try {
            state = await connection.firmware.status();
          } catch {
            log('设备正在重启');
            job.state = 'rebooting'; // 写完固件后设备会自行重启并断开连接
            return;
          }
          if (state === 'failed') throw new SwitchError('设备报告升级失败', 'UPGRADE_FAILED');
          if (state === 'done') {
            job.state = 'rebooting';
            return;
          }
        }
        throw new SwitchError('等待升级超时', 'TIMEOUT');
      } catch (err) {
        job.state = 'failed';
        job.error = err instanceof AppError ? err.message : '升级过程出错';
      }
    })();
    return this.status(id);
  }
}
