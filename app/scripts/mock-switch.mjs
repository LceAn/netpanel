#!/usr/bin/env node
// 模拟交换机: 用合成夹具 (test/fixtures/rpm) 模拟一台使用 TP-LINK 旧版 Web 界面的交换机,
// 用来在不碰真机的情况下开发和验证面板 —— 包括所有写操作流程。
//
//   node scripts/mock-switch.mjs [端口]        默认 8269
//
// 环境变量:
//   MOCK_USER / MOCK_PASS   登录账号, 默认 admin / admin
//   MOCK_VARIANT=N          第 N 台: 换一个 MAC、管理地址、运行时间和端口状态, 起多台时用来区分
//   MOCK_PROFILE=lab        预置一份有内容的配置 (4 个 VLAN、一个汇聚组、端口隔离、限速…), 默认是出厂状态
//   MOCK_NEW_FIRMWARE=1     "检查新版本"时报告有新固件
//
// 每个写请求都会打印到控制台 (方法、路径、字段), 可以据此核对面板发给交换机的内容。
// 也可以在测试里 import { createMockSwitch } 起一个进程内的实例 (见 test/http.test.mjs)。
//
// 设备状态是 "页面名 → { 变量名: 值 }" 的对象: 收到写请求就改对象, 回复页面时再序列化成 <script> 里的声明。

import { createServer } from 'node:http';
import { randomInt } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { securityEncode } from '../src/adapters/tplink-rpm/client.mjs';
import { parseVars } from '../src/core/jslite.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '..', 'test', 'fixtures', 'rpm');
const REBOOT_MS = 8000; // 模拟重启 / 升级后重新上线要多久
const UPGRADE_MS = 6000; // 模拟写固件要多久
const CHECK_MS = 2000; // 模拟在线检查新版本要多久
const BACKUP_MAGIC = 'NETPANEL-MOCK-CONFIG\n';

/** 出厂状态 (从夹具读一次, 之后不再改动)。 */
const factory = Object.fromEntries(
  readdirSync(FIXTURES).filter((f) => f.endsWith('_htm.txt')).map((file) => [file.replace(/_htm\.txt$/, ''), parseVars(readFileSync(join(FIXTURES, file), 'utf8'))]),
);

const range = (n) => Array.from({ length: n }, (_, i) => i + 1);

/** 值 → JS 字面量 (与原厂页面里的写法一致: 对象的键不加引号, 字符串用双引号)。 */
const lit = (value) => {
  if (Array.isArray(value)) return `[${value.map(lit).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).map(([k, v]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}:${lit(v)}`).join(',')}}`;
  }
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
};

const LOGIN_PAGE = (code) => `<script>\nvar logonInfo = new Array(\n${code},\n0,0);\n</script>\n`;
const TIP_ONLY = (tip) => `<script>\nvar tip = "${tip}";\n</script>\n`;

/** 解析请求体 → [[字段名, 值]]; 文件字段的值是 Buffer。 */
function parseBody(req, chunks) {
  const type = String(req.headers['content-type'] ?? '');
  const body = Buffer.concat(chunks);
  const fields = [];
  if (type.startsWith('application/x-www-form-urlencoded')) {
    for (const [k, v] of new URLSearchParams(body.toString('utf8'))) fields.push([k, v]);
  } else if (type.startsWith('multipart/form-data')) {
    const boundary = /boundary=(.+)$/.exec(type)?.[1];
    for (const part of body.toString('latin1').split(`--${boundary}`).slice(1, -1)) {
      const at = part.indexOf('\r\n\r\n');
      const head = part.slice(0, at);
      const raw = Buffer.from(part.slice(at + 4).replace(/\r\n$/, ''), 'latin1');
      fields.push([/name="([^"]*)"/.exec(head)?.[1], /filename=/.test(head) ? raw : raw.toString('utf8')]);
    }
  }
  return fields;
}

const show = (fields) => fields.map(([k, v]) => `${k}=${Buffer.isBuffer(v) ? `<文件 ${v.length} 字节>` : v}`).join(' ');

/** 模拟器里"认识"的 MAC: 地址 → { vid, port }。 */
const KNOWN_MACS = {
  'AA:BB:CC:DD:EE:FF': { vid: 10, port: 3 },
  'AA:BB:CC:DD:EE:01': { vid: 20, port: 6 },
  'AA:BB:CC:DD:EE:02': { vid: 30, port: 7 },
};

/**
 * 每个接口预期的提交方式 —— 照原厂页面里对应的表单 (逐个核对过, 见 docs/protocol.md):
 *   get        GET, 参数在查询串里                  原厂 <form> 没写 method (浏览器默认用 GET 提交)
 *   form       POST, 表单编码的请求体                原厂 <form method=post>
 *   multipart  POST, multipart 请求体                原厂 <form method=post enctype=multipart/form-data>
 *   xhr        POST, 空请求体, token 在查询串里       原厂用 XHR 提交的固件接口
 * 交换机只按它预期的方式取参数, 用别的方式发它直接断开连接 (真机实测: 用 POST 请求备份接口就是这样)。
 */
const SUBMIT = {
  main_info_port_status_set: 'get', port_setting: 'get', port_statistics_set: 'get', system_name_set: 'get',
  ip_setting: 'get', fix_ip_setting: 'get', usr_account_set: 'get', port_trunk_set: 'get', port_trunk_display: 'get',
  port_isolation_set: 'get', mac_address_search: 'get', mirror_enabled_set: 'get', mirrored_port_set: 'get',
  loop_prevention_set: 'get', cable_diag_get: 'get', config_back: 'get', vlanPvidSet: 'get',
  mtuVlanSet: 'get', pvlanSet: 'get', qvlanSet: 'get',
  savingconfig: 'form', reboot: 'form', reset: 'form', cloud: 'form', tumscloud: 'form',
  qos_mode_set: 'form', qos_port_priority_set: 'form', qos_bandwidth_set: 'form', qos_storm_set: 'form',
  conf_restore: 'multipart', httpupg: 'multipart',
  check_new_version_start: 'xhr', check_new_version: 'xhr', upgradeConflict: 'xhr', upgrade_online: 'xhr', upgradeStatusCheck: 'xhr',
};

/** 写操作成功后, 真机返回的是对应的功能页 (页首数据 + tip = "操作成功"); 实测过的有 ✔。 */
const RESULT_PAGE = {
  main_info_port_status_set: 'MainRpm', // ✔
  port_setting: 'PortSettingRpm', // ✔
  port_statistics_set: 'PortStatisticsRpm', // ✔
  system_name_set: 'SystemInfoRpm',
  ip_setting: 'IpSettingRpm',
  fix_ip_setting: 'FixIpSettingRpm',
  usr_account_set: 'UserAccountRpm',
  cloud: 'cloud',
  tumscloud: 'cloud',
  port_trunk_set: 'PortTrunkRpm',
  port_trunk_display: 'PortTrunkRpm',
  port_isolation_set: 'PortIsolationRpm',
  mirror_enabled_set: 'PortMirrorRpm',
  mirrored_port_set: 'PortMirrorRpm',
  loop_prevention_set: 'LoopPreventionRpm', // ✔
  vlanPvidSet: 'Vlan8021QPvidRpm', // ✔
  mtuVlanSet: 'VlanMtuRpm',
  pvlanSet: 'VlanPortBasicRpm',
  qvlanSet: 'Vlan8021QRpm', // ✔
  savingconfig: 'SavingConfigRpm',
  qos_mode_set: 'QosBasicRpm', // ✔
  qos_port_priority_set: 'QosBasicRpm',
  qos_bandwidth_set: 'QosBandWidthControlRpm',
  qos_storm_set: 'QosStormControlRpm',
};

/** 真机对写请求的响应: HTML, 并关闭连接。 */
const HTML_HEADERS = { 'Content-Type': 'text/html', Connection: 'close' };

export class MockSwitch {
  /**
   * @param {{ user?: string, password?: string, variant?: number, profile?: string, newFirmware?: boolean, log?: Function }} opts
   */
  constructor({ user = 'admin', password = 'admin', variant = 0, profile = '', newFirmware = false, log = () => {} } = {}) {
    this.opts = { user, password, variant, profile, newFirmware };
    this.log = log;
    this.ports = Number(factory.MainRpm.max_port_num ?? 8);
    this.maxLag = Number(factory.PortTrunkRpm.trunk_conf.maxTrunkNum ?? 2);
    /** 夹具里的运行时间: "11 day - 4 hour - 17 min - 32 sec"。 */
    this.bootUptime = ((11 * 24 + 4) * 60 + 17) * 60 + 32;
    /** 每个口在"启用 + 自协商"时的链路速率: 6 = 1000M, 5 = 100M, 0 = 没插线。 */
    this.links = factory.MainRpm.port_info.spd_act.slice(0, this.ports).map(Number);
    /** 每个口 (有链路时) 的收发基础速率, Kbps。面板看到的曲线在它附近波动。 */
    this.traffic = [[380, 960], [140, 310], [0, 0], [260, 1710], [0, 0], [18, 4], [0, 0], [0, 0]];
    this.startedAt = Date.now();
    this.sessions = new Map(); // SessionID → token
    this.writes = []; // 收到的写请求, 测试断言用: { method, path, query, fields }
    this.lags = new Map(); // 汇聚组: 组号 → 成员端口
    this.reset({ lab: profile === 'lab' });

    this.server = createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('error', () => {});
      req.on('end', () => this.#handle(req, res, chunks).catch((err) => {
        this.log('[mock] 处理请求出错:', err.message);
        res.destroy();
      }));
    });
  }

  get url() {
    return `http://127.0.0.1:${this.server.address().port}`;
  }

  listen(port = 0) {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', () => {
        this.server.off('error', reject);
        resolve(this);
      });
    });
  }

  close() {
    this.server.closeAllConnections?.();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  // ── 状态 ────────────────────────────────────────────────────────────

  /** 回到出厂状态。lab: 预置一份有内容的配置。 */
  reset({ lab = false } = {}) {
    this.vars = Object.fromEntries(Object.keys(factory).map((name) => [name, structuredClone({ ...factory[name] })]));
    this.physical = [...this.links];
    /** 设备保存的是 securityEncode(密码), 面板登录时发来的也是编码后的值。 */
    this.account = { username: this.opts.user, encoded: securityEncode(this.opts.password) };
    this.bootedAt = Date.now() - this.bootUptime * 1000;
    this.statsClearedAt = 0;
    this.offlineUntil = 0; // "重启中": 到这个时刻为止不响应任何请求
    this.upgrade = null; // { until } | { failed } | { done }
    this.checkStartedAt = 0;
    this.lags.clear();
    this.#applyVariant();
    if (lab) this.#applyLab();
    this.#syncLag();
    this.#syncVlan();
    this.#syncPorts();
  }

  V(page) {
    return this.vars[page];
  }

  /** 一页的页首数据: <script> 里的变量声明 (面板只读这一段)。 */
  page(name, tip = '') {
    const lines = Object.entries({ ...this.V(name), tip }).map(([k, v]) => `var ${k} = ${lit(v)};\n`);
    return `<script>\n${lines.join('')}</script>\n`;
  }

  /** 第 N 台: 换身份和链路状态。 */
  #applyVariant() {
    const n = this.opts.variant;
    if (!n) return;
    const ip = `192.168.2.${20 + n}`;
    const mac = `02:00:5E:0${n}:0${n}:0${n}`;
    for (const info of [this.V('MainRpm').info_ds, this.V('SystemInfoRpm').info_ds]) Object.assign(info, { ipStr: [ip], macStr: [mac] });
    Object.assign(this.V('IpSettingRpm').ip_ds, { ipStr: [ip], gatewayStr: ['192.168.2.1'], dnsStr: ['192.168.2.1'] });
    this.physical = range(this.ports).map((p) => (p % 2 === 0 ? 6 : 0));
    this.bootedAt = Date.now() - (this.bootUptime - n * 3700) * 1000;
  }

  /** 一份有内容的配置: 1-2 上联, 3-5 办公, 6 访客, 7-8 服务器 (做成汇聚组)。 */
  #applyLab() {
    Object.assign(this.V('Vlan8021QRpm').qvlan_ds, {
      vids: [1, 10, 20, 30],
      names: ['Default', 'Office', 'Guests', 'Servers'],
      tagMbrs: [0, 0x03, 0x01, 0x03],
      untagMbrs: [0x03, 0x0c, 0x20, 0xc0],
    });
    this.V('Vlan8021QPvidRpm').pvid_ds.pvids = [1, 1, 10, 10, 10, 20, 30, 30];
    this.lags.set(1, [7, 8]);
    this.V('PortIsolationRpm').portIso_conf.portStr_iso = range(this.ports).map((p) => (p === 6 ? '1,2,6' : '1-8')); // 访客口只通上联
    this.V('LoopPreventionRpm').lpEn = 1;
    this.V('MainRpm').loopPortConf.loopbackEnable = 1;
    this.V('QosBasicRpm').pPri = [1, 1, 4, 1, 2, 1, 1, 1];
    this.#setBandwidth(6, 2048, 4096);
    this.#setBandwidth(2, 0, 65536);
    for (const p of [1, 2]) this.#setStorm(p, 512, [4]);
    this.#setStorm(6, 256, [1, 2, 4]);
    // 有内容的配置里大部分口都接着设备: 链路全亮, 各有自己的流量
    this.physical = this.physical.map((v) => v || 6);
    this.traffic = [[380, 960], [140, 310], [95, 210], [260, 1710], [410, 88], [18, 4], [720, 640], [680, 610]];
  }

  // ── 派生状态: 一处改动, 同步到所有相关的页面 ─────────────────────────

  #lagOf(p) {
    return [...this.lags].find(([, members]) => members.includes(p))?.[0] ?? 0;
  }

  #maskOf(ports) {
    return range(this.ports).reduce((m, p) => (ports.includes(p) ? m | (1 << (p - 1)) : m), 0);
  }

  #portsOf(mask) {
    return range(this.ports).filter((p) => (mask >> (p - 1)) & 1);
  }

  #syncLag() {
    const n = this.ports;
    const perPort = range(n).map((p) => this.#lagOf(p));
    const groups = [...this.lags.keys()].sort((a, b) => a - b);
    for (const info of [this.V('MainRpm').port_info, this.V('PortSettingRpm').all_info, this.V('PortIsolationRpm').portIso_conf]) info.trunk_info = perPort;
    for (const conf of [this.V('MainRpm').trunkConf, this.V('PortTrunkRpm').trunk_conf]) {
      for (let g = 1; g <= this.maxLag; g++) conf[`portStr_g${g}`] = range(n).map((p) => (this.#lagOf(p) === g ? 1 : 0));
    }
    Object.assign(this.V('PortIsolationRpm').portIso_conf, { trunk_seq: groups, trunkNum: groups.length });
    this.V('PortMirrorRpm').porttrunkid = [0, ...perPort, 0];
    this.V('QosBasicRpm').pTrunk = [...perPort];
    for (const [page, key] of [['QosBandWidthControlRpm', 'bcInfo'], ['QosStormControlRpm', 'scInfo']]) {
      this.V(page)[key].forEach((_, i) => { if (i % 3 === 2) this.V(page)[key][i] = perPort[(i - 2) / 3]; });
    }
  }

  /** 802.1Q VLAN: 以 Vlan8021QRpm.qvlan_ds 为准, 同步到概览页的摘要和 PVID 页。 */
  #syncVlan() {
    const q = this.V('Vlan8021QRpm').qvlan_ds;
    const members = q.vids.map((_, i) => q.tagMbrs[i] | q.untagMbrs[i]);
    const lagIds = range(this.ports).map((p) => this.#lagOf(p));
    const lagMbrs = [0, ...range(this.maxLag).map((g) => this.#maskOf(this.lags.get(g) ?? []))];
    Object.assign(q, { count: q.vids.length, lagIds, lagMbrs });
    const summary = this.V('MainRpm').qvlan_ds;
    const pad = Array(Math.max(0, summary.maxVids - q.vids.length)).fill(0);
    Object.assign(summary, { state: q.state, count: q.vids.length, vlanList: [...q.vids, ...pad], portmask: [...members, ...pad] });
    const p = this.V('Vlan8021QPvidRpm').pvid_ds;
    // 某个 VLAN 被删掉后, 还以它为 PVID 的端口回到第一个 VLAN
    p.pvids = p.pvids.map((vid) => (q.vids.includes(vid) ? vid : q.vids[0]));
    Object.assign(p, { state: q.state, vids: [...q.vids], mbrs: [...members], count: q.vids.length, lagIds: [...lagIds], lagMbrs: [...lagMbrs] });
    Object.assign(this.V('VlanPortBasicRpm').pvlan_ds, { lagIds: [...lagIds], lagMbrs: [...lagMbrs] });
  }

  /** 端口状态: 三个页面里的同一份数据 (配置 + 实际链路) 保持一致。 */
  #syncPorts() {
    const info = this.V('MainRpm').port_info;
    const all = this.V('PortSettingRpm').all_info;
    const stats = this.V('PortStatisticsRpm').all_info;
    for (const p of range(this.ports)) {
      const i = p - 1;
      info.spd_act[i] = info.state[i] === 0 || this.physical[i] === 0 ? 0 : info.spd_cfg[i] === 1 ? this.physical[i] : info.spd_cfg[i];
      info.fc_act[i] = info.spd_act[i] ? info.fc_cfg[i] : 0;
      for (const key of ['state', 'spd_cfg', 'spd_act', 'fc_cfg', 'fc_act']) all[key][i] = info[key][i];
      stats.state[i] = info.state[i];
      stats.link_status[i] = info.spd_act[i];
    }
  }

  #setBandwidth(port, ingress, egress) {
    this.V('QosBandWidthControlRpm').bcInfo.splice(3 * (port - 1), 2, ingress, egress);
  }

  #setStorm(port, rate, types) {
    this.V('QosStormControlRpm').scInfo.splice(3 * (port - 1), 2, rate, types.reduce((a, t) => a | t, 0));
  }

  // ── 实时数据: 速率、包计数、运行时间 ─────────────────────────────────

  #wave(port, dir, now) {
    const base = this.traffic[port - 1]?.[dir] ?? 0;
    return Math.round(base * (0.78 + 0.22 * Math.sin(now / (4000 + 900 * port) + port * 1.7 + dir * 2.4)));
  }

  #liveOverview(now) {
    const info = this.V('MainRpm').info_ds;
    const up = Math.floor((now - this.bootedAt) / 1000);
    info.workTime = [`${Math.floor(up / 86400)} day - ${Math.floor((up % 86400) / 3600)} hour - ${Math.floor((up % 3600) / 60)} min - ${up % 60} sec`];
    const pi = this.V('MainRpm').port_info;
    pi.rx_rate = [...range(this.ports).map((p) => (pi.spd_act[p - 1] ? this.#wave(p, 0, now) : 0)), 0, 0];
    pi.tx_rate = [...range(this.ports).map((p) => (pi.spd_act[p - 1] ? this.#wave(p, 1, now) : 0)), 0, 0];
  }

  /** "清空统计"之后过了多少秒; 没清过就是模拟器启动以来过了多少秒。 */
  #statsSecs(now) {
    return (now - (this.statsClearedAt || this.startedAt)) / 1000;
  }

  /** 包计数 = 出厂夹具里的数 + 流量累计 (每秒约 0.2 × Kbps 个包); "清空统计"之后从 0 开始。 */
  #liveStats(now) {
    const base = this.V('PortStatisticsRpm').all_info;
    const origin = factory.PortStatisticsRpm.all_info.pkts;
    const secs = this.#statsSecs(now);
    base.pkts = range(this.ports)
      .flatMap((p) => [this.#wave(p, 1, now) * 0.2, 0.002, this.#wave(p, 0, now) * 0.2, 0.001]
        .map((rate, k) => Math.floor((this.statsClearedAt ? 0 : origin[4 * (p - 1) + k] ?? 0) + secs * rate)))
      .concat([0, 0]);
  }

  // ── 写请求 → 改状态 ───────────────────────────────────────────────────

  /** 按原厂语义改动设备状态。返回 string 表示失败提示, null 表示成功。 */
  #apply(path, all) {
    const many = (name) => all.filter(([k]) => k === name).map(([, v]) => v);
    const one = (name) => all.find(([k]) => k === name)?.[1];
    const ports = many('portid').map(Number);
    const selected = all.filter(([k]) => /^sel_\d+$/.test(k)).map(([k]) => Number(k.slice(4)));
    const info = this.V('MainRpm').port_info;
    let error = null;
    switch (path) {
      case 'port_setting.cgi': // 7 = 保持不变 (状态 / 流控), 8 = 保持不变 (速率)
        for (const p of ports) {
          if (one('state') !== '7') info.state[p - 1] = Number(one('state'));
          if (one('speed') !== '8') info.spd_cfg[p - 1] = Number(one('speed'));
          if (one('flowcontrol') !== '7') info.fc_cfg[p - 1] = Number(one('flowcontrol'));
        }
        break;
      case 'main_info_port_status_set.cgi': // 概览页的快捷设置: 0 = 禁用, 其余是速率 / 双工
        for (const [k, v] of all) {
          const p = Number(/^port_sel_(\d+)$/.exec(k)?.[1]);
          if (!p) continue;
          info.spd_cfg[p - 1] = Number(v);
          info.state[p - 1] = Number(v) === 0 ? 0 : 1;
        }
        break;
      case 'port_trunk_set.cgi': {
        const group = Number(one('groupId'));
        if (group >= 1 && group <= this.maxLag && ports.length >= 2) {
          for (const [g, members] of [...this.lags]) {
            const rest = members.filter((p) => !ports.includes(p));
            if (rest.length !== members.length) (rest.length >= 2 ? this.lags.set(g, rest) : this.lags.delete(g)); // 被抽走成员的组剩不下 2 个口就解散
          }
          this.lags.set(group, [...ports]);
        }
        break;
      }
      case 'port_trunk_display.cgi':
        for (const g of many('chk_trunk').map(Number)) this.lags.delete(g);
        break;
      case 'port_isolation_set.cgi':
        for (const p of many('groupId').map(Number)) this.V('PortIsolationRpm').portIso_conf.portStr_iso[p - 1] = many('portid').join(',');
        break;
      case 'mirror_enabled_set.cgi':
        Object.assign(this.V('PortMirrorRpm'), { MirrEn: Number(one('state')), MirrPort: Number(one('mirroringport') ?? this.V('PortMirrorRpm').MirrPort) });
        break;
      case 'mirrored_port_set.cgi': {
        const m = this.V('PortMirrorRpm').mirr_info;
        const list = many('mirroredport').map(Number);
        m.ingress = range(this.ports).map((p) => (list.includes(p) && one('ingressState') === '1' ? 1 : 0));
        m.egress = range(this.ports).map((p) => (list.includes(p) && one('egressState') === '1' ? 1 : 0));
        break;
      }
      case 'loop_prevention_set.cgi':
        this.V('LoopPreventionRpm').lpEn = Number(one('lpEn'));
        this.V('MainRpm').loopPortConf.loopbackEnable = Number(one('lpEn'));
        break;
      case 'qos_mode_set.cgi':
        this.V('QosBasicRpm').qosMode = Number(one('rd_qosmode'));
        break;
      case 'qos_port_priority_set.cgi':
        // 表单里的 port_queue 是 0-3, 页面里的 pPri 是 1-4 (原厂 do_check: port_queue.value = pPri - 1)
        for (const p of selected) this.V('QosBasicRpm').pPri[p - 1] = Number(one('port_queue')) + 1;
        break;
      case 'qos_bandwidth_set.cgi':
        for (const p of selected) this.#setBandwidth(p, Number(one('igrRate')), Number(one('egrRate')));
        break;
      case 'qos_storm_set.cgi':
        for (const p of selected) {
          if (Number(one('state')) === 1) this.#setStorm(p, Number(one('rate')), many('stormType').map(Number));
          else this.#setStorm(p, 0, []);
        }
        break;
      case 'mtuVlanSet.cgi': {
        const m = this.V('VlanMtuRpm').mtu_ds;
        if (one('mtu_en') !== undefined) m.state = Number(one('mtu_en'));
        if (one('uplinkPort') !== undefined) m.uplinkPort = Number(one('uplinkPort'));
        break;
      }
      case 'pvlanSet.cgi': {
        const p = this.V('VlanPortBasicRpm').pvlan_ds;
        if (one('pvlan_en') !== undefined) p.state = Number(one('pvlan_en'));
        if (one('vid') !== undefined) {
          const vid = Number(one('vid'));
          const mask = this.#maskOf(many('selPorts').map(Number));
          const i = p.vids.indexOf(vid);
          if (i >= 0) p.mbrs[i] = mask;
          else { p.vids.push(vid); p.mbrs.push(mask); }
        }
        for (const vid of many('selVlans').map(Number)) {
          const i = p.vids.indexOf(vid);
          if (i >= 0) { p.vids.splice(i, 1); p.mbrs.splice(i, 1); }
        }
        p.count = p.vids.length;
        break;
      }
      case 'qvlanSet.cgi': {
        const q = this.V('Vlan8021QRpm').qvlan_ds;
        if (one('qvlan_en') !== undefined) q.state = Number(one('qvlan_en'));
        if (one('vid') !== undefined) {
          const vid = Number(one('vid'));
          let tag = 0;
          let untag = 0;
          for (const [k, v] of all) {
            const m = /^selType_(\d+)$/.exec(k);
            if (!m || v === '2') continue; // 0 = Untagged, 1 = Tagged, 2 = 非成员
            if (v === '1') tag |= 1 << (Number(m[1]) - 1);
            else untag |= 1 << (Number(m[1]) - 1);
          }
          const i = q.vids.indexOf(vid);
          if (i >= 0) { q.names[i] = String(one('vname') ?? ''); q.tagMbrs[i] = tag; q.untagMbrs[i] = untag; }
          else { q.vids.push(vid); q.names.push(String(one('vname') ?? '')); q.tagMbrs.push(tag); q.untagMbrs.push(untag); }
        }
        for (const vid of many('selVlans').map(Number)) {
          const i = q.vids.indexOf(vid);
          if (i > 0) for (const key of ['vids', 'names', 'tagMbrs', 'untagMbrs']) q[key].splice(i, 1); // 默认 VLAN (第一项) 删不掉
        }
        break;
      }
      case 'vlanPvidSet.cgi':
        for (const p of this.#portsOf(Number(one('pbm')))) this.V('Vlan8021QPvidRpm').pvid_ds.pvids[p - 1] = Number(one('pvid'));
        break;
      case 'system_name_set.cgi':
        for (const i of [this.V('MainRpm').info_ds, this.V('SystemInfoRpm').info_ds]) i.descriStr = [String(one('sysName') ?? '')];
        break;
      case 'ip_setting.cgi': {
        const ip = this.V('IpSettingRpm');
        if (one('manage_vlan') !== undefined) ip.manage_vlan = Number(one('manage_vlan'));
        Object.assign(ip.ip_ds, {
          state: one('dhcpSetting') === 'enable' ? 1 : 0,
          dnsEnable: one('dns_enable') === 'enable' ? 1 : 0,
          ...(one('dns_addr') !== undefined ? { dnsStr: [one('dns_addr')] } : {}),
          ...(one('ip_address') !== undefined ? { ipStr: [one('ip_address')], netmaskStr: [one('ip_netmask')], gatewayStr: [one('ip_gateway')] } : {}),
        });
        break;
      }
      case 'fix_ip_setting.cgi':
        this.V('FixIpSettingRpm').ip_ds.state = one('fixIpSetting') === 'enable' ? 1 : 0;
        break;
      case 'usr_account_set.cgi':
        if (one('txt_oldpwd') !== this.account.encoded) error = '旧密码错误';
        else {
          this.account = { username: String(one('txt_username') ?? ''), encoded: one('txt_userpwd') };
          this.V('UserAccountRpm').user_ds.userNameStr = [this.account.username];
        }
        break;
      case 'cloud.cgi':
        this.V('cloud').mngt_switch = String(one('status'));
        this.V('cloud').cloud_type = String(one('cloud_type') ?? this.V('cloud').cloud_type);
        this.V('MainRpm').cloud_config = Number(one('status'));
        this.V('SystemInfoRpm').mngt_switch = Number(one('status'));
        break;
      case 'tumscloud.cgi':
        Object.assign(this.V('cloud'), { tums_server: String(one('tums_server') ?? ''), tums_port: String(one('tums_port') ?? '') });
        break;
      case 'port_statistics_set.cgi':
        this.statsClearedAt = Date.now();
        break;
      default:
    }
    this.#syncLag();
    this.#syncVlan();
    this.#syncPorts();
    return error;
  }

  /** 有些写操作的返回页本身就是结果页 (MAC 搜索、线缆检测)。返回 null 表示走默认的返回页。 */
  #resultPage(path, fields) {
    const one = (name) => fields.find(([k]) => k === name)?.[1];
    if (path === 'mac_address_search.cgi') {
      const mac = String(one('txt_macAddress_search') ?? '').toUpperCase();
      const hit = KNOWN_MACS[mac];
      // 与真机一致 (实测): 没搜到时 tip 是 "未找到MAC地址", macNum 为 0, 但仍带一条占位记录
      const entry = hit ? `{mac:"${mac}", vid:${hit.vid}, port:${hit.port}}` : '{mac:"0",vid:0,port:0}';
      return `<script>\nvar tip = "${hit ? '操作成功' : '未找到MAC地址'}";\nvar mac_ds = {is_qvlan:1, mac_info:[\n${entry}\n], macNum:${hit ? 1 : 0}};\n</script>\n`;
    }
    if (path === 'cable_diag_get.cgi') {
      const c = this.V('CableDiagRpm');
      for (const [k] of fields) {
        const port = Number(/^chk_(\d+)$/.exec(k)?.[1]);
        if (!port) continue;
        c.cablestate[port - 1] = port % 2 === 0 ? 1 : 2; // 偶数口线缆正常, 奇数口开路
        c.cablelength[port - 1] = port % 2 === 0 ? 3 + port : 5 + port;
      }
      return this.page('CableDiagRpm', '操作成功'); // 真机 (实测): 返回线缆检测页, tip 是 "操作成功"
    }
    return null;
  }

  // ── 配置备份 / 还原 ───────────────────────────────────────────────────

  #snapshot() {
    return JSON.stringify({ vars: this.vars, physical: this.physical, lags: [...this.lags] });
  }

  #restore(buf) {
    const text = buf.toString('utf8');
    if (!text.startsWith(BACKUP_MAGIC)) return '配置文件格式不正确';
    try {
      const saved = JSON.parse(text.slice(BACKUP_MAGIC.length));
      this.vars = saved.vars;
      this.physical = saved.physical;
      this.lags = new Map(saved.lags);
      this.#syncLag();
      this.#syncVlan();
      this.#syncPorts();
      return null;
    } catch {
      return '配置文件已损坏';
    }
  }

  // ── HTTP ──────────────────────────────────────────────────────────────

  async #handle(req, res, chunks) {
    const url = new URL(req.url, 'http://mock');
    const path = url.pathname.replace(/^\//, '');
    const now = Date.now();
    if (now < this.offlineUntil) return req.socket.destroy(); // "重启中": 直接断开
    if (path === 'index.html') return req.socket.destroy(); // 真机登录后访问 index.html 就是空回复

    if (path === 'logon.cgi') {
      const fields = parseBody(req, chunks);
      const get = (k) => fields.find(([n]) => n === k)?.[1];
      if (get('username') === this.account.username && get('password') === this.account.encoded) {
        const id = randomInt(1e9, 2e9).toString(36);
        const token = String(randomInt(1e8, 2e9));
        this.sessions.set(id, token);
        this.log('[login]', get('username'), '成功');
        return res.writeHead(200, { 'Set-Cookie': `SessionID=${id};HttpOnly; Path=/` }).end(LOGIN_PAGE(0));
      }
      this.log('[login]', get('username'), '被拒绝');
      return res.end(LOGIN_PAGE(1));
    }

    const sid = /SessionID=(\w+)/.exec(req.headers.cookie ?? '')?.[1];
    const tid = this.sessions.get(sid);
    if (path === 'Logout.htm' && sid) this.sessions.delete(sid);
    if (!tid) return res.end(LOGIN_PAGE(5));
    if (path === '') {
      const title = this.V('SystemInfoRpm').info_ds.productModel[0];
      return res.end(`<script>\nvar g_Lan=0,g_level=1,g_year=2026,g_title='${title}',g_product=2,g_tid=${tid};\nvar menuNoMng = 0;\nvar g_hasNewFirmware=${this.V('fwupgradephase0').hasNewFirmware};\n</script>\n`);
    }

    // ── 写请求: 必须带本次会话的 token, 且必须按原厂表单的方式提交 ──
    if (path.endsWith('.cgi')) {
      const name = path.replace(/\.cgi$/, '');
      const type = String(req.headers['content-type'] ?? '');
      const submit = req.method === 'GET' ? 'get'
        : type.startsWith('multipart/form-data') ? 'multipart'
          : type.startsWith('application/x-www-form-urlencoded') && chunks.length ? 'form' : 'xhr';
      const query = [...url.searchParams].filter(([k]) => k !== 'token');
      const fields = parseBody(req, chunks);
      const token = url.searchParams.get('token') ?? fields.find(([k]) => k === 'token')?.[1];
      // fields 统一记"提交上来的字段" (GET 在查询串里, POST 在请求体里), 测试按名字取值就行
      const record = { method: req.method, path, submit, query, fields: [...query, ...fields.filter(([k]) => k !== 'token')] };
      this.writes.push(record);
      if (this.writes.length > 200) this.writes.shift();
      this.log(`[write] ${req.method} /${path}`, record.fields.map((x) => `${x[0]}=${Buffer.isBuffer(x[1]) ? `<文件 ${x[1].length} 字节>` : x[1]}`).join(' '), '|', type.split(';')[0] || '-');
      if (SUBMIT[name] !== submit) {
        this.log(`        ↳ 提交方式不对 (这个接口要 ${SUBMIT[name] ?? '?'}, 收到的是 ${submit}), 已断开连接`);
        return req.socket.destroy();
      }
      if (token !== tid) {
        this.log('        ↳ token 不匹配, 已拒绝');
        return res.writeHead(200, HTML_HEADERS).end(TIP_ONLY('token 错误'));
      }
      const all = record.fields.map(([k, v]) => [k, Buffer.isBuffer(v) ? v : String(v)]);

      if (path === 'reboot.cgi' || path === 'reset.cgi') {
        if (path === 'reset.cgi') this.reset();
        this.sessions.clear();
        this.offlineUntil = now + REBOOT_MS;
        return req.socket.destroy();
      }
      if (path === 'config_back.cgi') {
        // 与真机一致的响应头
        const body = Buffer.from(BACKUP_MAGIC + this.#snapshot());
        this.log(`        ↳ 返回配置备份 ${body.length} 字节`);
        return res.writeHead(200, { 'Content-Type': 'application/octet-stream; name=config.cfg', 'Content-Disposition': 'attachment; filename=config.cfg', 'Content-Length': body.length, Connection: 'close', Pragma: 'no-cache' }).end(body);
      }
      if (path === 'conf_restore.cgi') {
        const file = fields.find(([k]) => k === 'configfile')?.[1];
        const error = file?.length ? this.#restore(file) : '没有收到配置文件';
        if (!error) this.offlineUntil = now + REBOOT_MS; // 真机上未验证; 按原厂页面"还原后需要等待设备重启"的说法实现
        this.log('        ↳ 还原', file ? `${file.length} 字节` : '没有文件', error ?? '成功, 设备重启');
        if (error) return res.writeHead(200, HTML_HEADERS).end(TIP_ONLY(error));
        this.sessions.clear();
        return req.socket.destroy();
      }
      // ── 固件: 原厂用 XHR 提交的几个接口 (空请求体, token 在查询串里) ──
      if (path === 'check_new_version_start.cgi') {
        this.checkStartedAt = now;
        return res.end('');
      }
      if (path === 'check_new_version.cgi') {
        if (now - this.checkStartedAt < CHECK_MS) return res.end('2'); // 2 = 检查中
        const fw = this.V('fwupgradephase0');
        if (this.opts.newFirmware) Object.assign(fw, { hasNewFirmware: '1', new_firmwareStr: '1.9.0 Build 20270101 Rel.70000', release_log: '1. 优化了端口环路检测的稳定性。\r\n2. 修复了部分情况下云管理掉线的问题。' });
        else Object.assign(fw, { hasNewFirmware: '0', new_firmwareStr: '', release_log: '' });
        return res.end('0');
      }
      if (path === 'upgradeConflict.cgi') {
        // 真机的返回 (实测), 连写错的标签名 (htm) 和重复的那一段都照抄; 解析时取 "value" 之后第一个 0/1 = 是否已有升级在进行
        const flag = this.V('fwupgradephase0').upgConflict === '1' ? 1 : 0;
        return res.writeHead(200, HTML_HEADERS).end(`<!DOCTYPE html>\n<htm>\n<div id="confFlag" value="${flag}"></div>\n</htm>\n<div id=confFlag value=${flag}>\n</div>\n`);
      }
      if (path === 'upgradeStatusCheck.cgi') {
        if (!this.upgrade || this.upgrade.done) return res.end('0'); // 0 = 完成
        if (this.upgrade.failed) return res.end('1'); // 1 = 失败
        if (now < this.upgrade.until) return res.end('3'); // 其它 = 进行中
        // 固件写完: 设备自己重启, 期间连接被断开
        this.upgrade = { done: true };
        this.sessions.clear();
        this.V('fwupgradephase0').upgConflict = '0';
        this.offlineUntil = now + REBOOT_MS;
        return req.socket.destroy();
      }
      if (path === 'httpupg.cgi' || path === 'upgrade_online.cgi') {
        const file = fields.find(([k]) => k === 'firmware')?.[1];
        const valid = path === 'upgrade_online.cgi' || (!!file?.length && file.toString('latin1').includes('FWIMG'));
        this.log('        ↳ 升级固件', file ? `${file.length} 字节` : '(在线升级)', valid ? '已开始写入' : '文件不是有效的固件');
        this.upgrade = valid ? { until: now + UPGRADE_MS } : { failed: true };
        if (valid) this.V('fwupgradephase0').upgConflict = '1';
        return res.end(valid ? '' : TIP_ONLY('固件文件不正确'));
      }

      const error = this.#apply(path, all);
      if (error) {
        this.log('        ↳ 拒绝:', error);
        return res.writeHead(200, HTML_HEADERS).end(TIP_ONLY(error));
      }
      const result = this.#resultPage(path, all);
      if (result) return res.writeHead(200, HTML_HEADERS).end(result);
      // 与真机一致 (实测): 写操作返回对应的功能页, tip 是 "操作成功"
      this.#liveOverview(now);
      this.#liveStats(now);
      return res.writeHead(200, HTML_HEADERS).end(this.page(RESULT_PAGE[name] ?? 'MainRpm', '操作成功'));
    }

    // ── 只读页面 ──
    if (path === 'PortStatisticsAllRpm.htm') {
      if (url.searchParams.get('token') !== tid) return res.end(TIP_ONLY('token 错误'));
      const p = Number(url.searchParams.get('port')) + 1;
      const secs = this.#statsSecs(now);
      const mix = (dir) => [1, 0.02, 0.3, 0, 0.001, 0, 0, 0, 0].map((k, i) => Math.floor(secs * this.#wave(p, dir, now) * 0.2 * k * (1 + i / 10)));
      return res.end(`<script>\nvar pkts_rx_info = [${mix(0).join(',')}];\nvar pkts_tx_info = [${mix(1).join(',')}];\nvar tip = "";\n</script>\n`);
    }
    const name = path.replace(/\.htm$/, '');
    if (!(name in this.vars)) {
      res.writeHead(404);
      return res.end('not found');
    }
    this.#liveOverview(now);
    this.#liveStats(now);
    return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>mock</title></head><body>\n${this.page(name)}</body></html>\n`);
  }
}

/** 起一个模拟交换机 (进程内, 主要给测试用)。await createMockSwitch({ profile: 'lab' }).listen(0) */
export function createMockSwitch(opts) {
  return new MockSwitch(opts);
}

// 作为命令行工具运行时才监听端口; 被 import 时不产生任何副作用
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`用法: node scripts/mock-switch.mjs [端口]
环境变量: MOCK_USER / MOCK_PASS (默认 admin / admin) · MOCK_VARIANT=N · MOCK_PROFILE=lab · MOCK_NEW_FIRMWARE=1`);
    process.exit(0);
  }
  const port = Number(args.find((a) => /^\d+$/.test(a)) ?? 8269);
  const mock = createMockSwitch({
    user: process.env.MOCK_USER ?? 'admin',
    password: process.env.MOCK_PASS ?? 'admin',
    variant: Number(process.env.MOCK_VARIANT ?? 0),
    profile: process.env.MOCK_PROFILE ?? '',
    newFirmware: process.env.MOCK_NEW_FIRMWARE === '1',
    log: (...a) => console.log(new Date().toLocaleTimeString('zh-CN', { hour12: false }), ...a),
  });
  mock.listen(port).then(() => {
    const { variant, profile, user, password } = mock.opts;
    mock.log(`模拟交换机已启动: ${mock.url}  (账号 ${user} / ${password}, ${Object.keys(factory).length} 个页面${variant ? `, 第 ${variant} 台` : ''}${profile ? `, 配置 ${profile}` : ''})`);
  }, (err) => {
    console.error(`模拟交换机启动失败: ${err.message}`);
    process.exit(1);
  });
}
