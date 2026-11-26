// 测试用的假适配器: 在内存里模拟若干台"设备" (每个地址一台), 不碰网络。
// 供设备管理器和 HTTP 接口的测试共用。放在 test/ 之外, 是为了避免被 node --test 当成测试文件执行。

import { defineAdapter } from '../src/core/adapter.mjs';
import { AppError, SwitchError } from '../src/core/errors.mjs';

export function makeWorld() {
  const devices = new Map(); // url → 设备状态
  const connections = [];

  const makeDevice = (url, extra = {}) => ({
    url,
    username: 'admin',
    password: 'pw',
    model: 'FAKE-8',
    online: true,
    loginPage: true,
    reads: [],
    submits: [],
    logins: 0,
    logouts: 0,
    ports: Array.from({ length: 8 }, (_, i) => ({ id: i + 1, enabled: true, speedCfg: 1, speedAct: i < 3 ? 6 : 0, rxKbps: 100 * (i + 1), txKbps: 10 * (i + 1) })),
    ...extra,
  });

  const adapter = defineAdapter({
    id: 'fake',
    vendor: 'Test',
    name: '假交换机',
    maturity: 'verified',
    reads: ['overview', 'stats', 'system', 'loop'],
    writes: ['loop.set'],
    features: ['statsDetail'],
    async probe({ url }) {
      const d = devices.get(url);
      return !!d && d.loginPage;
    },
    create({ url, credentials }) {
      const d = devices.get(url);
      const guard = async () => {
        if (!d || !d.online) throw new SwitchError('无法连接交换机 (fake)', 'OFFLINE');
        if (credentials.username !== d.username || credentials.password !== d.password) throw new SwitchError('用户名或密码错误', 'BAD_CREDENTIALS');
      };
      const conn = {
        adapter: 'fake',
        device: d,
        async read(key) {
          await guard();
          d.reads.push(key);
          if (key === 'overview') {
            return { data: { device: { model: d.model, firmware: 'fw-1.0', mac: '02:00:00:00:00:01', uptime: 100 }, cloud: { enabled: false, connected: false }, ports: d.ports }, tip: '' };
          }
          if (key === 'stats') return { data: { ports: d.ports.map((p) => ({ id: p.id, rxGood: 1, txGood: 2 })) }, tip: '' };
          if (key === 'system') return { data: { model: d.model, firmware: 'fw-1.0' }, tip: '' };
          if (key === 'loop') return { data: { enabled: false }, tip: '' };
          throw new SwitchError(`unknown key ${key}`, 'BAD_RESPONSE');
        },
        async readStats(port) {
          await guard();
          return { port, rx: [], tx: [] };
        },
        async submit(op, params) {
          await guard();
          d.submits.push([op, params]);
          return { tip: 'ok', disconnected: false, vars: {}, data: undefined };
        },
        async ping() {
          return !!d && d.online;
        },
        async identify() {
          await guard();
          d.logins += 1;
          return { model: d.model, firmware: 'fw-1.0', hardware: 'v1', mac: '02:00:00:00:00:01', ports: d.ports.length };
        },
        async logout() {
          if (d) d.logouts += 1;
        },
      };
      connections.push(conn);
      return conn;
    },
  });

  /** 一个只认得 fake 适配器的注册表。 */
  const registry = {
    get: (id) => (id === 'fake' ? adapter : (() => { throw new AppError('no', 'NOT_FOUND'); })()),
    has: (id) => id === 'fake',
    detect: (url) => adapter.probe({ url }).then((ok) => (ok ? adapter : null)),
    list: () => [adapter],
  };

  return { devices, connections, adapter, registry, makeDevice };
}
