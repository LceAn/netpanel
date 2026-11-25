// 用抓下来的原厂页面做夹具, 验证读取模型把原始变量归一化成了正确的语义结构。
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseVars, scripts } from '../lib/jslite.mjs';
import { PAGES, STATS_DETAIL, uptimeSeconds } from '../lib/pages.mjs';

const FIXTURES = fileURLToPath(new URL('../../_stock/pages/', import.meta.url));
const KEY_BY_FILE = Object.fromEntries(Object.entries(PAGES).map(([key, page]) => [basename(page.path).replace('.', '_') + '.txt', key]));

// 只有表单、没有可读数据的页面 (保存配置 / 重启 / 复位 / 备份还原)
const WRITE_ONLY = new Set(['ConfigRpm_htm.txt', 'SavingConfigRpm_htm.txt', 'SystemRebootRpm_htm.txt', 'SystemResetRpm_htm.txt']);

function load(key) {
  const page = PAGES[key];
  const file = basename(page.path).replace('.', '_') + '.txt';
  return page.model(parseVars(scripts(readFileSync(join(FIXTURES, file), 'utf8'))[0]));
}

test('夹具里的每个页面都能在注册表中找到', () => {
  const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.txt') && !WRITE_ONLY.has(f));
  const orphan = files.filter((f) => !(f in KEY_BY_FILE));
  assert.deepEqual(orphan, [], '有页面没登记到 PAGES');
});

test('首页: 设备信息 / 端口实时状态 / 云状态', () => {
  const m = load('overview');
  assert.equal(m.maxPorts, 8);
  assert.equal(m.device.model, 'TL-SG2008D');
  assert.equal(m.device.ip, '10.0.0.239');
  assert.equal(m.device.dhcp, true);
  assert.equal(m.device.uptime, 965852);
  assert.deepEqual(m.cloud, { enabled: true, connected: true });
  assert.equal(m.ports.length, 8);
  // spd_act:[6,6,0,6,0,5,...] → 1/2/4 口千兆, 6 口 100M 全双工, 其余断开
  assert.deepEqual(m.ports.map((p) => p.speedAct), [6, 6, 0, 6, 0, 5, 0, 0]);
  assert.deepEqual(m.ports[5], { id: 6, enabled: true, speedCfg: 1, speedAct: 5, flowCfg: 0, flowAct: 0, lag: 0, vlans: [1], loop: 'off', rxKbps: 0, txKbps: 0 });
  assert.deepEqual(m.ports[3].rxKbps, 764);
  assert.equal(m.flags.showVlan, true);
});

test('端口配置 / 端口统计', () => {
  const cfg = load('ports');
  assert.equal(cfg.ports.length, 8);
  assert.equal(cfg.ports[1].speedAct, 6);
  assert.equal(cfg.ports[7].lag, 0);

  const stats = load('stats');
  assert.deepEqual(stats.ports[0], { id: 1, enabled: true, link: 6, txGood: 434760804, txBad: 0, rxGood: 243533493, rxBad: 2 });
  assert.equal(stats.ports[4].rxGood, 31863047);
});

test('单端口统计明细', () => {
  const html = `var pkts_rx_info = [228851567,3582009,11313841,0,0,2];var pkts_tx_info = [1,2,3,4,5,6];`;
  const m = STATS_DETAIL.model(parseVars(html), 1);
  assert.equal(m.rx[0], 228851567);
  assert.equal(m.rx[5], 2);
  assert.equal(m.tx[5], 6);
  assert.equal(m.rx.length, 20);
});

test('系统 / IP / 账户 / 云管理', () => {
  const sys = load('system');
  assert.equal(sys.model, 'TL-SG2008D');
  assert.equal(sys.hardware, '3.0');
  assert.equal(sys.firmware, '1.8.1 Build 20260401 Rel.61276');
  assert.equal(sys.mac, '80:AE:54:E7:6E:24');
  assert.equal(sys.cloudManaged, true);

  const ip = load('ip');
  assert.equal(ip.dhcp, true);
  assert.equal(ip.manageVlan, 1);
  assert.equal(ip.vlanEditable, true);
  assert.equal(ip.dns, '10.0.0.1');

  assert.equal(load('fixIp').enabled, true);
  assert.equal(load('user').username, 'lcean');
  const cloud = load('cloud');
  assert.deepEqual(cloud, { enabled: true, type: 'cloud', nms: { server: '', port: 60445 }, boundId: null });
});

test('二层交换 / 监控', () => {
  const lag = load('lag');
  assert.equal(lag.maxLag, 2);
  assert.deepEqual(lag.ranges, { 1: [1, 4], 2: [5, 8] });
  assert.deepEqual(lag.groups, [{ id: 1, members: [] }, { id: 2, members: [] }]);

  const iso = load('isolation');
  assert.equal(iso.rules.length, 8);
  assert.equal(iso.rules[0].forward, '1-8');

  assert.equal(load('mirror').enabled, false);
  assert.equal(load('loop').enabled, false);
  const cable = load('cable');
  assert.equal(cable.results.length, 8);
  assert.deepEqual(cable.results[0], { id: 1, state: -1, length: -1, enabled: true });
});

test('VLAN / QoS / 固件', () => {
  const q = load('vlan8021q');
  assert.equal(q.enabled, true);
  assert.deepEqual(q.vlans, [{ id: 1, name: 'Default', tagged: [], untagged: [1, 2, 3, 4, 5, 6, 7, 8] }]);

  const pvid = load('vlanPvid');
  assert.equal(pvid.enabled, true);
  assert.deepEqual(pvid.ports.map((p) => p.pvid), [1, 1, 1, 1, 1, 1, 1, 1]);

  assert.equal(load('vlanMtu').enabled, false);
  assert.equal(load('vlanPort').enabled, false);

  const qos = load('qosBasic');
  assert.equal(qos.mode, 0);
  assert.deepEqual(qos.ports.map((p) => p.priority), [1, 1, 1, 1, 1, 1, 1, 1]);
  assert.equal(load('qosBandwidth').ports[0].ingress, 0);
  assert.deepEqual(load('qosStorm').ports[2].types, []);

  const fw = load('firmware');
  assert.equal(fw.firmware, '1.8.1 Build 20260401 Rel.61276');
  assert.equal(fw.onlineUpgrade, true);
});

test('uptimeSeconds 解析原厂格式', () => {
  assert.equal(uptimeSeconds('11 day - 4 hour - 17 min - 32 sec'), 965852);
  assert.equal(uptimeSeconds('0 day - 0 hour - 0 min - 1 sec'), 1);
  assert.equal(uptimeSeconds(undefined), null);
});
