#!/usr/bin/env node
// 模拟一台使用 TP-LINK 较新固件 (JSON 接口) 的 JetStream 交换机, 给实验性的 tplink-json 适配器做开发和测试。
// 接口和字段名与适配器依据的公开资料一致 (见 src/adapters/tplink-json/); 数据是一台虚构的 24 口交换机。
//
//   node scripts/mock-json-switch.mjs [端口]        默认 8280
//   MOCK_USER / MOCK_PASS                           登录账号, 默认 admin / admin
//
// 也可以在测试里 import { createMockJsonSwitch } 起一个进程内的实例。

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PORTS = 24;
const range = (n) => Array.from({ length: n }, (_, i) => i + 1);
const name = (p) => `1/0/${p}`;

/** 每个口的链路: 1-2 上联千兆, 3 一百兆, 8 没插线且被禁用, 其余千兆。 */
const LINK = (p) => (p === 8 ? { state: 0, speedLink: 0, linkStatus: 0 } : { speedLink: p === 3 ? 2 : 3, linkStatus: 1 });
const TRAFFIC = (p) => (p === 1 ? [960, 310] : p === 2 ? [140, 1710] : p === 3 ? [18, 4] : [0, 0]); // [收, 发] KB/s

export class MockJsonSwitch {
  constructor({ user = 'admin', password = 'admin', log = () => {} } = {}) {
    this.user = user;
    this.password = password;
    this.log = log;
    this.startedAt = Date.now();
    this.sessions = new Map(); // _tid_ → usrLvl
    this.requests = []; // { endpoint, body, tid } (不含登录)
    this.logins = { ok: 0, failed: 0 };
    this.vlans = [
      { vlanid: 1, name: 'default', member1: range(PORTS).filter((p) => !(p >= 3 && p <= 12) && p < 23).map(name).join(','), member2: '', key: 1 },
      { vlanid: 20, name: 'office', member1: `${name(3)}-${name(12)}`, member2: name(1), key: 20 },
      { vlanid: 30, name: 'servers', member1: `${name(23)},${name(24)}`, member2: name(1), key: 30 },
    ];

    this.server = createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('error', () => {});
      req.on('end', () => this.#handle(req, res, Buffer.concat(chunks).toString('utf8')).catch((err) => {
        this.log('[mock-json] 处理请求出错:', err.message);
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

  /** 让所有会话失效 (模拟设备重启或会话超时)。 */
  expireSessions() {
    this.sessions.clear();
  }

  async #handle(req, res, body) {
    const url = new URL(req.url, 'http://mock');
    const endpoint = /^\/data\/([A-Za-z0-9_]+)\.json$/.exec(url.pathname)?.[1];
    const reply = (payload) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload));
    if (!endpoint) {
      res.writeHead(404);
      return res.end('not found');
    }
    let parsed = {};
    try {
      parsed = body ? JSON.parse(body) : {};
    } catch {
      return reply({ success: false, errorcode: -1, data: null });
    }

    if (endpoint === 'login') {
      if (parsed.username === this.user && parsed.password === this.password) {
        const tid = randomBytes(12).toString('hex');
        this.sessions.set(tid, 15);
        this.logins.ok += 1;
        return reply({ success: true, data: { _tid_: tid, usrLvl: 15, pwdNeedChange: 0 } });
      }
      this.logins.failed += 1;
      return reply({ success: false, errorcode: 1, data: null });
    }

    const tid = url.searchParams.get('_tid_');
    if (!tid || !this.sessions.has(tid)) return reply({ success: false, errorcode: -401, data: null }); // 没有会话 (探测时看到的就是这个)
    if (endpoint === 'logout') {
      this.sessions.delete(tid);
      return reply({ success: true, data: null });
    }
    this.requests.push({ endpoint, body: parsed, tid });

    const secs = (Date.now() - this.startedAt) / 1000;
    switch (endpoint) {
      case 'version':
        return reply({ success: true, data: { fw_version: '3.0.3 Build 20260110 Rel.70001', hw_version: 'V1' } });
      case 'systemSummaryConfig':
        return reply({
          success: true,
          data: {
            dev_name: 'TL-MOCK-24',
            sys_description: 'JetStream 24-Port Gigabit Smart Switch (模拟)',
            mac_address: '02:00:5E:02:00:01',
            fw_version: '3.0.3 Build 20260110 Rel.70001',
            hw_version: 'V1',
            run_time: '4d3h12m30s',
            sys_time: '2026-11-26 10:00:00',
            se_number: 'MOCK000001',
            temperature: 42,
            fan_speed: '20%',
          },
        });
      case 'port':
        return reply({
          success: true,
          data: range(PORTS).map((p) => ({ port: name(p), ...LINK(p), state: p === 8 ? 0 : 1, speedCfg: 0, duplexCfg: 1, duplexLink: 1, flowControl: 0, mediaType: 1, type: 1, lag: p >= 23 ? '1' : '' })),
        });
      case 'trafficMonitorCfgDetailModel': {
        const p = Number(/(\d+)$/.exec(String(parsed.port ?? ''))?.[1]);
        if (!p || p < 1 || p > PORTS) return reply({ success: false, errorcode: -1, data: null });
        const [rx, tx] = TRAFFIC(p);
        const num = (k) => Math.floor(k).toLocaleString('en-US');
        const rxB = rx * 1000 * secs;
        const txB = tx * 1000 * secs;
        return reply({
          success: true,
          data: { pktsRx: num(rxB / 700), bytesRx: num(rxB), errorsRx: '12', pktsTx: num(txB / 700), bytesTx: num(txB), errorsTx: '3', unicastRx: num(rxB / 800), broadcastRx: '0' },
        });
      }
      case 'vlanCfg':
        return reply({ success: true, data: this.vlans });
      case 'vlanPortCfg':
        return reply({
          success: true,
          data: range(PORTS).map((p) => ({ key: name(p), pvid: p >= 23 ? 30 : p >= 3 && p <= 12 ? 20 : 1, lag: p >= 23 ? '1' : '', ingress_check: 1, frame_type: 3 })),
        });
      case 'vlanPortDetailCfg': {
        const p = Number(/(\d+)$/.exec(String(parsed.port ?? ''))?.[1]);
        const vid = p >= 23 ? 30 : p >= 3 && p <= 12 ? 20 : 1;
        const vlan = this.vlans.find((v) => v.vlanid === vid);
        return reply({ success: true, data: vlan ? [{ key: p, name: vlan.name, vlanId: vid }] : [] });
      }
      default:
        // 只读的模拟器: 写接口一律拒绝 (真实设备上这些接口会改动配置)
        return reply({ success: false, errorcode: -1, data: null });
    }
  }
}

export function createMockJsonSwitch(opts) {
  return new MockJsonSwitch(opts);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const port = Number(args.find((a) => /^\d+$/.test(a)) ?? 8280);
  createMockJsonSwitch({ user: process.env.MOCK_USER ?? 'admin', password: process.env.MOCK_PASS ?? 'admin' })
    .listen(port)
    .then(
      (mock) => console.log(`新版固件 (JSON 接口) 模拟交换机已启动: ${mock.url}  (账号 ${mock.user} / ${mock.password})`),
      (err) => {
        console.error(`启动失败: ${err.message}`);
        process.exit(1);
      },
    );
}
