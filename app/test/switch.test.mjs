// 用本地 HTTP 服务冒充交换机, 录下客户端真正发出的请求 (请求行 / 请求头 / 请求体),
// 验证编码方式、token、相对路径、会话失效重登、断连重试这些只有"真收发"才能测到的行为。
// 不接触任何真实设备。

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { RpmClient as SwitchClient, securityEncode } from '../src/adapters/tplink-rpm/client.mjs';
import { SwitchError } from '../src/core/errors.mjs';

const LOGIN_OK = '<script>\nvar logonInfo = new Array(\n0,\n0,0);\n</script>\n';
const LOGIN_PAGE = '<script>\nvar logonInfo = new Array(\n5,\n0,0);\n</script>\n';

/** 起一个冒牌交换机。handler 可以改写默认行为。 */
async function fakeSwitch(handler) {
  const log = [];
  let tid = '111111';
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      log.push({ method: req.method, url: req.url, type: req.headers['content-type'] ?? '', body, cookie: req.headers.cookie ?? '' });
      if (handler?.(req, res, body, log)) return;
      if (req.url === '/logon.cgi') {
        const n = log.filter((x) => x.url === '/logon.cgi').length;
        res.writeHead(200, { 'Set-Cookie': `SessionID=s${n};HttpOnly; Path=/` });
        return res.end(LOGIN_OK);
      }
      if (req.url === '/') return res.end(`<!DOCTYPE html><script>var g_tid=${tid};\nvar g_title='X';</script>`);
      if (req.url === '/LoopPreventionRpm.htm') return res.end('<script>var lpEn=0;\nvar tip = "";\n</script>');
      res.end('<script>var tip = "设置成功";\n</script>');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    log,
    setTid: (v) => (tid = v),
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

const ctxLoop = { enabled: false };
const ctxPorts = { maxPorts: 8, support2_5G: false };
const ctxQ = { enabled: true, portCount: 8, maxVlans: 32, vlans: [{ id: 1, name: 'Default', tagged: [], untagged: [1, 2, 3, 4, 5, 6, 7, 8] }] };

test('登录: 密码按固件方式编码, 之后每个请求都带 SessionID', async () => {
  const sw = await fakeSwitch();
  try {
    const client = new SwitchClient({ baseUrl: sw.url, username: 'u', password: 'admin' });
    await client.login();
    assert.equal(sw.log[0].method, 'POST');
    assert.equal(sw.log[0].url, '/logon.cgi');
    assert.match(sw.log[0].type, /^application\/x-www-form-urlencoded/);
    const form = new URLSearchParams(sw.log[0].body.toString());
    assert.equal(form.get('username'), 'u');
    assert.equal(form.get('password'), securityEncode('admin'));
    assert.deepEqual(await client.read('loop'), { data: { enabled: false }, tip: '' });
    assert.match(sw.log[1].cookie, /SessionID=s1/);
  } finally {
    await sw.close();
  }
});

test('登录失败如实报告交换机的错误码', async () => {
  const sw = await fakeSwitch((req, res) => {
    if (req.url === '/logon.cgi') {
      res.end(LOGIN_PAGE.replace('5', '1'));
      return true;
    }
    return false;
  });
  try {
    await assert.rejects(new SwitchClient({ baseUrl: sw.url, username: 'u', password: 'x' }).login(), (err) => err.code === 'BAD_CREDENTIALS' && /用户名或密码错误/.test(err.message));
  } finally {
    await sw.close();
  }
});

test('multipart 写操作: 相对路径补成站内路径, 多值字段重复出现, token 取自会话', async () => {
  const sw = await fakeSwitch();
  try {
    sw.setTid('987654321');
    const client = new SwitchClient({ baseUrl: sw.url, username: 'u', password: 'p' });
    const res = await client.submit('port.settings', { ports: [3, 1], state: 1, speed: 6, flow: 7 }, ctxPorts);
    assert.equal(res.tip, '设置成功');
    const tidReq = sw.log.find((x) => x.url === '/');
    assert.ok(tidReq, '写之前应先取 token');
    const write = sw.log.at(-1);
    assert.equal(write.method, 'POST');
    assert.equal(write.url, '/port_setting.cgi'); // 原厂表单写的是相对路径 port_setting.cgi
    assert.match(write.type, /^multipart\/form-data; boundary=----SwitchPanel/);
    const body = write.body.toString();
    assert.match(body, /name="portid"\r\n\r\n3\r\n/);
    assert.match(body, /name="portid"\r\n\r\n1\r\n/);
    assert.match(body, /name="state"\r\n\r\n1\r\n/);
    assert.match(body, /name="speed"\r\n\r\n6\r\n/);
    assert.match(body, /name="flowcontrol"\r\n\r\n7\r\n/);
    assert.match(body, /name="apply"\r\n\r\n应用\r\n/);
    assert.match(body, /name="token"\r\n\r\n987654321\r\n/);
  } finally {
    await sw.close();
  }
});

test('urlencoded 写操作: 中文按 UTF-8 百分号编码, 每个端口一个 selType_N', async () => {
  const sw = await fakeSwitch();
  try {
    const client = new SwitchClient({ baseUrl: sw.url, username: 'u', password: 'p' });
    await client.submit('vlan.q.set', { vid: 10, name: '办公', tagged: [1], untagged: [2, 3] }, ctxQ);
    const write = sw.log.at(-1);
    assert.equal(write.url, '/qvlanSet.cgi');
    assert.equal(write.type, 'application/x-www-form-urlencoded');
    assert.equal(write.body.toString(), 'vid=10&vname=%E5%8A%9E%E5%85%AC&selType_1=1&selType_2=0&selType_3=0&selType_4=2&selType_5=2&selType_6=2&selType_7=2&selType_8=2&qvlan_add=%E6%B7%BB%E5%8A%A0%2F%E7%BC%96%E8%BE%91&token=111111');
  } finally {
    await sw.close();
  }
});

test('GET 写操作: 参数在查询串里, 端口列表转成位掩码', async () => {
  const sw = await fakeSwitch();
  try {
    const client = new SwitchClient({ baseUrl: sw.url, username: 'u', password: 'p' });
    await client.submit('vlan.pvid.set', { pvid: 20, ports: [1, 3, 8] }, { enabled: true, portCount: 8 });
    assert.equal(sw.log.at(-1).method, 'GET');
    assert.equal(sw.log.at(-1).url, '/vlanPvidSet.cgi?pbm=133&pvid=20&token=111111');
    await client.submit('port.quick', { port: 5, speed: 0 }, { maxPorts: 8, support2_5G: false });
    assert.equal(sw.log.at(-1).url, '/main_info_port_status_set.cgi?port_sel_5=0&token=111111');
  } finally {
    await sw.close();
  }
});

test('账户修改: 三个密码字段都是编码后的值', async () => {
  const sw = await fakeSwitch();
  try {
    const limits = { userMin: 1, userMax: 31, pwdMin: 5, pwdMax: 31 };
    await new SwitchClient({ baseUrl: sw.url, username: 'u', password: 'p' }).submit('user.account', { username: 'alice', oldPassword: 'old-pass-1', newPassword: 'NewPass123!', confirmPassword: 'NewPass123!', confirm: true }, { limits });
    const body = sw.log.at(-1).body.toString();
    const part = (name) => new RegExp(`name="${name}"\\r\\n\\r\\n${securityEncode(name === 'txt_oldpwd' ? 'old-pass-1' : 'NewPass123!')}\\r\\n`);
    for (const name of ['txt_oldpwd', 'txt_userpwd', 'txt_confirmpwd']) assert.match(body, part(name), name);
    assert.doesNotMatch(body, /old-pass-1|NewPass123!/, '明文密码不能出现在请求里');
  } finally {
    await sw.close();
  }
});

test('会话失效: 交换机返回登录页 → 自动重新登录并重放, 写操作只生效一次', async () => {
  let expired = true; // 第一次数据请求时会话"已过期"
  const sw = await fakeSwitch((req, res) => {
    if (req.url === '/logon.cgi') return false;
    if (expired) {
      expired = false;
      res.end(LOGIN_PAGE);
      return true;
    }
    return false;
  });
  try {
    const client = new SwitchClient({ baseUrl: sw.url, username: 'u', password: 'p' });
    await client.login();
    const res = await client.submit('loop.set', { enabled: true }, ctxLoop);
    assert.equal(res.tip, '设置成功');
    // 第一次拿 token 时会话已失效 → 重登 → 重放
    assert.equal(sw.log.filter((x) => x.url === '/logon.cgi').length, 2);
    assert.equal(sw.log.filter((x) => x.url === '/loop_prevention_set.cgi').length, 1);
    assert.equal(sw.log.at(-1).cookie, 'SessionID=s2'); // 用的是新会话
  } finally {
    await sw.close();
  }
});

test('读请求遇到断连会自动重试; 写请求断连不重发并明确报"结果未知"', async () => {
  let drop = { '/LoopPreventionRpm.htm': 1, '/loop_prevention_set.cgi': 1 };
  const sw = await fakeSwitch((req, res) => {
    if ((drop[req.url] ?? 0) > 0) {
      drop[req.url]--;
      req.socket.destroy(); // 嵌入式 web 的典型表现: 什么都不回直接断开
      return true;
    }
    return false;
  });
  try {
    const client = new SwitchClient({ baseUrl: sw.url, username: 'u', password: 'p' });
    assert.deepEqual(await client.read('loop'), { data: { enabled: false }, tip: '' });
    assert.equal(sw.log.filter((x) => x.url === '/LoopPreventionRpm.htm').length, 2);
    await assert.rejects(client.submit('loop.set', { enabled: true }, ctxLoop), (err) => err.code === 'UNCERTAIN');
    assert.equal(sw.log.filter((x) => x.url === '/loop_prevention_set.cgi').length, 1, '写操作不能自动重发');
  } finally {
    await sw.close();
  }
});

test('重启类操作: 交换机直接断开视为已提交', async () => {
  const sw = await fakeSwitch((req) => {
    if (!req.url.startsWith('/reboot.cgi')) return false;
    req.socket.destroy(); // 重启时交换机来不及回应就断开
    return true;
  });
  try {
    const res = await new SwitchClient({ baseUrl: sw.url, username: 'u', password: 'p' }).submit('system.reboot', { save: true, confirm: true });
    assert.equal(res.disconnected, true);
  } finally {
    await sw.close();
  }
});

test('非法参数在客户端这层就被拒绝, 不会发出请求', async () => {
  const sw = await fakeSwitch();
  try {
    const client = new SwitchClient({ baseUrl: sw.url, username: 'u', password: 'p' });
    await assert.rejects(client.submit('port.settings', { ports: [99], state: 1, speed: 6, flow: 7 }, ctxPorts), (err) => err.code === 'BAD_PARAM');
    await assert.rejects(client.submit('system.reset', {}), (err) => err.code === 'BAD_PARAM' && /RESET/.test(err.message));
    assert.equal(sw.log.length, 0);
  } finally {
    await sw.close();
  }
});

test('页面是 GBK 时按 GBK 解码', async () => {
  const gbk = Buffer.from('c9e8d6c3b3c9b9a6', 'hex'); // "设置成功" 的 GBK 编码
  const sw = await fakeSwitch((req, res) => {
    if (req.url !== '/LoopPreventionRpm.htm') return false;
    res.end(Buffer.concat([Buffer.from('<script>var lpEn=1;\nvar tip = "'), gbk, Buffer.from('";\n</script>')]));
    return true;
  });
  try {
    assert.deepEqual(await new SwitchClient({ baseUrl: sw.url, username: 'u', password: 'p' }).read('loop'), { data: { enabled: true }, tip: '设置成功' });
  } finally {
    await sw.close();
  }
});

test('写操作返回页里的数据会带回调用方 (MAC 搜索、线缆检测的结果就在返回的页面里)', async () => {
  const sw = await fakeSwitch((req, res) => {
    if (req.url !== '/mac_address_search.cgi') return false;
    // 原厂 MAC 搜索的返回页: 结果就写在页首的变量里
    res.end(`<script>
var mac_ds = {
is_qvlan:1,
macNum:1,
mac_info:[
{mac:"AA:BB:CC:DD:EE:FF", vid:20, port:3}
]
};var tip="";
</script>`);
    return true;
  });
  try {
    const res = await new SwitchClient({ baseUrl: sw.url, username: 'u', password: 'p' }).submit('mac.search', { mac: 'aa:bb:cc:dd:ee:ff', vid: '' });
    assert.equal(res.disconnected, false);
    assert.equal(res.tip, '');
    assert.equal(res.vars.mac_ds.macNum, 1);
    assert.equal(res.vars.mac_ds.mac_info[0].mac, 'AA:BB:CC:DD:EE:FF');
    assert.equal(res.vars.mac_ds.mac_info[0].port, 3);
    // 适配器负责把返回页里的变量整理成规范模型
    assert.deepEqual(res.data, { qvlan: true, results: [{ mac: 'AA:BB:CC:DD:EE:FF', vid: 20, port: 3 }] });
  } finally {
    await sw.close();
  }
});

test('连接不上交换机 → OFFLINE; 地址只接受 http', async () => {
  const sw = await fakeSwitch();
  const url = sw.url;
  await sw.close();
  const err = await new SwitchClient({ baseUrl: url, username: 'u', password: 'p', maxRetries: 1 }).login().catch((e) => e);
  assert.equal(err.code, 'OFFLINE');
  assert.throws(() => new SwitchClient({ baseUrl: 'https://192.168.50.20', username: 'u', password: 'p' }), /http/);
});
