// TP-LINK JetStream 交换机较新固件 (3.x) 的适配器 (实验性, 只读)。
//
// "较新固件"指 Web 界面是一套单页应用、通过 /data/*.json 接口与交换机通信的那一代 (例如 T1600G / T2600G 的 3.x 固件)。
// 与 tplink-rpm 适配器 (TL-SG2008D 这类用 *Rpm.htm 页面的固件) 是完全不同的两套协议。
//
// 为什么是实验性、为什么只读:
//   接口和字段名来自两个开源项目公开的逆向资料, 手头没有这类设备可以实测; 端口状态、速率、双工的取值编码
//   有几处是推测的 (见 pages.mjs)。读错了只是显示不对, 写错了却可能改坏交换机的配置 —— 所以不提供任何写操作。
//   如果你有这类设备并且愿意帮忙验证, 见 docs/adapters.md。

import { defineAdapter } from '../../core/adapter.mjs';
import { SwitchError } from '../../core/errors.mjs';
import { JsonClient, probeEndpoint } from './client.mjs';
import { overview, pvidTable, portState, stats, system, vlanTable } from './pages.mjs';

const READS = ['overview', 'ports', 'stats', 'system', 'vlan8021q', 'vlanPvid'];
const TAB_UNIT1 = { tab: 'unit1' };

const unsupported = () => new SwitchError('这台设备使用了相似的接口，但读不出型号和固件版本，可能不是受支持的交换机', 'UNSUPPORTED');

/** 不带凭据探测: 向一个只读接口发一个没有会话的请求, 看回答是不是 JSON 信封。连不上一律当"不是"。 */
async function probe({ url }) {
  try {
    return /"success"\s*:/.test(await probeEndpoint(url));
  } catch {
    return false;
  }
}

/** 带千位逗号的计数 ("1,234,567") → 数字。 */
const bytes = (v) => Number(String(v ?? 0).replace(/[,\s]/g, '')) || 0;

function create({ url, credentials, options = {} }) {
  const client = new JsonClient({ baseUrl: url, username: credentials.username, password: credentials.password, timeout: options.timeout });
  let lastBytes = null; // 端口 → { t, rx, tx }: 上一次统计时的字节计数, 用来算速率
  let rates = null; // 端口 → { rx, tx }: 最近一次算出的速率 (Kbps), 概览直接用它, 不用再逐个端口查询

  const summary = () => client.call('systemSummaryConfig', 'read', TAB_UNIT1);
  const portRows = async () => {
    const data = await client.call('port', 'load', { special: 'display', ...TAB_UNIT1 });
    if (!Array.isArray(data)) throw new SwitchError('端口列表的格式不对', 'BAD_RESPONSE');
    return data;
  };
  const vlanRows = () => client.call('vlanCfg', 'load', {});

  const connection = {
    adapter: 'tplink-json',
    client,

    async read(key) {
      switch (key) {
        case 'overview':
          return { data: overview({ summary: await summary(), portRows: await portRows(), rates }), tip: '' };
        case 'system':
          return { data: system(await summary()), tip: '' };
        case 'ports': {
          const ports = (await portRows()).map(portState).filter(Boolean).sort((a, b) => a.id - b.id);
          return { data: { maxPorts: ports.length, support2_5G: false, ports }, tip: '' };
        }
        case 'stats': {
          // 每个端口要单独查一次, 所以逐个来 (连接本身也是串行的), 并顺手用前后两次的字节差算出速率
          const samples = [];
          for (const row of await portRows()) samples.push({ row, data: await client.call('trafficMonitorCfgDetailModel', 'read', { port: row.port }) });
          const result = stats(samples, lastBytes);
          lastBytes = new Map(samples.map(({ row, data }) => [portState(row)?.id, { t: Date.now(), rx: bytes(data?.bytesRx), tx: bytes(data?.bytesTx) }]).filter(([id]) => id));
          rates = result.rates;
          return { data: result.data, tip: '' };
        }
        case 'vlan8021q':
          return { data: vlanTable(await vlanRows(), (await portRows()).length), tip: '' };
        case 'vlanPvid': {
          const [count, vlans, pvidRows] = [(await portRows()).length, await vlanRows(), await client.call('vlanPortCfg', 'load', TAB_UNIT1)];
          return { data: pvidTable({ pvidRows, vlanRows: vlans, portCount: count }), tip: '' };
        }
        default:
          throw new SwitchError(`这个适配器不支持读取「${String(key).slice(0, 40)}」`, 'UNSUPPORTED');
      }
    },

    async ping() {
      await client.call('version', 'read', {});
      return true;
    },

    /** 登录后读出型号 / 固件 / 端口数。读不出型号和固件版本的, 多半是界面相似的其它设备。 */
    async identify() {
      let info;
      let ports;
      try {
        [info, ports] = [await summary(), await portRows()];
      } catch (err) {
        if (err instanceof SwitchError && err.code === 'BAD_RESPONSE') throw unsupported();
        throw err;
      }
      const s = system(info);
      if (!s.model || !s.firmware || !ports.length) throw unsupported();
      return { model: s.model, firmware: s.firmware, hardware: s.hardware, mac: s.mac, ports: ports.map(portState).filter(Boolean).length, description: s.description };
    },

    logout: () => client.logout(),
  };
  return connection;
}

export const jsonAdapter = defineAdapter({
  id: 'tplink-json',
  vendor: 'TP-LINK',
  name: 'TP-LINK JetStream 新版 Web 界面',
  maturity: 'experimental',
  reads: READS,
  writes: [], // 只读 (原因见文件头)
  features: [],
  probe,
  create,
});
