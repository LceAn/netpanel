#!/usr/bin/env node
// 模拟交换机: 用抓下来的原厂页面 (../_stock/pages) 充当设备, 用来在不碰真机的情况下
// 开发和验证面板 —— 包括所有写操作流程。
//
//   node test/mock-switch.mjs [端口]        默认 8269
//   然后另开一个终端:  SWITCH_URL=http://127.0.0.1:8269 node server.mjs
//
// 登录账号固定为 admin / admin。每个写请求都会打印到控制台 (方法、路径、字段),
// 可以据此核对面板发给交换机的内容是否与原厂表单一致。

import { createServer } from 'node:http';
import { randomInt } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { securityEncode } from '../lib/switch.mjs';

const PORT = Number(process.argv[2] ?? 8269);
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '_stock', 'pages');
const USER = process.env.MOCK_USER ?? 'admin';
const PASS = process.env.MOCK_PASS ?? 'admin';

// 页面名 (不含 .htm) → 页面内容 (内存里, 写操作会改动其中一部分)
const pages = {};
for (const file of readdirSync(FIXTURES).filter((f) => f.endsWith('_htm.txt'))) {
  pages[file.replace(/_htm\.txt$/, '')] = readFileSync(join(FIXTURES, file), 'utf8');
}
const uptimeAt = { text: pages.MainRpm.match(/workTime:\["([^"]*)"\]/)?.[1] ?? '0 day - 0 hour - 0 min - 0 sec', at: Date.now() };

const LOGIN_PAGE = '<script>\nvar logonInfo = new Array(\n{code},\n0,0);\n</script>\n';
const sessions = new Map(); // SessionID → tid
let offlineUntil = 0;

const frame = (tid) => `<!DOCTYPE html>\n<script>\nvar g_Lan=0,g_level=1,g_year=2026,g_title='TL-SG2008D',g_product=2,g_tid=${tid};\nvar menuNoMng = 0;\nvar g_hasNewFirmware=0;\n</script>\n`;

function parseBody(req, chunks) {
  const type = String(req.headers['content-type'] ?? '');
  const body = Buffer.concat(chunks);
  const fields = [];
  if (type.startsWith('application/x-www-form-urlencoded')) {
    for (const [k, v] of new URLSearchParams(body.toString('utf8'))) fields.push([k, v]);
  } else if (type.startsWith('multipart/form-data')) {
    const boundary = /boundary=(.+)$/.exec(type)?.[1];
    for (const part of body.toString('latin1').split(`--${boundary}`).slice(1, -1)) {
      const [head, ...rest] = part.split('\r\n\r\n');
      const name = /name="([^"]*)"/.exec(head)?.[1];
      const isFile = /filename=/.test(head);
      fields.push([name, isFile ? `<file ${Buffer.byteLength(rest.join(''))} bytes>` : rest.join('').replace(/\r\n$/, '')]);
    }
  }
  return fields;
}

const setIndexed = (page, key, index, value) => {
  pages[page] = pages[page].replace(new RegExp(`${key}:\\[([^\\]]*)\\]`), (m, inner) => {
    const items = inner.split(',');
    items[index] = String(value);
    return `${key}:[${items.join(',')}]`;
  });
};

/** 按原厂语义改动夹具里的数据, 让界面在"应用"后能看到变化。 */
function mutate(path, query, fields) {
  const all = [...query, ...fields];
  const many = (name) => all.filter(([k]) => k === name).map(([, v]) => v);
  const one = (name) => all.find(([k]) => k === name)?.[1];
  if (path === 'port_setting.cgi') {
    for (const p of many('portid').map(Number)) {
      if (one('state') !== '7') setIndexed('PortSettingRpm', 'state', p - 1, one('state'));
      if (one('speed') !== '8') setIndexed('PortSettingRpm', 'spd_cfg', p - 1, one('speed'));
      if (one('flowcontrol') !== '7') setIndexed('PortSettingRpm', 'fc_cfg', p - 1, one('flowcontrol'));
    }
  } else if (path === 'main_info_port_status_set.cgi') {
    for (const [k, v] of all) {
      const m = /^port_sel_(\d+)$/.exec(k);
      if (!m) continue;
      setIndexed('PortSettingRpm', 'spd_cfg', Number(m[1]) - 1, v);
      setIndexed('PortSettingRpm', 'state', Number(m[1]) - 1, v === '0' ? 0 : 1);
    }
  } else if (path === 'loop_prevention_set.cgi') {
    pages.LoopPreventionRpm = pages.LoopPreventionRpm.replace(/var lpEn=\d;/, `var lpEn=${one('lpEn')};`);
  } else if (path === 'qos_mode_set.cgi') {
    pages.QosBasicRpm = pages.QosBasicRpm.replace(/var qosMode = \d;/, `var qosMode = ${one('rd_qosmode')};`);
  } else if (path === 'reboot.cgi' || path === 'reset.cgi') {
    sessions.clear();
    offlineUntil = Date.now() + 8000; // 模拟重启: 8 秒不响应
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://mock');
  const path = url.pathname.replace(/^\//, '');
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    if (Date.now() < offlineUntil) return req.socket.destroy(); // "重启中": 直接断开
    if (path === 'index.html') return req.socket.destroy(); // 真机登录后访问 index.html 就是空回复
    const sid = /SessionID=(\w+)/.exec(req.headers.cookie ?? '')?.[1];
    const tid = sessions.get(sid);

    if (path === 'logon.cgi') {
      const fields = parseBody(req, chunks);
      const get = (k) => fields.find(([n]) => n === k)?.[1];
      if (get('username') === USER && get('password') === securityEncode(PASS)) {
        const id = randomInt(1e9, 2e9).toString(36);
        const token = String(randomInt(1e8, 2e9));
        sessions.set(id, token);
        return res.writeHead(200, { 'Set-Cookie': `SessionID=${id};HttpOnly; Path=/` }).end(LOGIN_PAGE.replace('{code}', '0'));
      }
      console.log('[login] 拒绝:', get('username'));
      return res.end(LOGIN_PAGE.replace('{code}', '1'));
    }

    if (!tid || path === 'Logout.htm') {
      if (path === 'Logout.htm' && sid) sessions.delete(sid);
      return res.end(LOGIN_PAGE.replace('{code}', '5'));
    }

    if (path === '') return res.end(frame(tid));

    // ── 写请求: 必须带本次会话的 token ──
    if (path.endsWith('.cgi')) {
      const query = [...url.searchParams];
      const fields = parseBody(req, chunks);
      const token = query.find(([k]) => k === 'token')?.[1] ?? fields.find(([k]) => k === 'token')?.[1];
      console.log(`[write] ${req.method} /${path}`, query.filter(([k]) => k !== 'token').map((x) => x.join('=')).join(' '), '|', req.headers['content-type']?.split(';')[0] ?? '-', '|', fields.map((x) => x.join('=')).join(' '));
      if (token !== tid) {
        console.log('        ↳ token 不匹配, 已拒绝');
        return res.end(`<script>\nvar tip = "token 错误";\n</script>\n`);
      }
      mutate(path, query, fields);
      if (path === 'reboot.cgi' || path === 'reset.cgi') return req.socket.destroy();
      // 与推测的真机行为一致: 写操作返回对应页面, 并带上 tip 提示
      return res.end((pages.MainRpm ?? '').replace('var tip = "";', 'var tip = "设置成功";'));
    }

    if (path === 'PortStatisticsAllRpm.htm') {
      if (url.searchParams.get('token') !== tid) return res.end('<script>\nvar tip = "token 错误";\n</script>\n');
      const p = Number(url.searchParams.get('port')) + 1;
      const now = Math.floor(Date.now() / 1000);
      return res.end(`<script>\nvar pkts_rx_info = [${[1, 2, 3, 0, 0, 0, 0, 0, 0].map((k) => k * now * p).join(',')}];\nvar pkts_tx_info = [${[4, 0, 1, 0, 0, 1, 0, 0, 0].map((k) => k * now * p).join(',')}];\nvar tip = "";\n</script>\n`);
    }

    const name = basename(path, '.htm');
    if (!(name in pages)) {
      res.writeHead(404);
      return res.end('not found');
    }
    let body = pages[name];
    if (name === 'MainRpm') {
      // 让运行时间走起来, 检查前端计时
      const m = /(\d+) day - (\d+) hour - (\d+) min - (\d+) sec/.exec(uptimeAt.text);
      const secs = m ? (((Number(m[1]) * 24 + Number(m[2])) * 60 + Number(m[3])) * 60 + Number(m[4])) + Math.floor((Date.now() - uptimeAt.at) / 1000) : 0;
      const d = Math.floor(secs / 86400);
      const hh = Math.floor((secs % 86400) / 3600);
      const mm = Math.floor((secs % 3600) / 60);
      body = body.replace(/workTime:\["[^"]*"\]/, `workTime:["${d} day - ${hh} hour - ${mm} min - ${secs % 60} sec"]`);
      body = body.replace(/rx_rate:\[[^\]]*\]/, `rx_rate:[${Array.from({ length: 10 }, (_, i) => (i < 4 ? Math.round(200 + 180 * Math.sin(Date.now() / 3000 + i)) : 0)).join(',')}]`);
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`模拟交换机已启动: http://127.0.0.1:${PORT}  (账号 ${USER} / ${PASS}, ${Object.keys(pages).length} 个页面夹具)`);
});
