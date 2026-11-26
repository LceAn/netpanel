// 设备管理器: 面板里所有设备的运行时。HTTP 接口、指标导出、命令行都通过它访问设备。
//
// 职责:
//  - 为每台设备维持一个常驻连接 (密码从保险箱解密后只在内存里使用);
//  - 在后台轮询每台设备并缓存结果 —— 界面和指标读缓存, 不再由每个浏览器标签页各自去打设备;
//  - 维护每台设备的健康状态 (在线 / 离线 / 凭据失效 / 出错 / 已停用) 和流量历史;
//  - 添加 / 修改 / 删除设备时负责识别设备, 并同步调整连接和轮询。
//
// 单台设备出任何问题都只影响它自己的状态, 不会影响面板的登录态或其它设备。

import { EventEmitter } from 'node:events';
import { AppError } from './errors.mjs';
import { backup as backupDevice, checkFirmware as checkDeviceFirmware, requireFeature, requireRead, readPages, restore as restoreDevice, runOp } from './device-service.mjs';
import { normalizeUrl } from './store/devices.mjs';

export const HEALTH = Object.freeze({
  DISABLED: 'disabled', // 用户停用了轮询
  UNKNOWN: 'unknown', // 还没有轮询过
  ONLINE: 'online',
  OFFLINE: 'offline',
  AUTH: 'auth', // 账号密码不对, 或设备拒绝登录
  ERROR: 'error',
});

/** 把设备的报错归类成健康状态。 */
export function healthOf(err) {
  const code = err?.code;
  if (code === 'BAD_CREDENTIALS' || code === 'LOGIN_FAILED' || code === 'SESSION') return HEALTH.AUTH;
  if (code === 'OFFLINE' || code === 'TIMEOUT') return HEALTH.OFFLINE;
  return HEALTH.ERROR;
}

const sum = (ports, key) => (ports ?? []).reduce((n, p) => n + (Number(p[key]) || 0), 0);

/**
 * 设备侧的错误不用 HTTP 401。401 是"面板登录态失效"的状态码, 前端一看到就会回到面板登录页 ——
 * 而设备账号密码不对只该让这一台设备显示"凭据失效", 不能把人踢出面板。
 */
function deviceError(err) {
  if (err instanceof AppError && err.status === 401) return new AppError(err.message, err.code, { cause: err, status: 502, details: err.details });
  return err;
}

export class DeviceManager extends EventEmitter {
  /** @type {Map<string, object>} 设备 id → 运行时状态 */
  #rt = new Map();
  #stopped = true;
  #active = 0;
  #queue = [];

  /**
   * @param {{ store: object, adapters: object, settings: object, concurrency?: number, historySize?: number, log?: Function }} opts
   */
  constructor({ store, adapters, settings, concurrency = 3, historySize = 240, log = () => {} }) {
    super();
    this.store = store;
    this.adapters = adapters;
    this.settings = settings;
    this.concurrency = concurrency; // 同时轮询的设备数上限: 设备多了以后别把面板主机和接入交换机压垮
    this.historySize = historySize;
    this.log = log;
  }

  // ── 运行时状态 ──────────────────────────────────────────────────────

  #rtFor(id) {
    let rt = this.#rt.get(id);
    if (!rt) {
      const rec = this.store.get(id); // 不存在会抛 NOT_FOUND
      rt = {
        id,
        conn: null, // Promise<connection> | null
        overview: null,
        stats: null,
        history: [],
        health: rec.enabled ? HEALTH.UNKNOWN : HEALTH.DISABLED,
        lastOk: null,
        lastError: null,
        failures: 0,
        timer: null,
        inflight: null,
        lastStatsAt: 0,
        lastSampleAt: 0,
        print: null, // 建立连接时设备记录的指纹 (#fingerprint), 用来发现连接参数被改过
        paused: rec.enabled === false, // 已停用: 轮询暂停, 再次启用时由 #adopt() 恢复
      };
      this.#rt.set(id, rt);
    }
    return rt;
  }

  /** 设备自己的设置优先, 没设就用面板的全局默认。 */
  #interval(rt, key) {
    if (key === 'pollIntervalSec') {
      const own = this.store.list().find((d) => d.id === rt.id)?.pollIntervalSec; // 设备可能刚被删除, 所以不用会抛错的 get()
      if (own) return own;
    }
    return this.settings.get()[key];
  }

  /**
   * 设备记录的"指纹": 地址、适配器、账号和最后修改时间。变了就说明连接参数可能改过
   * (包括面板运行期间用命令行改的 —— 命令行不会通知面板, 只能每次连接前自己核对)。
   */
  #fingerprint(rec) {
    return `${rec.url}\n${rec.adapter}\n${rec.username}\n${rec.updatedAt}`;
  }

  #schedule(rt, delayMs) {
    if (this.#stopped) return;
    clearTimeout(rt.timer);
    rt.timer = setTimeout(() => {
      rt.timer = null;
      void this.#poll(rt);
    }, Math.max(0, delayMs));
    rt.timer.unref?.(); // 不让轮询定时器阻止进程退出
  }

  /** 全局的并发闸: 同时在途的设备访问不超过 concurrency 个。 */
  #limiter(fn) {
    return new Promise((resolve, reject) => {
      const run = () => {
        this.#active++;
        fn().then(resolve, reject).finally(() => {
          this.#active--;
          this.#queue.shift()?.();
        });
      };
      if (this.#active < this.concurrency) run();
      else this.#queue.push(run);
    });
  }

  // ── 连接 ────────────────────────────────────────────────────────────

  #connect(rt) {
    const rec = this.store.get(rt.id);
    const print = this.#fingerprint(rec);
    // 设备记录被改过: 旧连接作废 (#drop 一进入就把 rt.conn 置空, 退出登录在后台完成)
    if (rt.conn && rt.print !== print) void this.#drop(rt);
    if (!rt.conn) {
      rt.print = print;
      rt.conn = (async () => {
        const adapter = this.adapters.get(rec.adapter);
        return adapter.create({ url: rec.url, credentials: this.store.credentials(rt.id) });
      })().catch((err) => {
        rt.conn = null; // 建立失败就不留着一个失败的 Promise, 下次重试
        throw err;
      });
    }
    return rt.conn;
  }

  /** 断开并释放设备上的会话 (修改了地址 / 凭据, 或删除、停用设备时)。 */
  async #drop(rt) {
    const pending = rt.conn;
    rt.conn = null;
    if (!pending) return;
    const conn = await pending.catch(() => null);
    rt.overview = null;
    rt.stats = null;
    await conn?.logout().catch(() => {});
  }

  /** 在一条设备连接上执行操作, 并根据结果更新健康状态。 */
  async #use(rt, fn) {
    const adapter = this.adapters.get(this.store.get(rt.id).adapter);
    try {
      const result = await this.#limiter(async () => fn(await this.#connect(rt), adapter));
      rt.health = HEALTH.ONLINE;
      rt.lastOk = Date.now();
      rt.lastError = null;
      rt.failures = 0;
      this.emit('change', rt.id);
      return result;
    } catch (err) {
      // 参数不合法、操作不支持这类"面板侧"的错误不改变设备的健康状态
      if (err instanceof AppError && ['BAD_PARAM', 'UNSUPPORTED', 'NOT_FOUND', 'BUSY', 'CONFLICT'].includes(err.code)) throw err;
      rt.health = healthOf(err);
      rt.lastError = err.message;
      this.emit('change', rt.id);
      throw deviceError(err);
    }
  }

  #parts(id) {
    const rt = this.#rtFor(id);
    const rec = this.store.get(id);
    if (!rec.enabled) throw new AppError('这台设备已停用，请先在设备管理里启用', 'DISABLED', { status: 409 });
    return { rt, rec, adapter: this.adapters.get(rec.adapter) };
  }

  // ── 生命周期 ────────────────────────────────────────────────────────

  async start() {
    this.#stopped = false;
    this.store.list().forEach((rec, i) => {
      const rt = this.#rtFor(rec.id);
      if (rec.enabled) this.#schedule(rt, 300 + i * 800); // 错开启动, 不要一上来同时打所有设备
      else rt.health = HEALTH.DISABLED;
    });
  }

  async stop() {
    this.#stopped = true;
    const rts = [...this.#rt.values()];
    for (const rt of rts) clearTimeout(rt.timer);
    await Promise.allSettled(rts.map((rt) => this.#drop(rt)));
  }

  /**
   * 让运行时状态跟上设备表 —— 设备表可能在面板运行期间被命令行 (另一个进程) 改动:
   * 新添加的设备要开始轮询; 停用之后又启用的要恢复轮询。删除和停用是在轮询的时候发现并收尾的 (见 #pollNow)。
   */
  #adopt() {
    if (this.#stopped) return;
    for (const rec of this.store.list()) {
      if (!rec.enabled) continue;
      const rt = this.#rtFor(rec.id);
      if (rt.paused) {
        rt.paused = false;
        rt.health = HEALTH.UNKNOWN;
        this.#schedule(rt, 300);
      } else if (!rt.timer && !rt.inflight) {
        this.#schedule(rt, 300); // 这个进程还没开始轮询它: 命令行刚添加的, 或者只是被 describe() 顺手建了状态
      }
    }
  }

  // ── 后台轮询 ────────────────────────────────────────────────────────

  #pushHistory(rt, overview) {
    const now = Date.now();
    if (now - rt.lastSampleAt < 2000) return; // 页面在实时刷新时不必每个采样点都记
    rt.lastSampleAt = now;
    const ports = overview?.ports ?? [];
    rt.history.push({ t: now, rx: sum(ports, 'rxKbps'), tx: sum(ports, 'txKbps'), up: ports.filter((p) => p.enabled && p.speedAct).length });
    if (rt.history.length > this.historySize) rt.history.splice(0, rt.history.length - this.historySize);
  }

  /**
   * 轮询一次。同一设备同时只跑一个轮询; 已有轮询在进行时, 这次调用等它结束 (不重复打设备)。
   * force: 即使后台轮询还没启动 (没调用 start) 也执行 —— 界面上的"刷新"用。
   * 设备连不上之类的错误在这里被消化成健康状态, 不会抛出; 返回之后用 describe() 读结果。
   */
  #poll(rt, force = false) {
    if (rt.inflight) return rt.inflight;
    rt.inflight = this.#pollNow(rt, force).finally(() => {
      rt.inflight = null;
    });
    return rt.inflight;
  }

  async #pollNow(rt, force) {
    clearTimeout(rt.timer);
    rt.timer = null;
    let rec;
    try {
      rec = this.store.get(rt.id);
    } catch {
      // 设备已经从设备表里删掉了 (例如面板运行期间用命令行删除的): 收尾, 不再轮询
      this.#rt.delete(rt.id);
      void this.#drop(rt);
      return;
    }
    if (this.#stopped && !force) return;
    if (!rec.enabled) {
      // 被停用了 (同样可能是另一个进程做的): 不再轮询, 释放设备上的会话; 再次启用时由 #adopt() 恢复
      rt.health = HEALTH.DISABLED;
      rt.failures = 0;
      rt.paused = true;
      void this.#drop(rt);
      return;
    }
    const started = Date.now();
    try {
      await this.#limiter(async () => {
        const connection = await this.#connect(rt);
        const overview = (await connection.read('overview')).data;
        rt.overview = overview;
        rt.health = HEALTH.ONLINE;
        rt.lastOk = Date.now();
        rt.lastError = null;
        rt.failures = 0;
        this.#pushHistory(rt, overview);
        this.#rememberIdentity(rt, overview);
        const every = this.#interval(rt, 'statsIntervalSec') * 1000;
        if (!rt.stats || Date.now() - rt.lastStatsAt >= every) {
          rt.stats = (await connection.read('stats')).data;
          rt.lastStatsAt = Date.now();
        }
      });
    } catch (err) {
      const health = healthOf(err);
      rt.failures += 1;
      rt.lastError = err.message;
      // 之前在线的设备偶发一次连不上不算离线: 连续失败, 或超过三个轮询周期没成功, 才标成离线
      const transient = health === HEALTH.OFFLINE && rt.failures < 2 && rt.lastOk && Date.now() - rt.lastOk < 3 * this.#interval(rt, 'pollIntervalSec') * 1000;
      rt.health = transient ? HEALTH.ONLINE : health;
      this.log(`[device ${rt.id}] ${health}: ${err.message}`);
    } finally {
      this.#schedule(rt, Math.max(1000, this.#interval(rt, 'pollIntervalSec') * 1000 - (Date.now() - started)));
    }
    this.emit('change', rt.id);
  }

  /** 从概览数据里记下设备的型号 / 固件 / 端口数 (第一次轮询, 或者设备换过固件之后)。 */
  #rememberIdentity(rt, overview) {
    const d = overview?.device;
    if (!d?.model || !d?.firmware) return;
    const rec = this.store.get(rt.id);
    const ports = overview.ports?.length ?? 0;
    const current = rec.identified;
    if (current?.model === d.model && current?.firmware === d.firmware && current?.ports === ports && current?.mac) return;
    try {
      this.store.setIdentified(rt.id, { ...current, model: d.model, firmware: d.firmware, ports, mac: current?.mac || d.mac || '', hardware: current?.hardware || d.hardware || '' });
    } catch (err) {
      this.log(`[device ${rt.id}] 记录设备信息失败: ${err.message}`);
    }
  }

  /** 立即轮询一次 (界面上的"刷新"、或刚添加 / 修改完设备)。设备连不上时不抛错, 结果看返回值里的 health。 */
  async refresh(id) {
    const { rt } = this.#parts(id);
    await this.#poll(rt, true);
    return this.describe(id);
  }

  // ── 设备的增删改查 ──────────────────────────────────────────────────

  /** 用给定适配器连一次设备, 读出型号 / 固件 / 端口数, 然后立刻断开。 */
  async #identifyWith(adapter, url, credentials) {
    let connection;
    try {
      connection = await adapter.create({ url, credentials });
      return await connection.identify();
    } catch (err) {
      throw err instanceof AppError ? deviceError(new AppError(`${err.message}（${url}）`, err.code, { cause: err, status: err.status, details: err.details })) : err;
    } finally {
      await connection?.logout().catch(() => {});
    }
  }

  /** 选适配器: 指定了就用指定的, 否则 (auto / 留空) 不带凭据探测。 */
  async #pickAdapter(url, wanted) {
    if (wanted && wanted !== 'auto') return this.adapters.get(wanted);
    const adapter = await this.adapters.detect(url);
    if (!adapter) throw new AppError(`认不出 ${url} 上的设备：没有发现受支持的交换机管理界面。请检查地址和网络，或在“适配器”里手动指定。`, 'UNSUPPORTED');
    return adapter;
  }

  /** 测试一台 (还没保存的) 设备能不能连上、是什么设备。不保存。 */
  async test(input) {
    const url = normalizeUrl(input.url);
    const username = String(input.username ?? '').trim();
    const password = String(input.password ?? '');
    if (!username || !password) throw new AppError('请填写设备的账号和密码', 'BAD_PARAM');
    const adapter = await this.#pickAdapter(url, input.adapter);
    const identified = await this.#identifyWith(adapter, url, { username, password });
    return { adapter: { id: adapter.id, name: adapter.name, maturity: adapter.maturity, vendor: adapter.vendor }, identified };
  }

  /** 不带凭据探测: 这个地址上看起来是哪类设备。 */
  async probe(input) {
    const url = normalizeUrl(input.url);
    const adapter = await this.adapters.detect(url);
    return { url, adapter: adapter ? { id: adapter.id, name: adapter.name, maturity: adapter.maturity } : null, adapters: this.adapters.list().map((a) => ({ id: a.id, name: a.name, maturity: a.maturity })) };
  }

  /** 绑定一台设备: 识别成功才保存。 */
  async add(input) {
    const url = normalizeUrl(input.url);
    const username = String(input.username ?? '').trim();
    const password = String(input.password ?? '');
    if (!username || !password) throw new AppError('请填写设备的账号和密码', 'BAD_PARAM');
    const adapter = await this.#pickAdapter(url, input.adapter);
    const identified = await this.#identifyWith(adapter, url, { username, password });
    const rec = this.store.add({ ...input, url, adapter: adapter.id, username, password, identified });
    const rt = this.#rtFor(rec.id);
    if (rec.enabled) this.#schedule(rt, 300);
    this.log(`[device ${rec.id}] 已添加 ${rec.name} (${identified.model}, ${url})`);
    return this.describe(rec.id);
  }

  async update(id, patch) {
    const before = this.store.get(id);
    const rec = this.store.update(id, patch);
    const rt = this.#rtFor(id);
    const connectionChanged = ['url', 'adapter', 'username', 'password'].some((k) => patch[k] !== undefined && patch[k] !== '');
    if (connectionChanged || !rec.enabled) await this.#drop(rt);
    if (!rec.enabled) {
      clearTimeout(rt.timer);
      rt.timer = null;
      rt.health = HEALTH.DISABLED;
      rt.failures = 0;
      rt.paused = true;
    } else if (connectionChanged || !before.enabled || rt.paused) {
      rt.paused = false;
      rt.health = HEALTH.UNKNOWN;
      rt.failures = 0;
      this.#schedule(rt, 300);
    }
    return this.describe(id);
  }

  async remove(id) {
    const rt = this.#rtFor(id);
    clearTimeout(rt.timer);
    await this.#drop(rt);
    this.store.remove(id);
    this.#rt.delete(id);
    this.emit('removed', id);
  }

  // ── 描述 (给界面 / 指标 / 命令行) ───────────────────────────────────

  describe(id) {
    const rec = this.store.get(id);
    const rt = this.#rtFor(id);
    const adapter = this.adapters.get(rec.adapter);
    const overview = rt.overview;
    const ports = overview?.ports ?? [];
    const identified = rec.identified ?? {};
    return {
      id: rec.id,
      name: rec.name,
      url: rec.url,
      adapter: adapter.id,
      adapterName: adapter.name,
      adapterMaturity: adapter.maturity,
      vendor: adapter.vendor,
      enabled: rec.enabled,
      username: rec.username,
      hasSecret: rec.hasSecret,
      pollIntervalSec: this.#interval(rt, 'pollIntervalSec'),
      statsIntervalSec: this.#interval(rt, 'statsIntervalSec'),
      tags: rec.tags,
      notes: rec.notes,
      identified,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      health: rec.enabled === false ? HEALTH.DISABLED : rt.health, // 被另一个进程停用的设备, 在下一次轮询收尾之前就已经显示为"已停用"
      lastOk: rt.lastOk,
      lastError: rt.lastError,
      // 固件版本和 MAC 取设备当前报告的值 (升级之后立刻就是新的); 连不上时退回添加设备时识别到的记录
      model: identified.model || overview?.device?.model || null,
      firmware: overview?.device?.firmware || identified.firmware || null,
      mac: overview?.device?.mac || identified.mac || null,
      portCount: ports.length || identified.ports || null,
      portsUp: ports.filter((p) => p.enabled && p.speedAct).length,
      rxKbps: sum(ports, 'rxKbps'),
      txKbps: sum(ports, 'txKbps'),
      uptime: overview?.device?.uptime ?? null,
      cloud: overview?.cloud ?? null,
      /** 端口小图用的紧凑状态。 */
      portStates: ports.map((p) => ({ id: p.id, enabled: !!p.enabled, speedAct: p.speedAct || 0 })),
      capabilities: { reads: [...adapter.reads], writes: [...adapter.writes], features: [...adapter.features] },
    };
  }

  history(id) {
    return this.#rtFor(id).history.map((h) => ({ ...h }));
  }

  list() {
    this.#adopt();
    return this.store.list().map((rec) => this.describe(rec.id));
  }

  /** 全部设备总览 (带最近的流量历史, 供总览页画迷你趋势)。 */
  dashboard() {
    const devices = this.list().map((d) => ({ ...d, history: this.history(d.id).slice(-60) }));
    const count = (state) => devices.filter((d) => d.health === state).length;
    // 离线 / 出错的设备, 它的端口状态是最后一次轮询时的旧数据, 不计入"在线端口"
    const live = devices.filter((d) => d.health === HEALTH.ONLINE);
    return {
      devices,
      totals: {
        total: devices.length,
        online: count(HEALTH.ONLINE),
        offline: count(HEALTH.OFFLINE),
        auth: count(HEALTH.AUTH),
        error: count(HEALTH.ERROR),
        disabled: count(HEALTH.DISABLED),
        unknown: count(HEALTH.UNKNOWN),
        portsUp: live.reduce((n, d) => n + d.portsUp, 0),
        ports: devices.reduce((n, d) => n + (d.portCount ?? 0), 0),
        rxKbps: live.reduce((n, d) => n + d.rxKbps, 0),
        txKbps: live.reduce((n, d) => n + d.txKbps, 0),
      },
    };
  }

  /** 指标导出用的快照: 只读内存里的缓存, 不访问设备。 */
  metricsSnapshot() {
    this.#adopt();
    return this.store.list().map((rec) => {
      const rt = this.#rtFor(rec.id);
      return {
        device: this.describe(rec.id),
        ports: rt.overview?.ports ?? [],
        stats: rt.stats?.ports ?? [],
        overviewAt: rt.lastOk,
        statsAt: rt.lastStatsAt,
      };
    });
  }

  // ── 访问设备 ────────────────────────────────────────────────────────

  /**
   * 读一个规范模型。overview / stats 默认可以用后台轮询的缓存 (数据足够新时);
   * live: true 时一定向设备实时读取 (概览页的实时速率用)。
   */
  async read(id, key, { live = false } = {}) {
    const { rt, adapter } = this.#parts(id);
    requireRead(adapter, key);
    const cachedAt = key === 'overview' ? rt.lastOk : rt.lastStatsAt;
    const maxAge = this.#interval(rt, key === 'overview' ? 'pollIntervalSec' : 'statsIntervalSec') * 1000 * 2;
    if (!live && rt[key] && rt.health === HEALTH.ONLINE && cachedAt && Date.now() - cachedAt < maxAge) {
      return { data: rt[key], cached: true, ageMs: Date.now() - cachedAt };
    }
    const { data, tip } = await this.#use(rt, (connection) => connection.read(key));
    if (key === 'overview' || key === 'stats') {
      rt[key] = data;
      if (key === 'overview') {
        this.#pushHistory(rt, data);
        this.#rememberIdentity(rt, data);
      } else rt.lastStatsAt = Date.now();
    }
    return { data, tip: tip ?? '', cached: false, ageMs: 0 };
  }

  async readPages(id, keys) {
    const { rt, adapter } = this.#parts(id);
    return this.#use(rt, (connection) => readPages(connection, adapter, keys));
  }

  async readStats(id, port) {
    const { rt, adapter } = this.#parts(id);
    requireFeature(adapter, 'statsDetail');
    return this.#use(rt, (connection) => connection.readStats(port));
  }

  async submit(id, op, params) {
    const { rt, adapter } = this.#parts(id);
    return this.#use(rt, (connection) => runOp(connection, adapter, op, params));
  }

  async ping(id) {
    const { rt } = this.#parts(id);
    return this.#use(rt, (connection) => connection.ping());
  }

  /** 取备份文件的内容和建议文件名。 */
  async backup(id) {
    const { rt, adapter } = this.#parts(id);
    return this.#use(rt, (connection) => backupDevice(connection, adapter));
  }

  async restore(id, file) {
    const { rt, adapter } = this.#parts(id);
    return this.#use(rt, (connection) => restoreDevice(connection, adapter, file));
  }

  async checkFirmware(id) {
    const { rt, adapter } = this.#parts(id);
    return this.#use(rt, (connection) => checkDeviceFirmware(connection, adapter));
  }

  /** 供固件任务使用的连接。只建立连接, 不做任何访问, 所以不据此改变健康状态。 */
  async connectionFor(id) {
    const { rt } = this.#parts(id);
    return this.#connect(rt);
  }
}
