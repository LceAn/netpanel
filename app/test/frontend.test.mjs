// 前端模块的静态检查: 每个模块都能加载 (导入路径、导出名、语法都对), 页面引用的操作名 / 页面名都真实存在。
// 界面的实际行为要靠浏览器验证; 这里保证的是"改了后端或某个页面之后, 别的页面不会一打开就因为引用了不存在的东西而报错"。

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { OPS } from '../src/core/ops.mjs';
import { MODELS } from '../src/core/models.mjs';
import { WEB_DIR } from '../src/http/server.mjs';

const JS_DIR = join(WEB_DIR, 'js');
const filesOf = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesOf(join(dir, e.name)) : e.name.endsWith('.js') ? [join(dir, e.name)] : []));
const modules = filesOf(JS_DIR);
const source = Object.fromEntries(modules.map((file) => [file, readFileSync(file, 'utf8')]));

/** 模块加载阶段会用到的浏览器对象: 给一个"什么都能当"的替身, 只求 import 不抛错。 */
function stubBrowser() {
  const any = new Proxy(function stub() {}, {
    get: (_, key) => (typeof key === 'symbol' ? (key === Symbol.toPrimitive ? () => '' : undefined) : key === 'then' ? undefined : any),
    apply: () => any,
    construct: () => any,
    has: () => true,
  });
  // Node 24 自带只读的 navigator / window 等全局对象, 所以用 defineProperty 覆盖
  for (const [key, value] of Object.entries({ document: any, window: any, localStorage: any, sessionStorage: any, location: any, history: any, navigator: any, matchMedia: any, CSS: any, Node: class {}, Event: class {}, MutationObserver: class {}, requestAnimationFrame: () => 0 })) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
}

test('前端的每个模块都能加载', async () => {
  assert.ok(modules.length >= 12, `只找到 ${modules.length} 个模块`);
  stubBrowser();
  const rejections = [];
  const onRejection = (err) => rejections.push(err);
  process.on('unhandledRejection', onRejection);
  try {
    for (const file of modules) await import(pathToFileURL(file).href);
  } finally {
    process.off('unhandledRejection', onRejection);
  }
  // app.js 被加载时会自己启动并向接口发请求; 这里没有真实的环境, 那些失败是预期内的, 所以只保证"加载本身"不抛错
  assert.ok(rejections.length < 50);
});

test('页面引用的写操作都存在于规范操作表', () => {
  const used = new Set();
  for (const text of Object.values(source)) for (const m of text.matchAll(/\b(?:apply|op|can)\(\s*'([a-z]+(?:\.[a-z]+)+)'\s*/g)) used.add(m[1]);
  assert.ok(used.size >= 30, `只找到 ${used.size} 个操作名`);
  const unknown = [...used].filter((name) => !Object.hasOwn(OPS, name));
  assert.deepEqual(unknown, [], '页面里引用了不存在的操作名');
});

test('页面引用的模型键都存在于规范模型表', async () => {
  stubBrowser();
  const used = new Set(['overview', 'stats']);
  for (const text of Object.values(source)) {
    for (const m of text.matchAll(/\bkeys:\s*\[([^\]]*)\]/g)) for (const k of m[1].matchAll(/'([A-Za-z0-9]+)'/g)) used.add(k[1]);
    for (const m of text.matchAll(/\bctx\.api\.(?:pages|overview)\(\s*'([A-Za-z0-9]+)'/g)) used.add(m[1]);
  }
  const unknown = [...used].filter((key) => !Object.hasOwn(MODELS, key));
  assert.deepEqual(unknown, [], '页面里引用了不存在的模型键');
});

test('路由表: 每个页面都有 id 和 render; 导航里的页面都在路由表里; 地址与解析互为逆运算', async () => {
  stubBrowser();
  const views = await import(pathToFileURL(join(JS_DIR, 'views.js')).href);
  for (const [id, page] of Object.entries(views.VIEWS)) {
    assert.equal(page.id, id, `${id} 的 id 与路由表里的键不一致`);
    assert.equal(typeof page.render, 'function', `${id} 缺少 render`);
    assert.ok(views.TITLES[id], `${id} 在导航里没有标题`);
  }
  for (const [id, view] of Object.entries(views.GLOBAL_VIEWS)) assert.ok(typeof view === 'function' || typeof view.render === 'function', `${id} 既不是函数也没有 render`);
  for (const { items } of views.NAV) for (const [id] of items) assert.ok(views.VIEWS[id], `导航里的 ${id} 不在路由表里`);

  const id = 'd_0123456789';
  for (const page of ['overview', 'system.tools', 'vlan.8021q', 'ports.stats']) {
    const hash = views.hashOf(page, id, { port: 3 });
    assert.equal(hash.startsWith(`#/d/${id}/`), true, hash);
    assert.equal(views.parseHash(hash).page, page);
  }
  assert.deepEqual(views.parseHash('#/'), { view: 'dashboard', title: '全部设备', params: {} });
  assert.equal(views.parseHash('#/devices/new').view, 'deviceForm');
  assert.equal(views.parseHash(`#/devices/${id}/edit`).deviceId, id);
  assert.equal(views.parseHash(`#/d/${id}/no-such-page`).page, 'overview', '不认识的页面回到概览');
});

test('页面按适配器的能力显示: 只读适配器看不到需要写操作的页面, 也不显示它读不了的模型', async () => {
  stubBrowser();
  const { pageAvailable } = await import(pathToFileURL(join(JS_DIR, 'views.js')).href);
  const rpm = { reads: ['overview', 'ports', 'stats', 'system', 'vlan8021q'], writes: ['port.quick', 'port.settings'], features: [] };
  assert.equal(pageAvailable('overview', rpm), true);
  assert.equal(pageAvailable('ports', rpm), true);
  assert.equal(pageAvailable('vlan.8021q', rpm), true);
  assert.equal(pageAvailable('vlan.pvid', rpm), false, '读得到 PVID 表但不支持修改时不显示 (可写的适配器要求能改)');
  assert.equal(pageAvailable('system.tools', rpm), false, '没有保存 / 重启等能力时不显示系统工具');
  assert.equal(pageAvailable('sw.mac', rpm), false);
  const readOnly = { reads: ['overview', 'ports', 'stats', 'system', 'vlan8021q', 'vlanPvid'], writes: [], features: [] };
  assert.equal(pageAvailable('overview', readOnly), true);
  assert.equal(pageAvailable('ports.config', readOnly), true, '端口配置页对只读适配器可看不可改');
  assert.equal(pageAvailable('vlan.pvid', readOnly), true, 'PVID 页同理');
  assert.equal(pageAvailable('system.tools', readOnly), false, '纯操作页对只读适配器没有意义');
  assert.equal(pageAvailable('sw.mac', readOnly), false);
  assert.equal(pageAvailable('system.firmware', readOnly), false, '读不了固件信息的设备没有固件页');
  const nav = (await import(pathToFileURL(join(JS_DIR, 'views.js')).href)).navFor(readOnly).flatMap((g) => g.items.map(([id]) => id));
  assert.deepEqual(nav, ['overview', 'system.info', 'ports.config', 'ports.stats', 'vlan.8021q', 'vlan.pvid']);
});
