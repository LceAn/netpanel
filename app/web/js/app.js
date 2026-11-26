// 应用外壳: 启动、首次初始化、登录、路由、侧边栏 (设备列表 + 当前设备的功能页)、顶栏。

import { h, icon, kids, toast, toastError, confirmDialog } from './dom.js';
import { api } from './api.js';
import { button, emptyState, errorState, field, input, loading } from './ui.js';
import { GLOBAL_VIEWS, VIEWS, hashOf, navFor, pageAvailable, parseHash, renderView } from './views.js';
import { applyOp, waitReboot } from './views/shared.js';

const app = document.getElementById('app');
const THEME_KEY = 'netpanel.theme';
const APP_NAME = 'NetPanel';
const DEVICE_POLL_MS = 5000;

const state = { status: null, user: null, devices: [], device: null, page: null, pageParams: {} };
let seq = 0; // 每次切页面 +1; 旧页面迟到的异步结果据此丢弃
let current = { controller: null };
let deviceTimer = null;
const shell = {}; // 外壳里需要随时更新的节点
const closeNav = () => app.querySelector('.app')?.classList.remove('nav-open');

const healthKind = (d) => (d.enabled === false ? 'disabled' : d.health || 'unknown');
const hostOf = (url) => String(url ?? '').replace(/^https?:\/\//, '');

// ── 主题 ─────────────────────────────────────────────────────────────

function applyTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  document.documentElement.dataset.theme = saved ?? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem(THEME_KEY, next);
  themeBtn.replaceChildren(icon(next === 'dark' ? 'sun' : 'moon'));
}

const themeBtn = h('button', { class: 'btn ghost icon', type: 'button', title: '切换深色 / 浅色主题', 'aria-label': '切换主题', onclick: toggleTheme }, icon('sun'));

// ── 导航 ─────────────────────────────────────────────────────────────

/**
 * 跳转。target 是全局页面 (dashboard / devices / deviceForm / settings / device) 时按 params 跳;
 * 否则当作"当前这台设备的某个功能页" (deviceId 省略时用当前设备)。
 */
function navigate(target, params = {}, deviceId = state.device?.id) {
  const global = {
    dashboard: '#/',
    devices: '#/devices',
    settings: '#/settings',
    deviceForm: params.deviceId ? `#/devices/${encodeURIComponent(params.deviceId)}/edit` : '#/devices/new',
    device: `#/d/${encodeURIComponent(params.deviceId ?? deviceId)}/overview`,
  };
  location.hash = global[target] ?? hashOf(target, deviceId, params);
}

// ── 外壳 ─────────────────────────────────────────────────────────────

function setOverview(data) {
  if (!shell.cloud || !data) return;
  shell.cloud.replaceChildren(...kids([
    !data.cloud?.enabled ? null : data.cloud.connected ? h('span', { class: 'badge ok' }, h('i', { class: 'dot' }), '云管理已连接') : h('span', { class: 'badge warn' }, h('i', { class: 'dot' }), '云管理未连接'),
  ]));
}

function paintDevices() {
  if (!shell.devList) return;
  const items = state.devices.map((d) => h('a', { href: `#/d/${d.id}/overview`, class: `dev-item is-${healthKind(d)}${state.device?.id === d.id ? ' active' : ''}`, onclick: closeNav },
    h('i', { class: 'dot' }), h('span', { class: 'dev-name' }, d.name), h('span', { class: 'dev-model' }, d.model ?? hostOf(d.url))));
  shell.devList.replaceChildren(...(items.length ? items : [h('div', { class: 'dev-empty' }, '还没有绑定设备。', h('a', { href: '#/devices/new' }, '添加一台'))]));
  shell.devCount.textContent = state.devices.length ? String(state.devices.length) : '';
}

function paintDeviceNav(device) {
  shell.deviceNav.replaceChildren(...kids((device ? navFor(device.capabilities) : []).map((group) => h('div', { class: 'nav-group' },
    group.label ? h('div', { class: 'nav-label' }, group.label) : null,
    group.items.map(([id, label, ic]) => h('a', { href: hashOf(id, device.id), dataset: { page: id }, onclick: closeNav }, icon(ic, 17), label))))));
}

function paintSwitcher() {
  if (!shell.switcher) return;
  shell.switcher.replaceChildren(...state.devices.map((d) => h('option', { value: d.id, selected: d.id === state.device?.id }, d.name)));
  shell.switcher.hidden = !state.device || state.devices.length < 2;
}

function paintFootDevice() {
  const d = state.device;
  shell.footDevice.replaceChildren(...kids([
    d ? h('a', { class: 'btn ghost sm', href: `${d.url}/`, target: '_blank', rel: 'noopener noreferrer', title: '打开这台设备自己的管理页面' }, icon('external', 15), `原厂页面 ${hostOf(d.url)}`) : null,
  ]));
}

function buildShell() {
  const view = h('main', { class: 'main', id: 'view' }, loading(6));
  Object.assign(shell, { devList: h('div', { class: 'dev-list' }), deviceNav: h('div', { class: 'device-nav' }), devCount: h('span', { class: 'nav-count' }), footDevice: h('div') });
  shell.title = h('span', { class: 'topbar-title' });
  shell.switcher = h('select', { class: 'select switcher', 'aria-label': '切换设备', onchange: (e) => (location.hash = hashOf(state.page ?? 'overview', e.target.value, state.pageParams)) });
  shell.cloud = h('span', { class: 'row topbar-cloud' });

  const nav = h('nav', { class: 'nav' },
    h('a', { href: '#/', dataset: { view: 'dashboard' }, onclick: closeNav }, icon('grid', 17), '全部设备'),
    h('a', { href: '#/devices', dataset: { view: 'devices' }, onclick: closeNav }, icon('cable', 17), '设备管理', shell.devCount),
    h('div', { class: 'nav-label' }, '已绑定的设备'),
    shell.devList,
    shell.deviceNav);

  app.replaceChildren(h('div', { class: 'app' },
    h('aside', { class: 'sidebar' },
      h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }, icon('jack', 20)), h('span', null, APP_NAME)),
      nav,
      h('div', { class: 'sidebar-foot' },
        shell.footDevice,
        h('a', { class: 'btn ghost sm', href: '#/settings', dataset: { view: 'settings' }, onclick: closeNav }, icon('settings', 15), '面板设置'),
        h('div', { class: 'row' }, h('span', { class: 'muted small', title: '当前登录的面板账号' }, state.user ?? ''), h('span', { class: 'spacer' }),
          button('退出', { icon: 'logout', variant: 'ghost', size: 'sm', onClick: logout })))),
    h('div', { class: 'backdrop', onclick: closeNav }),
    h('header', { class: 'topbar' },
      h('button', { class: 'btn ghost icon menu-toggle', type: 'button', 'aria-label': '菜单', onclick: () => app.querySelector('.app').classList.toggle('nav-open') }, icon('menu')),
      shell.title, shell.switcher, h('span', { class: 'spacer' }), shell.cloud,
      button('', { icon: 'refresh', title: '刷新', onClick: () => route() }),
      themeBtn,
      button('退出', { icon: 'logout', variant: 'ghost', onClick: logout })),
    view));
  shell.links = [...app.querySelectorAll('.nav > a[data-view]')];
  paintDevices();
}

/** 读取设备列表 (给侧边栏的状态点、顶栏的切换器用), 顺便刷新当前设备的健康状态。 */
async function loadDevices() {
  state.devices = await api.devices.list();
  paintDevices();
  paintSwitcher();
}

function refreshDeviceList() {
  return api.devices.list()
    .then((devices) => {
      state.devices = devices;
      paintDevices();
      paintSwitcher();
    })
    .catch(() => {}); // 列表刷新失败不打扰用户, 下一轮再试
}

/** 侧边栏的状态点靠定时刷新设备列表来保持最新。标签页在后台时不刷新, 切回前台时立即刷一次。 */
function startDevicePolling() {
  clearInterval(deviceTimer);
  document.removeEventListener('visibilitychange', onDeviceVisible);
  deviceTimer = setInterval(() => {
    if (!document.hidden) refreshDeviceList();
  }, DEVICE_POLL_MS);
  document.addEventListener('visibilitychange', onDeviceVisible);
}

const onDeviceVisible = () => {
  if (!document.hidden) refreshDeviceList();
};

// ── 页面上下文 ───────────────────────────────────────────────────────

function makeCtx(controller, device = null) {
  const onAbort = (fn) => controller.signal.addEventListener('abort', fn, { once: true });
  /** 周期执行 fn。首次立即执行 (不管页面是否可见); 页面在后台时把频率降到 1/10; 切回前台立即执行一次。 */
  const timer = (fn, ms) => {
    let busy = false;
    let lastRun = -Infinity;
    const tick = async () => {
      if (busy) return; // 上一次还没跑完 → 跳过, 避免请求堆积
      // 后台标签页的定时器本身会被浏览器节流, 所以按"距上次执行的时间"判断, 而不是数触发次数
      if (document.hidden && Date.now() - lastRun < ms * 10) return;
      lastRun = Date.now();
      busy = true;
      try {
        await fn();
      } catch (err) {
        toastError(err);
      } finally {
        busy = false;
      }
    };
    const onVisible = () => {
      if (!document.hidden) void tick();
    };
    const id = setInterval(tick, ms);
    document.addEventListener('visibilitychange', onVisible);
    onAbort(() => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    });
    void tick();
  };

  const base = {
    user: state.user,
    api,
    poll: (fn, ms) => timer(fn, ms),
    every: (fn, ms) => timer(fn, ms),
    navigate,
    reload: () => route(),
    /** 重新读设备列表: 添加 / 修改 / 删除设备之后调用, 侧边栏和顶栏的切换器立刻就是新的。 */
    refreshDevices: () => refreshDeviceList(),
    confirm: (spec) => confirmDialog({ danger: true, ...spec }),
    toast,
    toastError,
    /** 调用任意接口, 出错只弹提示并返回 null。 */
    call: async (fn) => {
      try {
        return await fn();
      } catch (err) {
        toastError(err);
        return null;
      }
    },
  };
  if (!device) return base;

  const capabilities = device.capabilities ?? {};
  const ctx = {
    ...base,
    device,
    api: api.device(device.id),
    switchUrl: device.url,
    /** 这台设备的适配器能不能做某件事。页面据此决定显示哪些控件 (而不是等提交后才报错)。 */
    can: (op) => (capabilities.writes ?? []).includes(op),
    has: (feature) => (capabilities.features ?? []).includes(feature),
    /** 只读适配器: 任何写操作都不支持, 页面只能查看。 */
    readOnly: !(capabilities.writes ?? []).length,
    apply: (op, params, opts) => applyOp(ctx, op, params, opts),
    waitReboot: (opts) => waitReboot(ctx, opts),
    setOverview,
    reconnect: async () => route(),
    /** 修改这台设备在面板里的记录 (例如交换机密码改了之后同步更新)。 */
    updateDevice: (patch) => api.devices.update(device.id, patch),
  };
  return ctx;
}

// ── 路由 ─────────────────────────────────────────────────────────────

async function route() {
  const target = parseHash(location.hash);
  current.controller?.abort();
  current = { controller: new AbortController() };
  const mine = ++seq;
  closeNav();
  const view = document.getElementById('view');
  if (!view) return; // 还没登录, 没有外壳
  shell.title.textContent = target.title;
  for (const a of shell.links) a.classList.toggle('active', a.dataset.view === target.view);
  view.replaceChildren(loading(6));
  try {
    let node;
    if (target.view === 'device') {
      state.device = await loadDevice(target.deviceId);
      state.page = target.page;
      state.pageParams = target.params;
      paintDevices();
      paintDeviceNav(state.device);
      paintSwitcher();
      paintFootDevice();
      for (const a of app.querySelectorAll('.device-nav a')) a.classList.toggle('active', a.dataset.page === target.page);
      if (!state.device) node = errorState(new Error('设备不存在，可能已经被删除。'), () => navigate('devices'));
      else if (!pageAvailable(target.page, state.device.capabilities)) node = emptyState(`这台设备不支持「${target.title}」。`);
      else node = await renderView(VIEWS[target.page], makeCtx(current.controller, state.device), target.params);
      if (mine !== seq) return;
      view.replaceChildren(...deviceBanners(state.device), node);
    } else {
      state.device = null;
      state.page = null;
      paintDevices();
      paintDeviceNav(null);
      paintSwitcher();
      paintFootDevice();
      shell.cloud.replaceChildren();
      // 设备表单要知道是哪台设备 (地址里的 #/devices/<id>/edit), 所以把 deviceId 也作为参数传入
      node = await renderView(GLOBAL_VIEWS[target.view], makeCtx(current.controller), target.deviceId ? { ...target.params, deviceId: target.deviceId } : target.params);
      if (mine !== seq) return;
      view.replaceChildren(node);
    }
    window.scrollTo(0, 0);
    document.title = `${target.title}${state.device ? ` · ${state.device.name}` : ''} · ${APP_NAME}`;
  } catch (err) {
    if (mine !== seq) return;
    view.replaceChildren(errorState(err, () => route()));
  }
}

/** 取一台设备的最新描述; 已被删除时返回 null。 */
async function loadDevice(id) {
  try {
    return await api.devices.get(id);
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/** 当前设备的提示横幅: 适配器是实验性的、设备离线或凭据失效。 */
function deviceBanners(d) {
  if (!d) return [];
  const out = [];
  if (d.adapterMaturity === 'experimental') {
    const readOnly = !(d.capabilities?.writes ?? []).length;
    out.push(h('div', { class: 'banner warn' }, icon('alert'), h('div', null, readOnly
      ? `这台设备用的是「${d.adapterName}」实验性适配器：按公开资料实现，还没有在真机上验证过，显示的数据可能有误。它是只读的——页面只能查看，不能修改交换机。`
      : `这台设备用的是「${d.adapterName}」实验性适配器：按公开资料实现，还没有在真机上验证过，读到的数据和下发的配置都可能不对。`)));
  }
  const kind = healthKind(d);
  if (kind === 'offline') out.push(h('div', { class: 'banner danger' }, icon('alert'), h('div', null, `这台设备当前离线${d.lastOk ? `（最后在线 ${new Date(d.lastOk).toLocaleTimeString('zh-CN', { hour12: false })}）` : ''}，下面的页面可能加载失败。`, ' ', h('a', { href: '#/', onclick: closeNav }, '查看所有设备'))));
  if (kind === 'auth') out.push(h('div', { class: 'banner danger' }, icon('alert'), h('div', null, '面板保存的账号密码已被设备拒绝（可能是交换机上的密码改过了）。', ' ', h('a', { href: `#/devices/${d.id}/edit`, onclick: closeNav }, '更新设备密码'))));
  return out;
}

// ── 登录 / 初始化 / 退出 ──────────────────────────────────────────────

async function logout() {
  try {
    await api.logout();
  } catch {
    // 会话可能早已过期
  }
  clearInterval(deviceTimer);
  if (state.status) state.status.authed = false;
  state.devices = [];
  state.device = null;
  showLogin();
}

/** 登录卡片: 初始化向导和普通登录共用外观。 */
function authCard({ title, subtitle, fields, submitLabel, onSubmit, extra }) {
  app.replaceChildren();
  const err = h('div', { class: 'banner danger', hidden: true, role: 'alert' });
  const submit = h('button', { class: 'btn primary', type: 'submit', style: { width: '100%' } }, submitLabel);
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      submit.classList.add('is-busy');
      submit.disabled = true;
      err.hidden = true;
      try {
        await onSubmit();
      } catch (e2) {
        err.hidden = false;
        err.replaceChildren(icon('alert'), e2.message);
        submit.classList.remove('is-busy');
        submit.disabled = false;
      }
    },
  }, ...fields.map(([label, control, hint]) => field(label, control, hint)), err, submit);
  app.append(h('div', { class: 'login-wrap' },
    h('div', { class: 'login' },
      h('span', { class: 'brand-mark' }, icon('jack', 26)),
      h('h1', null, title),
      h('div', { class: 'sub' }, subtitle),
      extra ?? null,
      form)));
  fields[0][1].focus();
}

function showLogin(message) {
  const user = input({ autocomplete: 'username', required: true, maxlength: 64, 'aria-label': '面板账号' });
  const pass = input({ type: 'password', autocomplete: 'current-password', required: true, 'aria-label': '面板密码' });
  authCard({
    title: APP_NAME,
    subtitle: message ?? '登录面板',
    fields: [['面板账号', user], ['面板密码', pass]],
    submitLabel: '登录',
    onSubmit: async () => {
      await api.login({ username: user.value.trim(), password: pass.value });
      await enter();
    },
  });
  document.title = `登录 · ${APP_NAME}`;
}

function showSetup() {
  const user = input({ autocomplete: 'username', required: true, maxlength: 64, value: 'admin', 'aria-label': '面板账号' });
  const pass = input({ type: 'password', autocomplete: 'new-password', required: true, minlength: 8, maxlength: 128, 'aria-label': '面板密码' });
  const confirm = input({ type: 'password', autocomplete: 'new-password', required: true, minlength: 8, maxlength: 128, 'aria-label': '确认面板密码' });
  authCard({
    title: '欢迎使用 NetPanel',
    subtitle: '第一次使用，先给面板创建一个管理员账号。',
    fields: [['面板账号', user, '1-64 个英文字母、数字或英文符号'], ['面板密码', pass, '至少 8 个字符'], ['确认面板密码', confirm]],
    submitLabel: '创建并进入面板',
    extra: h('div', { class: 'banner info' }, icon('info'), h('div', null, '这是面板自己的账号，和交换机的管理账号是两回事。各台交换机的账号密码会在添加设备时填写，加密保存在面板的数据目录里。')),
    onSubmit: async () => {
      if (pass.value !== confirm.value) throw new Error('两次输入的密码不一致');
      await api.setup({ username: user.value.trim(), password: pass.value });
      await enter();
    },
  });
  document.title = `初始化 · ${APP_NAME}`;
}

async function enter() {
  state.status = await api.status();
  state.user = state.status.user;
  buildShell();
  await loadDevices();
  startDevicePolling();
  await route();
}

function fatal(err) {
  app.replaceChildren(h('div', { class: 'login-wrap' }, h('div', { class: 'login' },
    h('h1', null, '连不上面板服务'),
    h('div', { class: 'sub' }, err.message),
    button('重试', { variant: 'primary', icon: 'refresh', onClick: boot }))));
}

// ── 启动 ─────────────────────────────────────────────────────────────

async function boot() {
  applyTheme();
  try {
    state.status = await api.status();
  } catch (err) {
    return fatal(err);
  }
  window.addEventListener('hashchange', () => state.status?.authed && route());
  window.addEventListener('panel-unauthorized', () => {
    if (!state.status?.authed) return;
    state.status.authed = false;
    clearInterval(deviceTimer);
    state.devices = [];
    showLogin('登录已过期，请重新登录');
  });
  if (state.status.setupRequired) showSetup();
  else if (state.status.authed) await enter();
  else showLogin();
}

boot();
